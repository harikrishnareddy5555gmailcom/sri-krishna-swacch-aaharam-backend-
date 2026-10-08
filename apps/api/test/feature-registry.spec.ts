import { describe, it, expect } from 'vitest';
import { FeatureKey, FeatureStatus, FeatureCategory } from '@vishkaraa/types';
import {
  FEATURE_REGISTRY,
  getAllFeatureDefinitions,
  getFeatureDefinition,
  validateFeatureDependencies,
  isFunctionalStatus,
} from '@vishkaraa/shared';

describe('Feature Registry Foundation', () => {
  it('should register all expected system features with unique keys', () => {
    const all = getAllFeatureDefinitions();
    expect(all.length).toBe(Object.keys(FeatureKey).length);

    const keys = all.map((f) => f.key);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });

  it('should have valid statuses and categories for all features', () => {
    const all = getAllFeatureDefinitions();
    for (const f of all) {
      expect(Object.values(FeatureStatus)).toContain(f.status);
      expect(Object.values(FeatureCategory)).toContain(f.category);
      expect(f.name).toBeTruthy();
      expect(f.description).toBeTruthy();
      expect(Array.isArray(f.dependencies)).toBe(true);
      expect(Array.isArray(f.permissions)).toBe(true);
      expect(f.navigation).toBeDefined();
    }
  });

  it('should have valid dependencies pointing to registered features', () => {
    const all = getAllFeatureDefinitions();
    for (const f of all) {
      for (const depKey of f.dependencies) {
        expect(FEATURE_REGISTRY[depKey]).toBeDefined();
        // A feature must not depend on itself
        expect(depKey).not.toBe(f.key);
      }
    }
  });

  it('should properly validate dependencies when all dependencies are active', () => {
    // ORDERS depends on CHECKOUT
    const activeFn = (_key: FeatureKey) => true;
    const result = validateFeatureDependencies(FeatureKey.ORDERS, activeFn);

    expect(result.valid).toBe(true);
    expect(result.unmetDependencies).toHaveLength(0);
  });

  it('should fail dependency validation when a required dependency is inactive', () => {
    // ORDERS depends on CHECKOUT
    const inactiveCheckout = (key: FeatureKey) => key !== FeatureKey.CHECKOUT;
    const result = validateFeatureDependencies(
      FeatureKey.ORDERS,
      inactiveCheckout,
    );

    expect(result.valid).toBe(false);
    expect(result.unmetDependencies).toContain(FeatureKey.CHECKOUT);
  });

  it('should correctly distinguish functional vs non-functional statuses', () => {
    expect(isFunctionalStatus(FeatureStatus.ACTIVE)).toBe(true);
    expect(isFunctionalStatus(FeatureStatus.BETA)).toBe(true);
    expect(isFunctionalStatus(FeatureStatus.HIDDEN)).toBe(true);

    expect(isFunctionalStatus(FeatureStatus.INACTIVE)).toBe(false);
    expect(isFunctionalStatus(FeatureStatus.COMING_SOON)).toBe(false);
    expect(isFunctionalStatus(FeatureStatus.MAINTENANCE)).toBe(false);
  });

  it('should return undefined for unregistered feature key', () => {
    expect(getFeatureDefinition('NON_EXISTENT' as FeatureKey)).toBeUndefined();
  });
});
