import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  RefundStatus,
  RefundAttemptStatus,
  RefundSource,
  RefundType,
  PaymentStatus,
  OrderStatus,
} from '@prisma/client';
import { AuditAction, UserRole } from '@vishkaraa/types';
import { RefundService } from '../src/refunds/refund.service.js';
import {
  AdminRefundsController,
  AdminRefundOperationsController,
} from '../src/refunds/admin-refunds.controller.js';
import { MockPaymentProvider } from '../src/payment/providers/mock-payment.provider.js';
import type { MinimalUser } from '../src/permissions/permissions.service.js';

describe('Refund & Financial Reconciliation Domain — Phase 09B', () => {
  let refundService: RefundService;
  let adminRefundsController: AdminRefundsController;
  let adminRefundOpsController: AdminRefundOperationsController;
  let mockPrisma: any;
  let mockAuditService: any;
  let mockPaymentProvider: MockPaymentProvider;

  const requesterAdmin: MinimalUser = {
    id: 'admin-requester-1',
    role: UserRole.ADMIN,
    email: 'requester@vishkaraa.local',
  };

  const approverAdmin: MinimalUser = {
    id: 'admin-approver-2',
    role: UserRole.ADMIN,
    email: 'approver@vishkaraa.local',
  };

  const superAdmin: MinimalUser = {
    id: 'super-admin-1',
    role: UserRole.SUPER_ADMIN,
    email: 'superadmin@vishkaraa.local',
  };

  const baseOrder = {
    id: 'order-uuid-1',
    orderNumber: 'VN-202609-A1B2C3D4',
    userId: 'customer-uuid-1',
    status: OrderStatus.CONFIRMED,
    totalAmount: 300000, // ₹3,000 in paise
    currency: 'INR',
    paymentAttempt: {
      id: 'attempt-uuid-1',
      userId: 'customer-uuid-1',
      amount: 300000,
      currency: 'INR',
      status: PaymentStatus.CAPTURED,
      provider: 'MOCK',
      providerPaymentId: 'pay_mock_12345',
    },
  };

  const baseRefund = {
    id: 'refund-uuid-1',
    refundNumber: 'RF-202609-00000001',
    orderId: 'order-uuid-1',
    paymentAttemptId: 'attempt-uuid-1',
    userId: 'customer-uuid-1',
    returnId: null,
    source: RefundSource.MANUAL,
    type: RefundType.PARTIAL,
    status: RefundStatus.REQUESTED,
    amount: 250000, // ₹2,500 (> auto-approval threshold 200,000)
    approvedAmount: null,
    refundedAmount: 0,
    currency: 'INR',
    reason: 'Customer returned damaged item',
    notes: 'Packaging was torn',
    requestedById: 'admin-requester-1',
    approvedById: null,
    approvedAt: null,
    rejectedById: null,
    rejectedAt: null,
    rejectionReason: null,
    idempotencyKey: null,
    createdAt: new Date('2026-09-29T11:00:00Z'),
    updatedAt: new Date('2026-09-29T11:00:00Z'),
    attempts: [],
    paymentAttempt: baseOrder.paymentAttempt,
  };

  beforeEach(() => {
    mockPaymentProvider = new MockPaymentProvider();

    mockAuditService = {
      logEvent: vi.fn().mockResolvedValue(undefined),
    };

    mockPrisma = {
      order: {
        findUnique: vi.fn().mockResolvedValue(baseOrder),
      },
      paymentAttempt: {
        findUnique: vi.fn().mockResolvedValue(baseOrder.paymentAttempt),
      },
      refund: {
        findUnique: vi.fn().mockResolvedValue(null),
        findUniqueOrThrow: vi.fn().mockImplementation(({ where }) => {
          return Promise.resolve({
            ...baseRefund,
            id: where.id,
            paymentAttempt: baseOrder.paymentAttempt,
          });
        }),
        findMany: vi.fn().mockResolvedValue([baseRefund]),
        create: vi.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            ...baseRefund,
            ...data,
            id: data.id || 'new-refund-uuid',
            paymentAttempt: baseOrder.paymentAttempt,
            attempts: [],
          }),
        ),
        update: vi.fn().mockImplementation(({ data, where }) =>
          Promise.resolve({
            ...baseRefund,
            ...data,
            id: where.id,
            paymentAttempt: baseOrder.paymentAttempt,
            attempts: [],
          }),
        ),
      },
      refundAttempt: {
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockImplementation(({ where }) =>
          Promise.resolve({
            id: where.id,
            refundId: where.refundId,
            status: RefundAttemptStatus.RECONCILIATION_REQUIRED,
            amount: 50000,
            currency: 'INR',
            attemptNumber: 1,
            provider: 'MOCK',
            providerRefundId: null,
            gatewayErrorCode: null,
            gatewayErrorMessage: null,
            rawResponse: null,
            reconciledAt: null,
            createdAt: new Date(),
          }),
        ),
        create: vi.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: 'attempt-record-uuid-1',
            createdAt: new Date(),
            updatedAt: new Date(),
            gatewayErrorCode: null,
            gatewayErrorMessage: null,
            providerRefundId: null,
            rawResponse: null,
            reconciledAt: null,
            reconciledBy: null,
            ...data,
          }),
        ),
        update: vi.fn().mockImplementation(({ data, where }) =>
          Promise.resolve({
            id: where.id,
            ...data,
          }),
        ),
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({ id: 'audit-log-uuid-1' }),
      },
      $queryRaw: vi.fn().mockImplementation(async (query: any) => {
        const text = query?.sql ?? (Array.isArray(query?.strings) ? query.strings.join('') : String(query));
        if (text.includes('payment_attempts') || text.includes('FOR UPDATE')) {
          return [{ id: 'attempt-uuid-1', amount: 300000, status: 'CAPTURED' }];
        }
        if (text.includes('allocated') || text.includes('refunds')) {
          return [{ allocated: BigInt(0) }];
        }
        return [];
      }),
      $transaction: vi.fn().mockImplementation(async (callbackOrArray: any) => {
        if (typeof callbackOrArray === 'function') {
          const tx = {
            $queryRaw: mockPrisma.$queryRaw,
            refund: mockPrisma.refund,
            refundAttempt: mockPrisma.refundAttempt,
            auditLog: mockPrisma.auditLog,
          };
          return callbackOrArray(tx);
        }
        if (Array.isArray(callbackOrArray)) {
          return Promise.all(callbackOrArray);
        }
        return callbackOrArray;
      }),
    };

    refundService = new RefundService(mockPrisma, mockAuditService, mockPaymentProvider);
    adminRefundsController = new AdminRefundsController(refundService);
    adminRefundOpsController = new AdminRefundOperationsController(refundService);
  });

  // ===========================================================================
  // 1. INPUT VALIDATION & SAFETY GATES
  // ===========================================================================
  describe('Input Validation & Safety Gates', () => {
    it('rejects refund with non-positive amount (0 paise)', async () => {
      await expect(
        refundService.createRefund('order-uuid-1', requesterAdmin, {
          amount: 0,
          reason: 'Valid refund reason here',
          source: RefundSource.MANUAL,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects refund with negative amount', async () => {
      await expect(
        refundService.createRefund('order-uuid-1', requesterAdmin, {
          amount: -5000,
          reason: 'Valid refund reason here',
          source: RefundSource.MANUAL,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects refund with non-integer amount', async () => {
      await expect(
        refundService.createRefund('order-uuid-1', requesterAdmin, {
          amount: 150.5,
          reason: 'Valid refund reason here',
          source: RefundSource.MANUAL,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects refund with reason shorter than 5 characters', async () => {
      await expect(
        refundService.createRefund('order-uuid-1', requesterAdmin, {
          amount: 50000,
          reason: 'Bad',
          source: RefundSource.MANUAL,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when order does not exist', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce(null);

      await expect(
        refundService.createRefund('non-existent-order', requesterAdmin, {
          amount: 50000,
          reason: 'Valid refund reason here',
          source: RefundSource.MANUAL,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects refund if order does not have a CAPTURED payment attempt', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce({
        ...baseOrder,
        paymentAttempt: {
          ...baseOrder.paymentAttempt,
          status: PaymentStatus.FAILED,
        },
      });

      await expect(
        refundService.createRefund('order-uuid-1', requesterAdmin, {
          amount: 50000,
          reason: 'Valid refund reason here',
          source: RefundSource.MANUAL,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects refund if paymentAttempt currency is not INR', async () => {
      mockPrisma.order.findUnique.mockResolvedValueOnce({
        ...baseOrder,
        paymentAttempt: {
          ...baseOrder.paymentAttempt,
          currency: 'USD',
        },
      });

      await expect(
        refundService.createRefund('order-uuid-1', requesterAdmin, {
          amount: 50000,
          reason: 'Valid refund reason here',
          source: RefundSource.MANUAL,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ===========================================================================
  // 2. FINANCIAL INVARIANTS & CONCURRENCY OVER-REFUND PROTECTION
  // ===========================================================================
  describe('Financial Invariants & Over-Refund Protection', () => {
    it('prohibits over-refunding when requested amount exceeds captured balance', async () => {
      await expect(
        refundService.createRefund('order-uuid-1', requesterAdmin, {
          amount: 400000,
          reason: 'Customer requested more than paid',
          source: RefundSource.MANUAL,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('prohibits refund when prior committed/in-flight refunds exhaust the balance', async () => {
      mockPrisma.$queryRaw.mockImplementation(async (query: any) => {
        const text = query?.sql ?? (Array.isArray(query?.strings) ? query.strings.join('') : String(query));
        if (text.includes('payment_attempts') || text.includes('FOR UPDATE')) {
          return [{ id: 'attempt-uuid-1', amount: 300000, status: 'CAPTURED' }];
        }
        if (text.includes('allocated') || text.includes('refunds')) {
          return [{ allocated: BigInt(250000) }]; // ₹2,500 already allocated
        }
        return [];
      });

      // Remaining balance is 300,000 - 250,000 = 50,000 paise (₹500)
      // Requesting 60,000 paise should fail
      await expect(
        refundService.createRefund('order-uuid-1', requesterAdmin, {
          amount: 60000,
          reason: 'Trying to refund more than remaining 500',
          source: RefundSource.MANUAL,
        }),
      ).rejects.toThrow(/OVER_REFUND_PROHIBITED/);
    });

    it('allows partial refund equal to the exact remaining balance', async () => {
      mockPrisma.$queryRaw.mockImplementation(async (query: any) => {
        const text = query?.sql ?? (Array.isArray(query?.strings) ? query.strings.join('') : String(query));
        if (text.includes('payment_attempts') || text.includes('FOR UPDATE')) {
          return [{ id: 'attempt-uuid-1', amount: 300000, status: 'CAPTURED' }];
        }
        if (text.includes('allocated') || text.includes('refunds')) {
          return [{ allocated: BigInt(250000) }]; // ₹2,500 already allocated
        }
        return [];
      });

      mockPrisma.refund.findUniqueOrThrow.mockResolvedValueOnce({
        ...baseRefund,
        amount: 50000,
        status: RefundStatus.COMPLETED,
        refundedAmount: 50000,
        attempts: [],
        paymentAttempt: baseOrder.paymentAttempt,
      });

      // Remaining balance = 50,000 paise (<= 200,000 paise threshold => auto-approves)
      const res = await refundService.createRefund('order-uuid-1', requesterAdmin, {
        amount: 50000,
        reason: 'Refund exact remaining balance',
        source: RefundSource.MANUAL,
      });

      expect(res.amount).toBe(50000);
      expect(res.status).toBe(RefundStatus.COMPLETED);
    });
  });

  // ===========================================================================
  // 3. IDEMPOTENCY
  // ===========================================================================
  describe('Idempotency Gate', () => {
    it('returns existing refund record when duplicate idempotencyKey is submitted', async () => {
      const existingRefund = {
        ...baseRefund,
        idempotencyKey: 'ref_idem_test_key_123',
        amount: 150000,
        status: RefundStatus.COMPLETED,
        refundedAmount: 150000,
        paymentAttempt: baseOrder.paymentAttempt,
      };

      mockPrisma.refund.findUnique.mockResolvedValueOnce(existingRefund);

      const res = await refundService.createRefund('order-uuid-1', requesterAdmin, {
        amount: 150000,
        reason: 'Initial duplicate refund request',
        source: RefundSource.MANUAL,
        idempotencyKey: 'ref_idem_test_key_123',
      });

      expect(res.id).toBe(existingRefund.id);
      expect(res.amount).toBe(150000);
      expect(res.status).toBe(RefundStatus.COMPLETED);
      expect(mockPrisma.refund.create).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 4. AUTO-APPROVAL VS SECONDARY APPROVAL THRESHOLD
  // ===========================================================================
  describe('Auto-Approval vs Secondary Approval Workflow', () => {
    it('auto-approves and dispatches immediately when amount <= threshold (₹2,000 / 200,000 paise)', async () => {
      mockPrisma.refund.findUniqueOrThrow.mockResolvedValueOnce({
        ...baseRefund,
        amount: 100000,
        status: RefundStatus.COMPLETED,
        approvedAmount: 100000,
        refundedAmount: 100000,
        attempts: [],
        paymentAttempt: baseOrder.paymentAttempt,
      });

      // 100,000 paise = ₹1,000 <= 200,000 threshold
      const res = await refundService.createRefund('order-uuid-1', requesterAdmin, {
        amount: 100000,
        reason: 'Customer dissatisfied with small item',
        source: RefundSource.MANUAL,
      });

      expect(res.amount).toBe(100000);
      expect(res.status).toBe(RefundStatus.COMPLETED);
      expect(res.approvedAmount).toBe(100000);
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: AuditAction.REFUND_COMPLETED,
          }),
        }),
      );
    });

    it('creates in REQUESTED state when amount > threshold (₹2,500 / 250,000 paise)', async () => {
      mockPrisma.refund.findUniqueOrThrow.mockResolvedValueOnce({
        ...baseRefund,
        amount: 250000,
        status: RefundStatus.REQUESTED,
        approvedAmount: null,
        refundedAmount: 0,
        attempts: [],
        paymentAttempt: baseOrder.paymentAttempt,
      });

      const res = await refundService.createRefund('order-uuid-1', requesterAdmin, {
        amount: 250000,
        reason: 'Large high-value return requiring secondary sign-off',
        source: RefundSource.MANUAL,
      });

      expect(res.amount).toBe(250000);
      expect(res.status).toBe(RefundStatus.REQUESTED);
      expect(res.approvedAmount).toBeNull();
      expect(res.attempts).toHaveLength(0);
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: AuditAction.REFUND_REQUESTED,
          }),
        }),
      );
    });
  });

  // ===========================================================================
  // 5. DUAL-CONTROL WORKFLOW (APPROVE & REJECT)
  // ===========================================================================
  describe('Dual-Control Workflow (Approve / Reject)', () => {
    it('forbids the requester admin from approving their own refund request', async () => {
      mockPrisma.refund.findUnique.mockResolvedValueOnce({
        ...baseRefund,
        status: RefundStatus.REQUESTED,
        requestedById: requesterAdmin.id,
        paymentAttempt: baseOrder.paymentAttempt,
      });

      await expect(
        refundService.approveRefund('refund-uuid-1', requesterAdmin, {}),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows a different admin to approve a REQUESTED refund', async () => {
      mockPrisma.refund.findUnique.mockResolvedValueOnce({
        ...baseRefund,
        status: RefundStatus.REQUESTED,
        requestedById: requesterAdmin.id,
        paymentAttempt: baseOrder.paymentAttempt,
      });

      mockPrisma.refund.findUniqueOrThrow.mockResolvedValueOnce({
        ...baseRefund,
        status: RefundStatus.COMPLETED,
        approvedById: approverAdmin.id,
        approvedAmount: 250000,
        refundedAmount: 250000,
        paymentAttempt: baseOrder.paymentAttempt,
      });

      const res = await refundService.approveRefund('refund-uuid-1', approverAdmin, {});

      expect(res.status).toBe(RefundStatus.COMPLETED);
      expect(mockAuditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.REFUND_APPROVED,
          actorId: approverAdmin.id,
        }),
      );
    });

    it('rejects approval if refund is not in REQUESTED status', async () => {
      mockPrisma.refund.findUnique.mockResolvedValueOnce({
        ...baseRefund,
        status: RefundStatus.COMPLETED,
        requestedById: requesterAdmin.id,
        paymentAttempt: baseOrder.paymentAttempt,
      });

      await expect(
        refundService.approveRefund('refund-uuid-1', approverAdmin, {}),
      ).rejects.toThrow(BadRequestException);
    });

    it('allows an authorized admin to reject a REQUESTED refund with valid reason', async () => {
      mockPrisma.refund.findUnique.mockResolvedValueOnce({
        ...baseRefund,
        status: RefundStatus.REQUESTED,
        requestedById: requesterAdmin.id,
        paymentAttempt: baseOrder.paymentAttempt,
      });

      const res = await refundService.rejectRefund('refund-uuid-1', approverAdmin, {
        rejectionReason: 'Return policy 30-day window expired',
      });

      expect(res.status).toBe(RefundStatus.REJECTED);
      expect(mockAuditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.REFUND_REJECTED,
          actorId: approverAdmin.id,
        }),
      );
    });

    it('rejects rejection if reason is shorter than 5 characters', async () => {
      mockPrisma.refund.findUnique.mockResolvedValueOnce({
        ...baseRefund,
        status: RefundStatus.REQUESTED,
        requestedById: requesterAdmin.id,
        paymentAttempt: baseOrder.paymentAttempt,
      });

      await expect(
        refundService.rejectRefund('refund-uuid-1', approverAdmin, {
          rejectionReason: 'No',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ===========================================================================
  // 6. CANCELLATION WORKFLOW
  // ===========================================================================
  describe('Refund Cancellation', () => {
    it('cancels a REQUESTED refund before gateway dispatch', async () => {
      mockPrisma.refund.findUnique.mockResolvedValueOnce({
        ...baseRefund,
        status: RefundStatus.REQUESTED,
        paymentAttempt: baseOrder.paymentAttempt,
      });

      const res = await refundService.cancelRefund('refund-uuid-1', requesterAdmin);

      expect(res.status).toBe(RefundStatus.CANCELLED);
      expect(mockAuditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.REFUND_CANCELLED,
        }),
      );
    });

    it('cannot cancel a COMPLETED refund', async () => {
      mockPrisma.refund.findUnique.mockResolvedValueOnce({
        ...baseRefund,
        status: RefundStatus.COMPLETED,
        paymentAttempt: baseOrder.paymentAttempt,
      });

      await expect(
        refundService.cancelRefund('refund-uuid-1', requesterAdmin),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ===========================================================================
  // 7. GATEWAY DISPATCH, ERROR HANDLING & RECONCILIATION
  // ===========================================================================
  describe('Gateway Dispatch & Provider Error Handling', () => {
    it('marks attempt as RECONCILIATION_REQUIRED when gateway throws network timeout', async () => {
      mockPaymentProvider.shouldTimeoutRefund = true;

      mockPrisma.refund.findUniqueOrThrow.mockResolvedValueOnce({
        ...baseRefund,
        amount: 50000,
        status: RefundStatus.PROCESSING,
        attempts: [
          {
            id: 'attempt-record-uuid-1',
            status: RefundAttemptStatus.RECONCILIATION_REQUIRED,
            attemptNumber: 1,
            amount: 50000,
            currency: 'INR',
          },
        ],
        paymentAttempt: baseOrder.paymentAttempt,
      });

      await refundService.createRefund('order-uuid-1', requesterAdmin, {
        amount: 50000,
        reason: 'Refund encountering simulated network timeout',
        source: RefundSource.MANUAL,
      });

      expect(mockPrisma.refundAttempt.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: RefundAttemptStatus.RECONCILIATION_REQUIRED,
          }),
        }),
      );
      expect(mockAuditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.REFUND_RECONCILIATION_REQUIRED,
        }),
      );
    });

    it('marks refund as FAILED when gateway returns permanent failure', async () => {
      mockPaymentProvider.shouldFailRefund = true;
      mockPaymentProvider.refundFailureMessage = 'Bank account frozen by cardholder';

      mockPrisma.refund.findUniqueOrThrow.mockResolvedValueOnce({
        ...baseRefund,
        amount: 50000,
        status: RefundStatus.FAILED,
        attempts: [
          {
            id: 'attempt-record-uuid-1',
            status: RefundAttemptStatus.FAILED,
            attemptNumber: 1,
            amount: 50000,
            currency: 'INR',
          },
        ],
        paymentAttempt: baseOrder.paymentAttempt,
      });

      await refundService.createRefund('order-uuid-1', requesterAdmin, {
        amount: 50000,
        reason: 'Refund encountering simulated gateway rejection',
        source: RefundSource.MANUAL,
      });

      expect(mockPrisma.refundAttempt.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: RefundAttemptStatus.FAILED,
          }),
        }),
      );
    });

    it('allows admin with REFUNDS_RECONCILE to manually resolve RECONCILIATION_REQUIRED attempt to PROCESSED', async () => {
      const ambiguousRefund = {
        ...baseRefund,
        amount: 50000,
        status: RefundStatus.PROCESSING,
        attempts: [
          {
            id: 'attempt-ambiguous-1',
            refundId: 'refund-uuid-1',
            status: RefundAttemptStatus.RECONCILIATION_REQUIRED,
            amount: 50000,
          },
        ],
        paymentAttempt: baseOrder.paymentAttempt,
      };

      mockPrisma.refund.findUnique.mockResolvedValue(ambiguousRefund);

      mockPrisma.refund.findUniqueOrThrow.mockResolvedValueOnce({
        ...ambiguousRefund,
        status: RefundStatus.COMPLETED,
        refundedAmount: 50000,
        attempts: [
          {
            id: 'attempt-ambiguous-1',
            status: RefundAttemptStatus.PROCESSED,
            amount: 50000,
          },
        ],
      });

      await refundService.reconcileRefundAttempt(
        'refund-uuid-1',
        'attempt-ambiguous-1',
        superAdmin,
        {
          resolution: 'PROCESSED',
          notes: 'Confirmed in Razorpay dashboard that refund ref_rzp_99 settled',
        },
      );

      expect(mockPrisma.refundAttempt.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: RefundAttemptStatus.PROCESSED,
            reconciledBy: superAdmin.id,
          }),
        }),
      );
      expect(mockPrisma.refund.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: RefundStatus.COMPLETED,
            refundedAmount: 50000,
          }),
        }),
      );
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: AuditAction.REFUND_RECONCILED,
            actorId: superAdmin.id,
          }),
        }),
      );
    });
  });

  // ===========================================================================
  // 8. ORDER REFUND SUMMARY & BALANCES
  // ===========================================================================
  describe('Order Refund Summary', () => {
    it('computes capturedAmount, totalRefundedAmount, and remainingRefundableBalance correctly', async () => {
      const completedRefund = {
        ...baseRefund,
        id: 'ref-comp-1',
        amount: 100000,
        refundedAmount: 100000,
        status: RefundStatus.COMPLETED,
        attempts: [],
        paymentAttempt: baseOrder.paymentAttempt,
      };

      const requestedRefund = {
        ...baseRefund,
        id: 'ref-req-2',
        amount: 80000,
        refundedAmount: 0,
        status: RefundStatus.REQUESTED,
        attempts: [],
        paymentAttempt: baseOrder.paymentAttempt,
      };

      mockPrisma.order.findUnique.mockResolvedValueOnce({
        ...baseOrder,
        paymentAttempt: {
          ...baseOrder.paymentAttempt,
          amount: 300000,
        },
        refunds: [completedRefund, requestedRefund],
      });

      const summary = await refundService.getRefundsForOrder('order-uuid-1');

      expect(summary.capturedAmount).toBe(300000);
      expect(summary.totalRefundedAmount).toBe(100000);
      expect(summary.remainingRefundableBalance).toBe(120000);
      expect(summary.currency).toBe('INR');
      expect(summary.refunds).toHaveLength(2);
    });
  });

  // ===========================================================================
  // 9. ADMIN CONTROLLER DELEGATION & PARAMS
  // ===========================================================================
  describe('Admin Controller Delegation', () => {
    it('AdminRefundsController.getRefundsForOrder calls service getRefundsForOrder', async () => {
      const spy = vi.spyOn(refundService, 'getRefundsForOrder').mockResolvedValueOnce({
        refunds: [],
        capturedAmount: 300000,
        totalRefundedAmount: 0,
        remainingRefundableBalance: 300000,
        currency: 'INR',
      });

      const res = await adminRefundsController.getRefundsForOrder('order-uuid-1');
      expect(spy).toHaveBeenCalledWith('order-uuid-1');
      expect(res.capturedAmount).toBe(300000);
    });

    it('AdminRefundOperationsController.approveRefund delegates with actor extracted', async () => {
      const spy = vi.spyOn(refundService, 'approveRefund').mockResolvedValueOnce({
        ...baseRefund,
        status: RefundStatus.COMPLETED,
        attempts: [],
      });

      const mockReq: any = {
        user: { id: approverAdmin.id, role: approverAdmin.role, email: approverAdmin.email },
      };

      await adminRefundOpsController.approveRefund(mockReq, 'refund-uuid-1', {});
      expect(spy).toHaveBeenCalledWith(
        'refund-uuid-1',
        expect.objectContaining({ id: approverAdmin.id }),
        {},
      );
    });

    it('AdminRefundOperationsController.rejectRefund delegates with actor extracted and body', async () => {
      const spy = vi.spyOn(refundService, 'rejectRefund').mockResolvedValueOnce({
        ...baseRefund,
        status: RefundStatus.REJECTED,
        attempts: [],
      });

      const mockReq: any = {
        user: { id: approverAdmin.id, role: approverAdmin.role, email: approverAdmin.email },
      };

      await adminRefundOpsController.rejectRefund(mockReq, 'refund-uuid-1', {
        rejectionReason: 'Damaged by customer after delivery',
      });
      expect(spy).toHaveBeenCalledWith(
        'refund-uuid-1',
        expect.objectContaining({ id: approverAdmin.id }),
        expect.objectContaining({ rejectionReason: 'Damaged by customer after delivery' }),
      );
    });

    it('AdminRefundOperationsController.cancelRefund delegates with actor extracted', async () => {
      const spy = vi.spyOn(refundService, 'cancelRefund').mockResolvedValueOnce({
        ...baseRefund,
        status: RefundStatus.CANCELLED,
        attempts: [],
      });

      const mockReq: any = {
        user: { id: requesterAdmin.id, role: requesterAdmin.role, email: requesterAdmin.email },
      };

      await adminRefundOpsController.cancelRefund(mockReq, 'refund-uuid-1');
      expect(spy).toHaveBeenCalledWith(
        'refund-uuid-1',
        expect.objectContaining({ id: requesterAdmin.id }),
      );
    });

    it('AdminRefundOperationsController.reconcileAttempt delegates with actor extracted and body', async () => {
      const spy = vi.spyOn(refundService, 'reconcileRefundAttempt').mockResolvedValueOnce({
        ...baseRefund,
        status: RefundStatus.COMPLETED,
        attempts: [],
      });

      const mockReq: any = {
        user: { id: superAdmin.id, role: superAdmin.role, email: superAdmin.email },
      };

      await adminRefundOpsController.reconcileAttempt(mockReq, 'refund-uuid-1', 'att-1', {
        resolution: 'PROCESSED',
        notes: 'Manually verified with Razorpay support',
      });
      expect(spy).toHaveBeenCalledWith(
        'refund-uuid-1',
        'att-1',
        expect.objectContaining({ id: superAdmin.id }),
        expect.objectContaining({ resolution: 'PROCESSED' }),
      );
    });
  });
});
