import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Local Auth Guard
 *
 * Validates email/password credentials during login.
 * Uses the 'local' strategy registered in LocalStrategy.
 *
 * Usage:
 *   @UseGuards(LocalAuthGuard)
 *   @Post('login')
 *   ...
 */
@Injectable()
export class LocalAuthGuard extends AuthGuard('local') {}
