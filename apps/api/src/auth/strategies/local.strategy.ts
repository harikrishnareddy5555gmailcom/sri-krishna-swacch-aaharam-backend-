import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { AuthService } from '../auth.service.js';
import type { User } from '@prisma/client';

/**
 * Local Strategy
 *
 * Handles email/password authentication during login.
 * Expects the request body to contain: { email, password }
 *
 * SECURITY:
 * - Uses bcrypt comparison (time-constant) to prevent timing attacks
 * - Returns generic "Invalid credentials" error — never reveals if
 *   the email exists or if the password was wrong (prevents enumeration)
 */
@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy, 'local') {
  constructor(private readonly authService: AuthService) {
    super({
      usernameField: 'email', // Use 'email' instead of 'username'
      passwordField: 'password',
    });
  }

  async validate(
    email: string,
    password: string,
  ): Promise<Omit<User, 'passwordHash'>> {
    const user = await this.authService.validateUser(email, password);

    if (!user) {
      // SECURITY: Generic error prevents username enumeration
      throw new UnauthorizedException('Invalid credentials');
    }

    return user;
  }
}
