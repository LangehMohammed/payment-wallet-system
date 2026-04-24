import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import type { StringValue } from 'ms';
import { JwtPayload } from './interfaces/jwt-payload.interface';
import { AUTH_CONSTANTS } from './auth.constants';

@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    this.resolveHashSecret(); // throws if absent or too short
    this.parseExpiry(this.configService.get<string>('jwt.accessExpiry'));
    this.parseExpiry(this.configService.get<string>('jwt.refreshExpiry'));
  }

  // ── Hashing ────────────────────────────────────────────────────────────────

  hashToken(token: string): string {
    const secret = this.resolveHashSecret();
    return crypto.createHmac('sha256', secret).update(token).digest('hex');
  }

  /**
   * Resolves and validates TOKEN_HASH_SECRET.
   * Throws at call time so misconfiguration surfaces immediately — both
   * during onModuleInit (startup) and as a safety net on direct calls.
   */
  private resolveHashSecret(): string {
    const secret = this.configService.get<string>('token.hashSecret');
    if (!secret || secret.length < 32) {
      throw new Error(
        'TOKEN_HASH_SECRET is missing or too short (minimum 32 characters). ' +
          'Set it via environment variable.',
      );
    }
    return secret;
  }

  // ── Generation ─────────────────────────────────────────────────────────────

  // Generates a secure random refresh token
  generateRefreshToken(): string {
    return crypto
      .randomBytes(AUTH_CONSTANTS.REFRESH_TOKEN_BYTES)
      .toString('hex');
  }

  /**
   * Generates a JWT access token with the provided user details.
   * - The token includes standard claims (sub, email, role) and a unique jti for revocation tracking.
   * - The token is signed with a secret and has an expiration time defined in the configuration.
   */
  async generateAccessToken(
    userId: string,
    email: string,
    role: string,
  ): Promise<string> {
    const payload: JwtPayload = {
      sub: userId,
      email,
      role: role as JwtPayload['role'],
      jti: crypto.randomUUID(),
    };
    return this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('jwt.accessSecret'),
      expiresIn: this.configService.get<string>(
        'jwt.accessExpiry',
      ) as unknown as StringValue,
    });
  }

  /**
   * Generates a pair of access and refresh tokens for the given user details.
   * - The access token is a JWT containing user information and a unique identifier (jti).
   * - The refresh token is a secure random string used for obtaining new access tokens.
   */
  async generateTokenPair(userId: string, email: string, role: string) {
    const accessToken = await this.generateAccessToken(userId, email, role);
    const refreshToken = this.generateRefreshToken();
    return { accessToken, refreshToken };
  }

  // ── Expiry ─────────────────────────────────────────────────────────────────

  /**
   * Calculates the expiration date for a refresh token based on the configured expiry duration.
   * - The expiry duration is defined in the configuration (e.g., "7d" for 7 days).
   * - The method parses the duration and returns a Date object representing the expiration time.
   */
  getRefreshExpiry(): Date {
    const expiry = this.configService.get<string>('jwt.refreshExpiry');
    const ms = this.parseExpiry(expiry);
    return new Date(Date.now() + ms);
  }

  /**
   * Gets the time-to-live (TTL) for an access token in seconds.
   * - The TTL is calculated based on the configured access token expiry duration.
   * - The method parses the duration and returns the corresponding number of seconds.
   */
  getAccessTokenTtlSeconds(): number {
    const expiry = this.configService.get<string>('jwt.accessExpiry');
    return this.parseExpiry(expiry) / 1000;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Parses an expiry string (e.g., "15m", "7d") into milliseconds.
   * - Validates the format of the expiry string and throws an error if it's invalid.
   * - Supports seconds (s), minutes (m), hours (h), and days (d) as units.
   */
  private parseExpiry(expiry: string): number {
    const match = expiry?.match(/^([1-9]\d*)([smhd])$/);
    if (!match) {
      throw new Error(
        `Invalid expiry format "${expiry}". ` +
          'Expected a positive integer followed by a unit: s, m, h, or d (e.g. "15m", "7d").',
      );
    }
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const multipliers: Record<string, number> = {
      s: 1_000,
      m: 60 * 1_000,
      h: 60 * 60 * 1_000,
      d: 24 * 60 * 60 * 1_000,
    };
    return value * multipliers[unit];
  }
}
