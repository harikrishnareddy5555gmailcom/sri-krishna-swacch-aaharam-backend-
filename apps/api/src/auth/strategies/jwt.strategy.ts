import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { JwtPayload } from '@vishkaraa/types';
import { UsersService } from '../../users/users.service.js';
import type { User } from '@prisma/client';

/**
 * JWT Strategy
 *
 * Validates JWT access tokens on protected routes.
 * The validated user is attached to req.user.
 *
 * SECURITY:
 * - Token is extracted from Authorization: Bearer <token> header
 * - Token signature is verified against JWT_SECRET
 * - The user is looked up in the database to ensure they still exist and are active
 * - Expired tokens are automatically rejected by passport-jwt
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly config: ConfigService,
    private readonly usersService: UsersService,
  ) {
    const secret = config.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error('JWT_SECRET environment variable is not configured');
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  /**
   * Called after the token signature is verified.
   * Looks up the user in the database for additional validation.
   */
  async validate(payload: JwtPayload): Promise<Omit<User, 'passwordHash'>> {
    const user = await this.usersService.findById(payload.sub);

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException(
        'User account is inactive or no longer exists',
      );
    }

    const { passwordHash: _, ...result } = user;
    return result;
  }
}
