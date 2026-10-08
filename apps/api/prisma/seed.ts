import {
  PrismaClient,
  UserRole,
  UserStatus,
  PermissionEffect,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  FEATURE_REGISTRY,
  PERMISSION_REGISTRY,
  DEFAULT_ROLE_PERMISSIONS,
} from '@vishkaraa/shared';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log('🌱 Starting deterministic seed for Vishkaraa...');

  // 1. Seed Roles
  console.log('Seeding Roles...');
  const roles = [
    {
      name: UserRole.SUPER_ADMIN,
      description:
        'Platform Owner — Complete unrestricted authority across all features and permissions',
      isSystem: true,
    },
    {
      name: UserRole.ADMIN,
      description:
        'Operations Manager — Granular administrative permissions granted by Super Admin',
      isSystem: true,
    },
    {
      name: UserRole.USER,
      description:
        'End User — Standard consumer permissions for browsing, orders, and returns',
      isSystem: true,
    },
  ];

  for (const role of roles) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: { description: role.description },
      create: role,
    });
  }

  // 2. Seed Features
  console.log('Seeding Features...');
  for (const feature of Object.values(FEATURE_REGISTRY)) {
    await prisma.feature.upsert({
      where: { key: feature.key },
      update: {
        name: feature.name,
        description: feature.description,
        status: feature.status,
        category: feature.category,
        defaultEnabled: feature.defaultEnabled,
        dependencies: feature.dependencies,
        path: feature.navigation.path,
        showInNav: feature.navigation.showInNav,
        navOrder: feature.navigation.navOrder,
        icon: feature.navigation.icon,
      },
      create: {
        key: feature.key,
        name: feature.name,
        description: feature.description,
        status: feature.status,
        category: feature.category,
        defaultEnabled: feature.defaultEnabled,
        dependencies: feature.dependencies,
        path: feature.navigation.path,
        showInNav: feature.navigation.showInNav,
        navOrder: feature.navigation.navOrder,
        icon: feature.navigation.icon,
      },
    });
  }

  // 3. Seed Permissions
  console.log('Seeding Permissions...');
  for (const perm of Object.values(PERMISSION_REGISTRY)) {
    await prisma.permission.upsert({
      where: { key: perm.key },
      update: {
        resource: perm.resource,
        action: perm.action,
        description: perm.description,
        featureKey: perm.featureKey,
        isAssignableToAdmin: perm.isAssignableToAdmin,
      },
      create: {
        key: perm.key,
        resource: perm.resource,
        action: perm.action,
        description: perm.description,
        featureKey: perm.featureKey,
        isAssignableToAdmin: perm.isAssignableToAdmin,
      },
    });
  }

  // 4. Seed Role Permissions
  console.log('Seeding Role Permissions...');
  for (const roleName of [
    UserRole.SUPER_ADMIN,
    UserRole.ADMIN,
    UserRole.USER,
  ]) {
    const permKeys = DEFAULT_ROLE_PERMISSIONS[roleName] || [];
    for (const key of permKeys) {
      await prisma.rolePermission.upsert({
        where: {
          roleName_permissionKey: {
            roleName,
            permissionKey: key,
          },
        },
        update: { effect: PermissionEffect.ALLOW },
        create: {
          roleName,
          permissionKey: key,
          effect: PermissionEffect.ALLOW,
        },
      });
    }
  }

  // 5. Seed Deterministic Test Users
  console.log('Seeding Deterministic Users...');
  const saltRounds = 10;
  const passwordHash = await bcrypt.hash('Vishkaraa@Dev123', saltRounds);

  const testUsers = [
    {
      email: 'superadmin@vishkaraa.local',
      firstName: 'Super',
      lastName: 'Admin',
      role: UserRole.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
    },
    {
      email: 'admin@vishkaraa.local',
      firstName: 'Operations',
      lastName: 'Admin',
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
    },
    {
      email: 'user@vishkaraa.local',
      firstName: 'Standard',
      lastName: 'User',
      role: UserRole.USER,
      status: UserStatus.ACTIVE,
    },
  ];

  for (const u of testUsers) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {
        firstName: u.firstName,
        lastName: u.lastName,
        role: u.role,
        status: u.status,
      },
      create: {
        email: u.email,
        passwordHash,
        firstName: u.firstName,
        lastName: u.lastName,
        role: u.role,
        status: u.status,
      },
    });
  }

  console.log('✅ Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
