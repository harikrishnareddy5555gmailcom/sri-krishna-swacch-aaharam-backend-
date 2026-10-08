import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Optional JWT Auth Guard
 *
 * Populates req.user if a valid Bearer token is provided.
 * If no token is provided or the token is invalid, it does NOT throw 401;
 * instead, it allows execution to proceed with req.user = null.
 *
 * This allows endpoints like GET /cart or POST /cart/items to seamlessly support
 * both authenticated users and anonymous guest visitors.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  override handleRequest<TUser = unknown>(_err: unknown, user: TUser): TUser | null {
    return user ?? null;
  }
}
