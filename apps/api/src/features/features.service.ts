import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import {
  FeatureKey,
  FeatureStatus,
  UserRole,
  type FeatureDefinition,
  type UserFeatureAccess,
} from '@vishkaraa/types';
import {
  FEATURE_REGISTRY,
  validateFeatureDependencies,
  isFunctionalStatus,
} from '@vishkaraa/shared';
import { FeatureStatus as PrismaFeatureStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import {
  PermissionsService,
  type MinimalUser,
} from '../permissions/permissions.service.js';

@Injectable()
export class FeaturesService {
  private readonly logger = new Logger(FeaturesService.name);

  // In-memory status overrides for testing or when DB is unavailable
  private inMemoryStatusOverrides = new Map<FeatureKey, FeatureStatus>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly permissionsService: PermissionsService,
  ) {}

  /**
   * Returns all feature definitions, merging database records with authoritative registry.
   */
  async getAllFeatures(): Promise<FeatureDefinition[]> {
    const registryFeatures = { ...FEATURE_REGISTRY };

    try {
      const dbFeatures = await this.prisma.feature.findMany();
      for (const df of dbFeatures) {
        const key = df.key as FeatureKey;
        const reg = registryFeatures[key];
        if (reg) {
          registryFeatures[key] = {
            ...reg,
            status: df.status as FeatureStatus,
            defaultEnabled: df.defaultEnabled,
          };
        }
      }
    } catch {
      // In-memory fallback
      for (const [key, status] of this.inMemoryStatusOverrides.entries()) {
        const reg = registryFeatures[key];
        if (reg) {
          registryFeatures[key] = {
            ...reg,
            status,
          };
        }
      }
    }

    return Object.values(registryFeatures);
  }

  /**
   * Retrieves single feature definition by key.
   */
  async getFeature(key: FeatureKey): Promise<FeatureDefinition> {
    const all = await this.getAllFeatures();
    const feat = all.find((f) => f.key === key);
    if (!feat) {
      throw new NotFoundException(
        `Feature '${key}' is not registered in the system`,
      );
    }
    return feat;
  }

  /**
   * Checks if a feature is enabled and functional.
   * Recursively validates all feature dependencies!
   */
  async isFeatureEnabled(
    key: FeatureKey,
    user?: MinimalUser,
  ): Promise<boolean> {
    const definition = FEATURE_REGISTRY[key];
    if (!definition) {
      return false;
    }

    const feature = await this.getFeature(key);

    // Maintenance handling
    if (feature.status === FeatureStatus.MAINTENANCE) {
      if (user?.role === UserRole.SUPER_ADMIN) {
        return true; // Super Admin can access maintenance features for debugging
      }
      throw new ServiceUnavailableException(
        `Feature '${feature.name}' is currently down for maintenance`,
      );
    }

    // Inactive or Coming Soon are not functional
    if (
      feature.status === FeatureStatus.INACTIVE ||
      feature.status === FeatureStatus.COMING_SOON
    ) {
      return false;
    }

    // Beta features require Super Admin or Admin access (or explicitly granted permission)
    if (feature.status === FeatureStatus.BETA) {
      if (
        user &&
        (user.role === UserRole.SUPER_ADMIN || user.role === UserRole.ADMIN)
      ) {
        // allowed preview
      } else {
        return false;
      }
    }

    // Recursive Dependency Validation: All dependencies must be enabled
    for (const depKey of feature.dependencies) {
      const isDepEnabled = await this.isFeatureEnabled(depKey, user);
      if (!isDepEnabled) {
        this.logger.debug(
          `Feature '${key}' disabled because required dependency '${depKey}' is not enabled`,
        );
        return false;
      }
    }

    return true;
  }

  /**
   * Returns effective features for a user, evaluating enabled status and permission accessibility.
   */
  async getEffectiveFeaturesForUser(
    user: MinimalUser,
  ): Promise<UserFeatureAccess[]> {
    const allFeatures = await this.getAllFeatures();
    const result: UserFeatureAccess[] = [];

    // Helper map of current status
    const statusMap = new Map<FeatureKey, boolean>();
    for (const f of allFeatures) {
      statusMap.set(f.key, isFunctionalStatus(f.status));
    }

    for (const feat of allFeatures) {
      const depValidation = validateFeatureDependencies(
        feat.key,
        (k) => statusMap.get(k) ?? false,
      );
      let isEnabled: boolean;

      try {
        isEnabled = await this.isFeatureEnabled(feat.key, user);
      } catch {
        isEnabled = false;
      }

      // Check if user has permission to access the feature
      let isAccessible = isEnabled;
      if (feat.permissions && feat.permissions.length > 0 && user) {
        const hasAnyPerm = await this.permissionsService.canAny(
          user,
          feat.permissions,
        );
        isAccessible = isEnabled && hasAnyPerm;
      }

      result.push({
        key: feat.key,
        name: feat.name,
        status: feat.status,
        isEnabled,
        isAccessible,
        category: feat.category,
        navigation: feat.navigation,
        unmetDependencies: depValidation.unmetDependencies,
      });
    }

    return result;
  }

  /**
   * Updates feature status with dependency validation and audit logging.
   *
   * Dependency Protection:
   * 1. Cannot enable a feature if its dependencies are inactive.
   * 2. Cannot disable a feature if other active features depend on it.
   */
  async updateFeatureStatus(
    key: FeatureKey,
    newStatus: FeatureStatus,
    actor: MinimalUser,
    reason?: string,
  ): Promise<FeatureDefinition> {
    const currentFeature = await this.getFeature(key);
    const oldStatus = currentFeature.status;

    if (newStatus === oldStatus) {
      return currentFeature;
    }

    const allFeatures = await this.getAllFeatures();

    // 1. Enabling validation: are dependencies satisfied?
    if (isFunctionalStatus(newStatus)) {
      const statusMap = new Map<FeatureKey, boolean>(
        allFeatures.map((f) => [f.key, isFunctionalStatus(f.status)]),
      );
      statusMap.set(key, true);

      for (const depKey of currentFeature.dependencies) {
        if (!statusMap.get(depKey)) {
          throw new BadRequestException(
            `Cannot activate feature '${key}' because required dependency '${depKey}' is not active`,
          );
        }
      }
    }

    // 2. Disabling validation: do active features depend on this feature?
    if (!isFunctionalStatus(newStatus)) {
      const dependentFeatures = allFeatures.filter(
        (f) => isFunctionalStatus(f.status) && f.dependencies.includes(key),
      );

      if (dependentFeatures.length > 0) {
        const depNames = dependentFeatures.map((f) => f.key).join(', ');
        throw new BadRequestException(
          `Cannot disable feature '${key}' because active features depend on it: ${depNames}`,
        );
      }
    }

    // 3. Persist update
    try {
      const dbStatus = newStatus as unknown as PrismaFeatureStatus;
      await this.prisma.feature.upsert({
        where: { key },
        update: { status: dbStatus },
        create: {
          key,
          name: currentFeature.name,
          description: currentFeature.description,
          status: dbStatus,
          category: currentFeature.category,
          defaultEnabled: currentFeature.defaultEnabled,
          dependencies: currentFeature.dependencies,
          path: currentFeature.navigation.path,
          showInNav: currentFeature.navigation.showInNav,
          navOrder: currentFeature.navigation.navOrder,
          icon: currentFeature.navigation.icon,
        },
      });
    } catch {
      this.inMemoryStatusOverrides.set(key, newStatus);
    }

    // 4. Emit Audit Event
    await this.auditService.logEvent({
      actorId: actor.id,
      actorRole: actor.role,
      actorEmail: actor.email,
      action: 'FEATURE_STATUS_CHANGED',
      entityType: 'Feature',
      entityId: key,
      previousValue: { status: oldStatus },
      newValue: { status: newStatus },
      reason,
    });

    return this.getFeature(key);
  }
}
