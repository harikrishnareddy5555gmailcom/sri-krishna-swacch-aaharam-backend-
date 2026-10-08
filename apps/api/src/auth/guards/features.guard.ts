import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FeatureKey } from '@vishkaraa/types';
import { FEATURES_KEY } from '../decorators/features.decorator.js';
import { FeaturesService } from '../../features/features.service.js';
import type { MinimalUser } from '../../permissions/permissions.service.js';

interface RequestWithUser {
  user?: MinimalUser;
}

@Injectable()
export class FeaturesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly featuresService: FeaturesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredFeatures = this.reflector.getAllAndOverride<FeatureKey[]>(
      FEATURES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If no feature requirements attached, route is allowed
    if (!requiredFeatures || requiredFeatures.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    for (const feature of requiredFeatures) {
      const isEnabled = await this.featuresService.isFeatureEnabled(
        feature,
        user,
      );
      if (!isEnabled) {
        throw new ForbiddenException(
          `Feature '${feature}' is currently disabled or unavailable for your account`,
        );
      }
    }

    return true;
  }
}
