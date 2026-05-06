import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuditLogger } from '@app/common/audit/audit-logger.service';
import { AuthRepository } from './auth.repository';
import { LoginDto, RegisterDto } from './dto';
import { TokenService } from './token.service';
import { AccountStatus } from '@prisma/client';
import { SessionService } from './session.service';
import { AUTH_CONSTANTS } from './auth.constants';

@Injectable()
export class AuthService {
  constructor(
    private readonly authRepository: AuthRepository,
    private readonly tokenService: TokenService,
    private readonly sessionService: SessionService,
    private readonly audit: AuditLogger,
  ) {}

  /**
   * Pre-computed hash for "dummy_password" to mitigate timing attacks.
   *
   * IMPORTANT: argon2id parameters (m=65536, t=3, p=4) MUST stay in sync with
   * the parameters used in register() and changePassword(). A mismatch causes
   * verify() to run at a different cost than a real hash lookup, reintroducing
   * a timing delta. Parameters are sourced from AUTH_CONSTANTS to enforce this.
   *
   * To regenerate:
   *   node -e "require('argon2').hash('dummy_password',
   *     { type: require('argon2').argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 })
   *     .then(console.log)"
   */
  private static readonly DUMMY_HASH =
    '$argon2id$v=19$m=65536,t=3,p=4$hlbOyIMZD2kSF2Zg2S12AQ$pZ32MvUaWfL9Qh3c87DX/lOFpPjzeT00a1fYJGAhWl8';

  // ── Registration ───────────────────────────────────────────────────────────

  async register(dto: RegisterDto, userAgent?: string) {
    const hashed = await argon2.hash(
      dto.password,
      AUTH_CONSTANTS.ARGON2_OPTIONS,
    );

    const user = await this.authRepository.createUserWithWallet({
      name: dto.name,
      email: dto.email,
      phone: dto.phone.trim(),
      password: hashed,
    });

    const tokens = await this.tokenService.generateTokenPair(
      user.id,
      user.email,
      user.role,
    );

    await this.sessionService.persistRefreshToken(
      user.id,
      tokens.refreshToken,
      userAgent,
    );

    void this.audit.log('USER_REGISTERED', { userId: user.id, userAgent });
    return tokens;
  }

  // ── Login ──────────────────────────────────────────────────────────────────

  async login(dto: LoginDto, userAgent?: string) {
    const email = this.normalizeEmail(dto.email);
    const user = await this.authRepository.findByEmail(email);

    const passwordMatch = await argon2.verify(
      user?.password ?? AuthService.DUMMY_HASH,
      dto.password,
    );

    if (!user || !passwordMatch)
      throw new UnauthorizedException('Invalid credentials');

    if (user.status !== AccountStatus.ACTIVE) {
      void this.audit.warn('LOGIN_BLOCKED_ACCOUNT', { userId: user.id });
      throw new UnauthorizedException(
        'Account is not active. Please contact support.',
      );
    }

    const tokens = await this.tokenService.generateTokenPair(
      user.id,
      user.email,
      user.role,
    );

    await this.sessionService.persistRefreshToken(
      user.id,
      tokens.refreshToken,
      userAgent,
    );

    void this.audit.log('USER_LOGIN', { userId: user.id, userAgent });
    return tokens;
  }

  // ── Token refresh ──────────────────────────────────────────────────────────

  async refresh(rawRefreshToken: string, userAgent?: string) {
    const hash = this.tokenService.hashToken(rawRefreshToken);
    const session = await this.sessionService.findTokenWithGrace(hash);

    if (session.status === 'NOT_FOUND')
      throw new UnauthorizedException('Invalid token.');

    if (session.status === 'EXPIRED')
      throw new UnauthorizedException('Invalid token.');

    if (session.status === 'REUSE_DETECTED') {
      await this.sessionService.revokeAllTokens(session.token.userId);
      await this.sessionService.clearRotationCache(hash);
      void this.audit.warn('TOKEN_REUSE_DETECTED', {
        userId: session.token.userId,
        userAgent,
      });
      throw new UnauthorizedException(
        'Security breach detected. Please log in again.',
      );
    }

    if (session.status === 'GRACE_PERIOD') {
      const cached = await this.sessionService.getRotationCache(hash);
      if (cached) {
        void this.audit.log('GRACE_PERIOD_REPLAYED', {
          userId: session.token.userId,
          userAgent,
        });
        return cached;
      }

      await this.sessionService.clearRotationCache(hash);
      void this.audit.warn('GRACE_PERIOD_CACHE_MISS', {
        userId: session.token.userId,
        userAgent,
      });
      throw new UnauthorizedException('Invalid token.');
    }

    const user = await this.authRepository.findById(session.token.userId);
    if (!user) throw new UnauthorizedException();

    if (user.status !== AccountStatus.ACTIVE) {
      void this.audit.warn('LOGIN_BLOCKED_ACCOUNT', { userId: user.id });
      throw new UnauthorizedException(
        'Account is not active. Please contact support.',
      );
    }

    const tokens = await this.tokenService.generateTokenPair(
      user.id,
      user.email,
      user.role,
    );

    const newHash = this.tokenService.hashToken(tokens.refreshToken);
    const expiresAt = this.tokenService.getRefreshExpiry();

    await this.sessionService.rotateToken(
      hash,
      { userId: user.id, tokenHash: newHash, expiresAt },
      tokens,
    );

    void this.audit.log('TOKEN_REFRESHED', { userId: user.id, userAgent });
    return tokens;
  }

  // ── Logout ─────────────────────────────────────────────────────────────────

  async logout(
    rawRefreshToken: string,
    userId: string,
    jti: string,
    userAgent?: string,
  ) {
    const hash = this.tokenService.hashToken(rawRefreshToken);
    const result = await this.sessionService.findTokenWithGrace(hash);

    if (result.status === 'NOT_FOUND') return;

    if (result.status === 'REUSE_DETECTED') {
      await this.sessionService.revokeAllTokens(result.token.userId);
      void this.audit.error('TOKEN_REUSE_DETECTED', {
        userId: result.token.userId,
        userAgent,
      });
      return;
    }

    if (result.token.userId !== userId) {
      void this.audit.warn('LOGOUT_IDENTITY_MISMATCH', { userId });
      throw new UnauthorizedException('Identity Mismatch');
    }

    await this.sessionService.clearRotationCache(hash);
    await this.sessionService.revokeAccessToken(jti);

    if (result.status === 'ACTIVE') {
      await this.sessionService.revokeToken(hash);
    }

    void this.audit.log('LOGOUT', { userId });
  }

  /**
   * Revokes every active refresh token for this user AND denylists the
   * caller's current access token.
   *
   * Without denylisting the JTI, the access token that authorized this request
   * remains valid until its natural expiry — leaving a window where a
   * compromised token could still be used despite "logging out everywhere."
   */
  async logoutAll(userId: string, jti: string, userAgent?: string) {
    await this.sessionService.revokeAllTokens(userId);
    await this.sessionService.revokeAccessToken(jti);
    void this.audit.log('LOGOUT_ALL', { userId, userAgent });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private normalizeEmail(email: string): string {
    return email.toLowerCase().trim();
  }
}
