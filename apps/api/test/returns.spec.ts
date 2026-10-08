import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  ReturnStatus,
  ReturnReason,
  ReturnItemCondition,
  ReturnItemDisposition,
  RefundSource,
  RefundStatus,
  OrderStatus,
} from '@prisma/client';
import { AuditAction, UserRole } from '@vishkaraa/types';
import { ReturnService } from '../src/returns/return.service.js';
import type { MinimalUser } from '../src/permissions/permissions.service.js';

describe('Returns, RMA & Inspection Domain — Phase 10B', () => {
  let returnService: ReturnService;
  let mockPrisma: any;
  let mockAuditService: any;
  let mockRefundService: any;

  const customerUser: MinimalUser = {
    id: 'customer-uuid-1',
    role: UserRole.USER,
    email: 'customer@vishkaraa.local',
  };

  const otherCustomerUser: MinimalUser = {
    id: 'customer-uuid-2',
    role: UserRole.USER,
    email: 'other@vishkaraa.local',
  };

  const adminUser: MinimalUser = {
    id: 'admin-uuid-1',
    role: UserRole.ADMIN,
    email: 'admin@vishkaraa.local',
  };

  const inspectorUser: MinimalUser = {
    id: 'inspector-uuid-1',
    role: UserRole.ADMIN,
    email: 'inspector@vishkaraa.local',
  };

  const superAdminUser: MinimalUser = {
    id: 'super-admin-uuid-1',
    role: UserRole.SUPER_ADMIN,
    email: 'superadmin@vishkaraa.local',
  };

  const baseOrder = {
    id: 'order-uuid-1',
    orderNumber: 'VN-202609-A1B2C3D4',
    userId: 'customer-uuid-1',
    status: OrderStatus.DELIVERED,
    subtotal: 300000, // ₹3,000
    discount: 30000,  // ₹300 coupon (10%)
    tax: 0,
    totalAmount: 270000, // ₹2,700
    currency: 'INR',
    deliveredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago (within 7-day window)
    items: [
      {
        id: 'order-item-1',
        orderId: 'order-uuid-1',
        productName: 'Kumkumadi Tailam 30ml',
        productSku: 'VN-KT-30ML',
        quantity: 2,
        unitPrice: 100000, // ₹1,000 each
        lineTotal: 200000, // ₹2,000
        product: { id: 'prod-1', isReturnable: true },
      },
      {
        id: 'order-item-2',
        orderId: 'order-uuid-1',
        productName: 'Herbal Hair Oil 100ml',
        productSku: 'VN-HHO-100ML',
        quantity: 1,
        unitPrice: 100000, // ₹1,000
        lineTotal: 100000, // ₹1,000
        product: { id: 'prod-2', isReturnable: false }, // Non-returnable catalog policy
      },
    ],
  };

  const baseReturn = {
    id: 'return-uuid-1',
    rmaNumber: 'RMA-202609-ABC12345',
    orderId: 'order-uuid-1',
    userId: 'customer-uuid-1',
    status: ReturnStatus.REQUESTED,
    customerReason: ReturnReason.DAMAGED_PRODUCT,
    customerNotes: 'Bottle was cracked upon arrival',
    evidenceKeys: ['returns/ord_1/proof1.jpg'],
    returnCarrier: null,
    trackingNumber: null,
    receivedAt: null,
    requestedById: 'customer-uuid-1',
    reviewedById: null,
    reviewedAt: null,
    rejectionReason: null,
    inspectedById: null,
    inspectedAt: null,
    inspectionNotes: null,
    eligibleRefundPaise: 0,
    refundedPaise: 0,
    currency: 'INR',
    idempotencyKey: null,
    createdAt: new Date('2026-09-29T10:00:00Z'),
    updatedAt: new Date('2026-09-29T10:00:00Z'),
    items: [
      {
        id: 'return-item-1',
        returnId: 'return-uuid-1',
        orderItemId: 'order-item-1',
        requestedQuantity: 1,
        receivedQuantity: 0,
        acceptedQuantity: 0,
        rejectedQuantity: 0,
        reason: ReturnReason.DAMAGED_PRODUCT,
        customerNotes: 'Bottle was cracked',
        condition: null,
        disposition: null,
        inspectorNotes: null,
        itemRefundPaise: 0,
        createdAt: new Date('2026-09-29T10:00:00Z'),
        updatedAt: new Date('2026-09-29T10:00:00Z'),
      },
    ],
    order: baseOrder,
  };

  beforeEach(() => {
    mockAuditService = {
      log: vi.fn(),
    };

    mockRefundService = {
      createRefund: vi.fn().mockResolvedValue({
        id: 'refund-uuid-101',
        refundNumber: 'RF-202609-00000001',
        status: 'PROCESSING',
        amount: 90000,
      }),
    };

    mockPrisma = {
      return: {
        findUnique: vi.fn(),
        findUniqueOrThrow: vi.fn(),
        findMany: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      returnItem: {
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
      },
      refund: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      order: {
        findUnique: vi.fn(),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({ id: 'audit-log-1' }),
      },
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'order-item-1', quantity: 2, unitPrice: 100000 }]),
      $transaction: vi.fn(async (cb: any) => cb(mockPrisma)),
    };

    returnService = new ReturnService(
      mockPrisma,
      mockAuditService,
      mockRefundService,
    );
  });

  // ===========================================================================
  // 1. CREATE RETURN
  // ===========================================================================

  describe('createReturn', () => {
    it('creates a return successfully for a delivered order within the 7-day window', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(baseOrder);
      mockPrisma.return.findUnique.mockResolvedValue(null);
      mockPrisma.return.create.mockResolvedValue(baseReturn);

      const result = await returnService.createReturn('order-uuid-1', customerUser, {
        items: [{ orderItemId: 'order-item-1', quantity: 1, reason: ReturnReason.CHANGED_MIND }],
        customerNotes: 'Decided not to use it',
      });

      expect(result.rmaNumber).toBe(baseReturn.rmaNumber);
      expect(result.status).toBe(ReturnStatus.REQUESTED);
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: AuditAction.RETURN_REQUESTED,
            actorId: customerUser.id,
          }),
        }),
      );
    });

    it('returns existing return on idempotent replay', async () => {
      mockPrisma.return.findUnique.mockResolvedValue(baseReturn);

      const result = await returnService.createReturn('order-uuid-1', customerUser, {
        items: [{ orderItemId: 'order-item-1', quantity: 1, reason: ReturnReason.DAMAGED_PRODUCT }],
        idempotencyKey: 'client-key-12345',
      });

      expect(result.id).toBe(baseReturn.id);
      expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
    });

    it('rejects return creation if order is not DELIVERED', async () => {
      const confirmedOrder = { ...baseOrder, status: OrderStatus.CONFIRMED, deliveredAt: null };
      mockPrisma.order.findUnique.mockResolvedValue(confirmedOrder);

      await expect(
        returnService.createReturn('order-uuid-1', customerUser, {
          items: [{ orderItemId: 'order-item-1', quantity: 1, reason: ReturnReason.CHANGED_MIND }],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects return creation if delivery timestamp is unrecorded (legacy order)', async () => {
      const legacyOrder = { ...baseOrder, deliveredAt: null };
      mockPrisma.order.findUnique.mockResolvedValue(legacyOrder);

      await expect(
        returnService.createReturn('order-uuid-1', customerUser, {
          items: [{ orderItemId: 'order-item-1', quantity: 1, reason: ReturnReason.CHANGED_MIND }],
        }),
      ).rejects.toThrow('Delivery timestamp unrecorded');
    });

    it('rejects return creation if 7-day eligibility window has expired', async () => {
      const expiredOrder = {
        ...baseOrder,
        deliveredAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // 10 days ago
      };
      mockPrisma.order.findUnique.mockResolvedValue(expiredOrder);

      await expect(
        returnService.createReturn('order-uuid-1', customerUser, {
          items: [{ orderItemId: 'order-item-1', quantity: 1, reason: ReturnReason.CHANGED_MIND }],
        }),
      ).rejects.toThrow('Return window has expired');
    });

    it('allows admin with RETURNS_MANAGE to bypass 7-day window via adminCreateReturn', async () => {
      const expiredOrder = {
        ...baseOrder,
        deliveredAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
      };
      mockPrisma.order.findUnique.mockResolvedValue(expiredOrder);
      mockPrisma.return.findUnique.mockResolvedValue(null);
      mockPrisma.return.create.mockResolvedValue(baseReturn);

      const result = await returnService.adminCreateReturn('order-uuid-1', adminUser, {
        items: [{ orderItemId: 'order-item-1', quantity: 1, reason: ReturnReason.CHANGED_MIND }],
      });

      expect(result.id).toBe(baseReturn.id);
    });

    it('blocks access if user attempts to return an order owned by someone else (IDOR protection)', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(baseOrder); // owned by customer-uuid-1

      await expect(
        returnService.createReturn('order-uuid-1', otherCustomerUser, {
          items: [{ orderItemId: 'order-item-1', quantity: 1, reason: ReturnReason.CHANGED_MIND }],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks return for non-returnable product on discretionary reasons (CHANGED_MIND)', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(baseOrder);

      await expect(
        returnService.createReturn('order-uuid-1', customerUser, {
          items: [{ orderItemId: 'order-item-2', quantity: 1, reason: ReturnReason.CHANGED_MIND }],
        }),
      ).rejects.toThrow('marked as non-returnable');
    });

    it('allows return for non-returnable product on statutory defect exception (DAMAGED_PRODUCT)', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(baseOrder);
      mockPrisma.return.findUnique.mockResolvedValue(null);
      mockPrisma.return.create.mockResolvedValue({
        ...baseReturn,
        items: [{ ...baseReturn.items[0], orderItemId: 'order-item-2' }],
      });

      const result = await returnService.createReturn('order-uuid-1', customerUser, {
        items: [{ orderItemId: 'order-item-2', quantity: 1, reason: ReturnReason.DAMAGED_PRODUCT }],
      });

      expect(result.id).toBe(baseReturn.id);
    });

    it('rejects if requested quantity exceeds returnable quantity balance', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(baseOrder);
      // Existing active return item using 2 units
      mockPrisma.returnItem.findMany.mockResolvedValue([
        {
          orderItemId: 'order-item-1',
          requestedQuantity: 2,
          receivedQuantity: 0,
          acceptedQuantity: 0,
          return: { status: ReturnStatus.REQUESTED },
        },
      ]);

      await expect(
        returnService.createReturn('order-uuid-1', customerUser, {
          items: [{ orderItemId: 'order-item-1', quantity: 1, reason: ReturnReason.DAMAGED_PRODUCT }],
        }),
      ).rejects.toThrow('exceeds returnable balance');
    });

    it('validates evidence keys and rejects untrusted external URLs (SSRF protection)', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(baseOrder);

      await expect(
        returnService.createReturn('order-uuid-1', customerUser, {
          items: [{ orderItemId: 'order-item-1', quantity: 1, reason: ReturnReason.DAMAGED_PRODUCT }],
          evidenceKeys: ['http://169.254.169.254/latest/meta-data'],
        }),
      ).rejects.toThrow('INVALID_EVIDENCE_URL');
    });

    it('rejects duplicate orderItemId in single return request', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(baseOrder);

      await expect(
        returnService.createReturn('order-uuid-1', customerUser, {
          items: [
            { orderItemId: 'order-item-1', quantity: 1, reason: ReturnReason.DAMAGED_PRODUCT },
            { orderItemId: 'order-item-1', quantity: 1, reason: ReturnReason.DAMAGED_PRODUCT },
          ],
        }),
      ).rejects.toThrow('Duplicate item in return request');
    });
  });

  // ===========================================================================
  // 2. APPROVE RETURN
  // ===========================================================================

  describe('approveReturn', () => {
    it('approves a REQUESTED return successfully', async () => {
      mockPrisma.return.findUnique.mockResolvedValue(baseReturn);
      const approvedReturn = {
        ...baseReturn,
        status: ReturnStatus.APPROVED,
        reviewedById: adminUser.id,
      };
      mockPrisma.return.update.mockResolvedValue(approvedReturn);

      const result = await returnService.approveReturn(baseReturn.id, adminUser, {
        notes: 'Photos verified; authorization granted.',
      });

      expect(result.status).toBe(ReturnStatus.APPROVED);
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: AuditAction.RETURN_APPROVED,
            entityId: baseReturn.id,
          }),
        }),
      );
    });

    it('throws ConflictException if return is not in REQUESTED status', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.APPROVED,
      });

      await expect(
        returnService.approveReturn(baseReturn.id, adminUser, {}),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ===========================================================================
  // 3. REJECT RETURN
  // ===========================================================================

  describe('rejectReturn', () => {
    it('rejects a return with substantive justification', async () => {
      mockPrisma.return.findUnique.mockResolvedValue(baseReturn);
      const rejectedReturn = {
        ...baseReturn,
        status: ReturnStatus.REJECTED,
        rejectionReason: 'Item shows signs of extensive customer use',
      };
      mockPrisma.return.update.mockResolvedValue(rejectedReturn);

      const result = await returnService.rejectReturn(baseReturn.id, adminUser, {
        rejectionReason: 'Item shows signs of extensive customer use',
      });

      expect(result.status).toBe(ReturnStatus.REJECTED);
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: AuditAction.RETURN_REJECTED,
          }),
        }),
      );
    });

    it('requires a substantive rejection reason (>= 5 chars)', async () => {
      await expect(
        returnService.rejectReturn(baseReturn.id, adminUser, {
          rejectionReason: 'No',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ===========================================================================
  // 4. RECEIVE RETURN
  // ===========================================================================

  describe('receiveReturn', () => {
    it('records dock receipt and scanned quantity', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.APPROVED,
      });
      mockPrisma.return.update.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.RECEIVED,
        receivedAt: new Date(),
      });

      const result = await returnService.receiveReturn(baseReturn.id, inspectorUser, {
        receivedQuantities: { 'order-item-1': 1 },
        notes: 'Outer parcel received in good condition',
      });

      expect(result.status).toBe(ReturnStatus.RECEIVED);
      expect(mockPrisma.returnItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            receivedQuantity: 1,
          }),
        }),
      );
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: AuditAction.RETURN_RECEIVED,
          }),
        }),
      );
    });

    it('throws if received quantity exceeds requested quantity', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.APPROVED,
      });

      await expect(
        returnService.receiveReturn(baseReturn.id, inspectorUser, {
          receivedQuantities: { 'order-item-1': 5 }, // requested was 1
        }),
      ).rejects.toThrow('cannot exceed requested quantity');
    });
  });

  // ===========================================================================
  // 5. INSPECT RETURN & REFUND INTEGRATION
  // ===========================================================================

  describe('inspectReturn', () => {
    it('inspects items, calculates pro-rata refund, and dispatches refund safely', async () => {
      const receivedReturn = {
        ...baseReturn,
        status: ReturnStatus.RECEIVED,
        items: [
          {
            ...baseReturn.items[0],
            receivedQuantity: 1,
          },
        ],
        order: baseOrder,
      };

      mockPrisma.return.findUnique.mockResolvedValue(receivedReturn);
      mockPrisma.return.update
        .mockResolvedValueOnce({
          ...receivedReturn,
          status: ReturnStatus.ACCEPTED,
          eligibleRefundPaise: 90000, // 200,000 lineTotal - 20,000 discount share = 180,000 net; 1 of 2 = 90,000 paise
          idempotencyKey: 'ret_ref_return-uuid-1',
        })
        .mockResolvedValueOnce({
          ...receivedReturn,
          status: ReturnStatus.REFUND_PENDING,
          eligibleRefundPaise: 90000,
        });

      mockPrisma.return.findUniqueOrThrow.mockResolvedValue({
        ...receivedReturn,
        status: ReturnStatus.REFUND_PENDING,
        eligibleRefundPaise: 90000,
      });

      const result = await returnService.inspectReturn(baseReturn.id, inspectorUser, {
        items: [
          {
            orderItemId: 'order-item-1',
            acceptedQuantity: 1,
            rejectedQuantity: 0,
            condition: ReturnItemCondition.DAMAGED_IN_TRANSIT,
            disposition: ReturnItemDisposition.SCRAP_WRITE_OFF,
            notes: 'Broken bottle verified',
          },
        ],
        inspectionNotes: 'Inspection passed for partial return',
      });

      expect(mockRefundService.createRefund).toHaveBeenCalledWith(
        baseOrder.id,
        inspectorUser,
        expect.objectContaining({
          amount: 90000,
          source: RefundSource.RETURN,
          idempotencyKey: 'ret_ref_return-uuid-1',
          returnId: baseReturn.id,
        }),
      );

      expect(result.status).toBe(ReturnStatus.REFUND_PENDING);
      expect(result.eligibleRefundPaise).toBe(90000);
    });

    it('transitions to REJECTED if all items are rejected upon inspection', async () => {
      const receivedReturn = {
        ...baseReturn,
        status: ReturnStatus.RECEIVED,
        items: [{ ...baseReturn.items[0], receivedQuantity: 1 }],
        order: baseOrder,
      };

      mockPrisma.return.findUnique.mockResolvedValue(receivedReturn);
      mockPrisma.return.update.mockResolvedValue({
        ...receivedReturn,
        status: ReturnStatus.REJECTED,
        eligibleRefundPaise: 0,
      });

      const result = await returnService.inspectReturn(baseReturn.id, inspectorUser, {
        items: [
          {
            orderItemId: 'order-item-1',
            acceptedQuantity: 0,
            rejectedQuantity: 1,
            condition: ReturnItemCondition.CUSTOMER_DAMAGED,
            disposition: ReturnItemDisposition.RETURN_TO_CUSTOMER,
            notes: 'Product used and altered by customer',
          },
        ],
      });

      expect(result.status).toBe(ReturnStatus.REJECTED);
      expect(mockRefundService.createRefund).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 6. CANCEL RETURN
  // ===========================================================================

  describe('cancelReturn', () => {
    it('customer can cancel their own REQUESTED return', async () => {
      mockPrisma.return.findUnique.mockResolvedValue(baseReturn);
      mockPrisma.return.update.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.CANCELLED,
      });

      const result = await returnService.cancelReturn(baseReturn.id, customerUser, false);
      expect(result.status).toBe(ReturnStatus.CANCELLED);
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: AuditAction.RETURN_CANCELLED,
          }),
        }),
      );
    });

    it('blocks customer from cancelling someone else return', async () => {
      mockPrisma.return.findUnique.mockResolvedValue(baseReturn);

      await expect(
        returnService.cancelReturn(baseReturn.id, otherCustomerUser, false),
      ).rejects.toThrow(ForbiddenException);
    });

    it('blocks customer from cancelling return once approved or in-transit', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.APPROVED,
      });

      await expect(
        returnService.cancelReturn(baseReturn.id, customerUser, false),
      ).rejects.toThrow(ConflictException);
    });

    it('admin with RETURNS_MANAGE can cancel non-terminal return as an operational override', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.APPROVED,
      });
      mockPrisma.return.update.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.CANCELLED,
      });

      const result = await returnService.cancelReturn(
        baseReturn.id,
        superAdminUser,
        true,
        'Carrier lost parcel',
      );
      expect(result.status).toBe(ReturnStatus.CANCELLED);
    });

    it('cannot cancel return in terminal status (COMPLETED / REJECTED / CANCELLED)', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.COMPLETED,
      });

      await expect(
        returnService.cancelReturn(baseReturn.id, superAdminUser, true),
      ).rejects.toThrow('Cannot cancel return in terminal status');
    });
  });

  // ===========================================================================
  // 7. GET RETURN & IDOR PROTECTION
  // ===========================================================================

  describe('getReturn & IDOR Protection', () => {
    it('customer can view own return', async () => {
      mockPrisma.return.findUnique.mockResolvedValue(baseReturn);

      const result = await returnService.getReturn(baseReturn.id, customerUser, false);
      expect(result.id).toBe(baseReturn.id);
    });

    it('blocks customer from viewing other customer return', async () => {
      mockPrisma.return.findUnique.mockResolvedValue(baseReturn);

      await expect(
        returnService.getReturn(baseReturn.id, otherCustomerUser, false),
      ).rejects.toThrow(ForbiddenException);
    });

    it('admin can view any return', async () => {
      mockPrisma.return.findUnique.mockResolvedValue(baseReturn);

      const result = await returnService.getReturn(baseReturn.id, adminUser, true);
      expect(result.id).toBe(baseReturn.id);
    });
  });

  // ===========================================================================
  // 8. ASYNC RECONCILIATION HOOK
  // ===========================================================================

  describe('onRefundSettled', () => {
    it('advances REFUND_PENDING return to COMPLETED upon settlement confirmation', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.REFUND_PENDING,
      });
      mockPrisma.refund.findFirst.mockResolvedValue({
        id: 'refund-uuid-101',
        returnId: baseReturn.id,
        amount: 90000,
        status: RefundStatus.COMPLETED,
      });

      await returnService.onRefundSettled('ret_ref_return-uuid-1', 90000);

      expect(mockPrisma.return.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: baseReturn.id },
          data: expect.objectContaining({
            status: ReturnStatus.COMPLETED,
            refundedPaise: 90000,
          }),
        }),
      );
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: AuditAction.RETURN_COMPLETED,
          }),
        }),
      );
    });

    it('advances ACCEPTED return to COMPLETED upon settlement confirmation if linked refund exists', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.ACCEPTED,
      });
      mockPrisma.refund.findFirst.mockResolvedValue({
        id: 'refund-uuid-101',
        returnId: baseReturn.id,
        amount: 90000,
        status: RefundStatus.COMPLETED,
      });

      await returnService.onRefundSettled('ret_ref_return-uuid-1', 90000);

      expect(mockPrisma.return.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: baseReturn.id },
          data: expect.objectContaining({
            status: ReturnStatus.COMPLETED,
            refundedPaise: 90000,
          }),
        }),
      );
    });

    it('prevents state regression: does not alter already COMPLETED return (Scenario H)', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.COMPLETED,
        refundedPaise: 90000,
      });
      mockPrisma.refund.findFirst.mockResolvedValue({
        id: 'refund-uuid-101',
        returnId: baseReturn.id,
        amount: 90000,
        status: RefundStatus.COMPLETED,
      });

      await returnService.onRefundSettled('ret_ref_return-uuid-1', 90000);

      expect(mockPrisma.return.update).not.toHaveBeenCalled();
    });

    it('does not advance arbitrary ACCEPTED return if no linked refund exists', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.ACCEPTED,
      });
      mockPrisma.refund.findFirst.mockResolvedValue(null);

      await returnService.onRefundSettled('ret_ref_return-uuid-1', 90000);

      expect(mockPrisma.return.update).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 9. P0 REFUND CRASH RECOVERY & RECONCILIATION
  // ===========================================================================

  describe('reconcileReturnRefund', () => {
    it('Scenario A: crash before createRefund triggers controlled refund initiation', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.ACCEPTED,
        eligibleRefundPaise: 90000,
        refundedPaise: 0,
      });
      mockPrisma.refund.findFirst.mockResolvedValue(null);
      mockRefundService.createRefund.mockResolvedValue({
        id: 'refund-uuid-new',
        status: 'PROCESSING',
        amount: 90000,
      });
      mockPrisma.return.update.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.REFUND_PENDING,
      });

      const res = await returnService.reconcileReturnRefund(baseReturn.id, adminUser);

      expect(mockRefundService.createRefund).toHaveBeenCalledWith(
        baseReturn.orderId,
        expect.anything(),
        expect.objectContaining({
          idempotencyKey: `ret_ref_${baseReturn.id}`,
          amount: 90000,
          returnId: baseReturn.id,
        }),
      );
      expect(mockPrisma.return.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: baseReturn.id },
          data: expect.objectContaining({
            status: ReturnStatus.REFUND_PENDING,
          }),
        }),
      );
      expect(res.status).toBe(ReturnStatus.REFUND_PENDING);
    });

    it('Scenario B: existing Refund in PROCESSING reconciles Return to REFUND_PENDING', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.ACCEPTED,
        eligibleRefundPaise: 90000,
        refundedPaise: 0,
      });
      mockPrisma.refund.findFirst.mockResolvedValue({
        id: 'refund-uuid-existing',
        status: RefundStatus.PROCESSING,
        amount: 90000,
      });
      mockPrisma.return.update.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.REFUND_PENDING,
      });

      const res = await returnService.reconcileReturnRefund(baseReturn.id, adminUser);

      expect(mockRefundService.createRefund).not.toHaveBeenCalled();
      expect(mockPrisma.return.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: baseReturn.id },
          data: expect.objectContaining({
            status: ReturnStatus.REFUND_PENDING,
          }),
        }),
      );
      expect(res.status).toBe(ReturnStatus.REFUND_PENDING);
    });

    it('Scenario C: existing Refund in COMPLETED reconciles Return directly to COMPLETED', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.ACCEPTED,
        eligibleRefundPaise: 90000,
        refundedPaise: 0,
      });
      mockPrisma.refund.findFirst.mockResolvedValue({
        id: 'refund-uuid-existing',
        status: RefundStatus.COMPLETED,
        amount: 90000,
      });
      mockPrisma.return.update.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.COMPLETED,
        refundedPaise: 90000,
      });

      const res = await returnService.reconcileReturnRefund(baseReturn.id, adminUser);

      expect(mockRefundService.createRefund).not.toHaveBeenCalled();
      expect(mockPrisma.return.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: baseReturn.id },
          data: expect.objectContaining({
            status: ReturnStatus.COMPLETED,
            refundedPaise: 90000,
          }),
        }),
      );
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: AuditAction.RETURN_COMPLETED,
          }),
        }),
      );
      expect(res.status).toBe(ReturnStatus.COMPLETED);
    });

    it('Scenario D: Refund in PROCESSING (RECONCILIATION_REQUIRED attempt) leaves Return in REFUND_PENDING (never falsely COMPLETED)', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.ACCEPTED,
        eligibleRefundPaise: 90000,
        refundedPaise: 0,
      });
      mockPrisma.refund.findFirst.mockResolvedValue({
        id: 'refund-uuid-recon',
        status: RefundStatus.PROCESSING,
        amount: 90000,
      });
      mockPrisma.return.update.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.REFUND_PENDING,
      });

      const res = await returnService.reconcileReturnRefund(baseReturn.id, adminUser);

      expect(res.status).toBe(ReturnStatus.REFUND_PENDING);
      expect(mockPrisma.return.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ReturnStatus.REFUND_PENDING,
          }),
        }),
      );
      // Ensure NOT completed
      expect(mockPrisma.auditLog.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: AuditAction.RETURN_COMPLETED,
          }),
        }),
      );
    });

    it('Scenario E & F: duplicate admin retry reuses existing refund and does not call gateway twice', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.REFUND_PENDING,
        eligibleRefundPaise: 90000,
      });
      mockPrisma.refund.findFirst.mockResolvedValue({
        id: 'refund-uuid-existing',
        status: RefundStatus.PROCESSING,
        amount: 90000,
      });

      const res = await returnService.reconcileReturnRefund(baseReturn.id, adminUser);

      expect(mockRefundService.createRefund).not.toHaveBeenCalled();
      expect(res.status).toBe(ReturnStatus.REFUND_PENDING);
    });

    it('Scenario I: repeated reconciliation on COMPLETED return is a safe idempotent no-op', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.COMPLETED,
        refundedPaise: 90000,
      });

      const res = await returnService.reconcileReturnRefund(baseReturn.id, adminUser);

      expect(mockRefundService.createRefund).not.toHaveBeenCalled();
      expect(mockPrisma.return.update).not.toHaveBeenCalled();
      expect(res.status).toBe(ReturnStatus.COMPLETED);
    });

    it('Scenario J: self-heals stuck ACCEPTED return on getReturn read', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.ACCEPTED,
        eligibleRefundPaise: 90000,
      });
      mockPrisma.refund.findFirst.mockResolvedValue({
        id: 'refund-uuid-1',
        status: RefundStatus.COMPLETED,
        amount: 90000,
      });
      mockPrisma.return.update.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.COMPLETED,
        refundedPaise: 90000,
      });

      const res = await returnService.getReturn(baseReturn.id, adminUser, true);

      expect(res.status).toBe(ReturnStatus.COMPLETED);
    });

    it('Scenario K: inspectReturn on already ACCEPTED return self-heals instead of throwing', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.ACCEPTED,
        eligibleRefundPaise: 90000,
      });
      mockPrisma.refund.findFirst.mockResolvedValue({
        id: 'refund-uuid-1',
        status: RefundStatus.COMPLETED,
        amount: 90000,
      });
      mockPrisma.return.update.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.COMPLETED,
        refundedPaise: 90000,
      });

      const res = await returnService.inspectReturn(
        baseReturn.id,
        inspectorUser,
        {
          items: [{
            returnItemId: 'return-item-1',
            condition: ReturnItemCondition.DEFECTIVE_DAMAGED,
            disposition: ReturnItemDisposition.ACCEPTED_RESTOCK,
            acceptedQuantity: 1,
            rejectedQuantity: 0,
          }],
        },
      );

      expect(res.status).toBe(ReturnStatus.COMPLETED);
    });

    it('Scenario L: rejects reconciliation on terminal CANCELLED / REJECTED return', async () => {
      mockPrisma.return.findUnique.mockResolvedValue({
        ...baseReturn,
        status: ReturnStatus.CANCELLED,
      });

      await expect(
        returnService.reconcileReturnRefund(baseReturn.id, adminUser),
      ).rejects.toThrow(ConflictException);
    });
  });
});

