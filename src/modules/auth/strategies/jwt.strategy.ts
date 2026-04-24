import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthRepository } from '../auth.repository';
import { JwtPayload } from '../interfaces/jwt-payload.interface';
import { TokenDenylistService } from '../token-denylist.service';
import { AccountStatus } from '@prisma/client';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly authRepository: AuthRepository,
    private readonly tokenDenylistService: TokenDenylistService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('jwt.accessSecret') as string,
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload> {
    // Check JTI denylist
    const revoked = await this.tokenDenylistService.isRevoked(payload.jti);
    if (revoked) throw new UnauthorizedException('Token has been revoked');

    const user = await this.authRepository.findById(payload.sub);
    if (!user) throw new UnauthorizedException('User no longer exists');

    if (user.status !== AccountStatus.ACTIVE) {
      throw new UnauthorizedException('Account is not active.');
    }

    return {
      sub: payload.sub,
      email: payload.email,
      role: payload.role,
      jti: payload.jti,
    };
  }
}
