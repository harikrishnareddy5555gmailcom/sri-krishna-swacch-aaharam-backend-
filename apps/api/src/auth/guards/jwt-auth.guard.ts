import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * JWT Auth Guard
 *
 * Protects routes by validating the JWT access token.
 * Uses the 'jwt' strategy registered in JwtStrategy.
 *
 * Usage:
 *   @UseGuards(JwtAuthGuard)
 *   @Get('protected-route')
 *   ...
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
