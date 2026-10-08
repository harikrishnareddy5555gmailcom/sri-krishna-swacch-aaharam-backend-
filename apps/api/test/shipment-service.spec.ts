import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { ShipmentStatus, OrderStatus } from '@prisma/client';
import { Permissions, UserRole } from '@vishkaraa/types';
import {
  ShipmentService,
  ALLOWED_TRANSITIONS,
  PRE_DISPATCH_STATUSES,
  TERMINAL_STATUSES,
} from '../src/shipping/shipping.service.js';
import type { MinimalUser } from '../src/permissions/permissions.service.js';

describe('Phase 13B.2 — ShipmentService Unit Tests', () => {
  let shipmentService: ShipmentService;
  let mockPrisma: any;
  let mockAuditService: any;
  let mockPermissionsService: any;
  let mockInventoryService: any;

  const superAdminUser: MinimalUser = {
    id: 'super-admin-uuid',
    role: UserRole.SUPER_ADMIN,
    email: 'superadmin@vishkaraa.local',
  };

  const adminUser: MinimalUser = {
    id: 'admin-uuid-1',
    role: UserRole.ADMIN,
    email: 'admin@vishkaraa.local',
  };

  const regularUser: MinimalUser = {
    id: 'user-uuid-1',
    role: UserRole.USER,
    email: 'user1@vishkaraa.local',
  };

  const otherUser: MinimalUser = {
    id: 'user-uuid-2',
    role: UserRole.USER,
    email: 'user2@vishkaraa.local',
  };

  beforeEach(() => {
    mockPrisma = {
      $transaction: vi.fn(async (cb) => cb(mockPrisma)),
      $queryRaw: vi.fn(),
      shipment: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      shipmentItem: {
        findMany: vi.fn(),
        create: vi.fn(),
      },
      shipmentEvent: {
        create: vi.fn(),
      },
      order: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      orderItem: {
        findMany: vi.fn(),
      },
      auditLog: {
        create: vi.fn(),
      },
    };

    mockAuditService = {
      logEvent: vi.fn(),
    };

    mockPermissionsService = {
      can: vi.fn().mockImplementation((user: MinimalUser, perm: string) => {
        if (user.role === UserRole.SUPER_ADMIN) return true;
        if (user.role === UserRole.ADMIN) {
          return [
            Permissions.SHIPPING_VIEW,
            Permissions.SHIPPING_CREATE,
            Permissions.SHIPPING_UPDATE,
            Permissions.SHIPPING_CANCEL,
            Permissions.SHIPPING_RECONCILE,
          ].includes(perm);
        }
        if (user.role === UserRole.USER) {
          return perm === Permissions.SHIPPING_VIEW;
        }
        return false;
      }),
    };

    mockInventoryService = {
      shipShipmentInventory: vi.fn().mockResolvedValue(undefined),
      shipOrderInventory: vi.fn().mockResolvedValue(undefined),
    };

    shipmentService = new ShipmentService(
      mockPrisma,
      mockAuditService,
      mockPermissionsService,
      mockInventoryService,
    );
  });

  // ===========================================================================
  // 1. STATE MACHINE MATRIX & CANONICAL RULES
  // ===========================================================================
  describe('Canonical State Machine Matrix', () => {
    it('should verify terminal states cannot transition to any other state', () => {
      for (const terminal of TERMINAL_STATUSES) {
        expect(ALLOWED_TRANSITIONS[terminal]).toEqual([]);
      }
    });

    it('should verify pre-dispatch statuses permit cancellation', () => {
      for (const preDispatch of PRE_DISPATCH_STATUSES) {
        expect(ALLOWED_TRANSITIONS[preDispatch]).toContain(ShipmentStatus.CANCELLED);
      }
    });

    it('should strictly forbid cancellation after SHIPPED', () => {
      const postDispatchStatuses: ShipmentStatus[] = [
        ShipmentStatus.SHIPPED,
        ShipmentStatus.IN_TRANSIT,
        ShipmentStatus.OUT_FOR_DELIVERY,
        ShipmentStatus.DELIVERED,
        ShipmentStatus.DELIVERY_FAILED,
        ShipmentStatus.RTO_INITIATED,
        ShipmentStatus.RTO_DELIVERED,
        ShipmentStatus.LOST,
      ];

      for (const status of postDispatchStatuses) {
        expect(ALLOWED_TRANSITIONS[status]).not.toContain(ShipmentStatus.CANCELLED);
      }
    });

    it('should allow valid forward flow: CREATED -> PACKING -> PACKED -> READY_TO_SHIP -> SHIPPED -> IN_TRANSIT -> OUT_FOR_DELIVERY -> DELIVERED', () => {
      expect(ALLOWED_TRANSITIONS[ShipmentStatus.CREATED]).toContain(ShipmentStatus.PACKING);
      expect(ALLOWED_TRANSITIONS[ShipmentStatus.PACKING]).toContain(ShipmentStatus.PACKED);
      expect(ALLOWED_TRANSITIONS[ShipmentStatus.PACKED]).toContain(ShipmentStatus.READY_TO_SHIP);
      expect(ALLOWED_TRANSITIONS[ShipmentStatus.READY_TO_SHIP]).toContain(ShipmentStatus.SHIPPED);
      expect(ALLOWED_TRANSITIONS[ShipmentStatus.SHIPPED]).toContain(ShipmentStatus.IN_TRANSIT);
      expect(ALLOWED_TRANSITIONS[ShipmentStatus.IN_TRANSIT]).toContain(ShipmentStatus.OUT_FOR_DELIVERY);
      expect(ALLOWED_TRANSITIONS[ShipmentStatus.OUT_FOR_DELIVERY]).toContain(ShipmentStatus.DELIVERED);
    });

    it('should allow failure recovery and RTO flow: OUT_FOR_DELIVERY -> DELIVERY_FAILED -> RTO_INITIATED -> RTO_DELIVERED', () => {
      expect(ALLOWED_TRANSITIONS[ShipmentStatus.OUT_FOR_DELIVERY]).toContain(ShipmentStatus.DELIVERY_FAILED);
      expect(ALLOWED_TRANSITIONS[ShipmentStatus.DELIVERY_FAILED]).toContain(ShipmentStatus.OUT_FOR_DELIVERY);
      expect(ALLOWED_TRANSITIONS[ShipmentStatus.DELIVERY_FAILED]).toContain(ShipmentStatus.RTO_INITIATED);
      expect(ALLOWED_TRANSITIONS[ShipmentStatus.RTO_INITIATED]).toContain(ShipmentStatus.RTO_DELIVERED);
    });
  });

  // ===========================================================================
  // 2. AUTHORIZATION & RBAC
  // ===========================================================================
  describe('Authorization & Permissions', () => {
    it('should reject shipment creation by standard customer (USER role)', async () => {
      await expect(
        shipmentService.createShipment(regularUser, {
          orderId: 'order-1',
          items: [{ orderItemId: 'oi-1', quantity: 1 }],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject status update by standard customer', async () => {
      await expect(
        shipmentService.updateShipmentStatus('shp-1', regularUser, {
          status: ShipmentStatus.SHIPPED,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject cancellation by standard customer', async () => {
      await expect(
        shipmentService.cancelShipment('shp-1', regularUser, {
          reason: 'Customer request',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should prevent IDOR: user cannot view shipment belonging to another user', async () => {
      mockPrisma.shipment.findUnique.mockResolvedValue({
        id: 'shp-1',
        shipmentNumber: 'SHP-202610-00000001',
        orderId: 'order-other',
        userId: 'other-user-uuid',
        status: ShipmentStatus.CREATED,
        carrierCode: 'MANUAL',
        carrierName: 'Manual Dispatch',
        weightGrams: 500,
        isCod: false,
        codAmountPaise: 0,
        version: 1,
        reconciliationRequired: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [],
        events: [],
      });

      await expect(shipmentService.getShipment('shp-1', regularUser)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ===========================================================================
  // 3. INPUT & QUANTITY VALIDATION
  // ===========================================================================
  describe('Input & Quantity Validation', () => {
    it('should reject shipment creation with empty items array', async () => {
      await expect(
        shipmentService.createShipment(adminUser, {
          orderId: 'order-1',
          items: [],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject shipment creation with duplicate order item IDs', async () => {
      await expect(
        shipmentService.createShipment(adminUser, {
          orderId: 'order-1',
          items: [
            { orderItemId: 'oi-1', quantity: 1 },
            { orderItemId: 'oi-1', quantity: 2 },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject shipment creation with zero or negative quantity', async () => {
      await expect(
        shipmentService.createShipment(adminUser, {
          orderId: 'order-1',
          items: [{ orderItemId: 'oi-1', quantity: 0 }],
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        shipmentService.createShipment(adminUser, {
          orderId: 'order-1',
          items: [{ orderItemId: 'oi-1', quantity: -5 }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject cancellation with reason shorter than 3 characters', async () => {
      await expect(
        shipmentService.cancelShipment('shp-1', adminUser, {
          reason: 'no',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
