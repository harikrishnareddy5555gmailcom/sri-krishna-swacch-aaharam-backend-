import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { FeatureKey } from '@vishkaraa/types';

export const FEATURES_KEY = 'features';

/**
 * Decorator to require one or more features to be active for an endpoint.
 * Evaluated by FeaturesGuard.
 *
 * Example:
 *   @RequireFeatures(FeatureKey.ORDERS)
 */
export const RequireFeatures = (
  ...features: FeatureKey[]
): CustomDecorator<string> => SetMetadata(FEATURES_KEY, features);
