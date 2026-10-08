import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PaymentStatus, OrderStatus } from '@prisma/client';
import { OrderRecoveryService } from '../src/orders/order-recovery.service.js';

describe('OrderRecoveryService — Durable Recovery for Orphaned CAPTURED Payments', () => {
  let recoveryService: OrderRecoveryService;
  let mockPrisma: any;
  let mockOrderService: any;

  const mockAttempt1 = {
    id: 'attempt-orphaned-1',
    userId: 'user-1',
    amount: 50000,
    currency: 'INR',
    status: PaymentStatus.CAPTURED,
    updatedAt: new Date(Date.now() - 60_000), // 60s ago
    order: null,
  };

  const mockAttempt2 = {
    id: 'attempt-orphaned-2',
    userId: 'user-2',
    amount: 120000,
    currency: 'INR',
    status: PaymentStatus.CAPTURED,
    updatedAt: new Date(Date.now() - 45_000), // 45s ago
    order: null,
  };

  const mockFinalizedOrder1 = {
    id: 'order-rec-1',
    orderNumber: 'VN-202609-REC00001',
    status: OrderStatus.CONFIRMED,
  };

  const mockFinalizedOrder2 = {
    id: 'order-rec-2',
    orderNumber: 'VN-202609-REC00002',
    status: OrderStatus.CONFIRMED,
  };

  beforeEach(() => {
    mockPrisma = {
      paymentAttempt: {
        findMany: vi.fn(),
      },
    };

    mockOrderService = {
      finalizeFromPayment: vi.fn(),
    };

    recoveryService = new OrderRecoveryService(mockPrisma, mockOrderService);
  });

  it('scans and recovers all orphaned CAPTURED payment attempts using finalizeFromPayment', async () => {
    mockPrisma.paymentAttempt.findMany.mockResolvedValueOnce([mockAttempt1, mockAttempt2]);
    mockOrderService.finalizeFromPayment
      .mockResolvedValueOnce(mockFinalizedOrder1)
      .mockResolvedValueOnce(mockFinalizedOrder2);

    const result = await recoveryService.recoverOrphanedCapturedPayments(30_000, 50);

    expect(result.scanned).toBe(2);
    expect(result.recovered).toBe(2);
    expect(result.failed).toBe(0);

    expect(mockPrisma.paymentAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: PaymentStatus.CAPTURED,
          order: null,
        }),
        orderBy: { createdAt: 'asc' },
        take: 50,
      }),
    );

    expect(mockOrderService.finalizeFromPayment).toHaveBeenCalledWith('attempt-orphaned-1');
    expect(mockOrderService.finalizeFromPayment).toHaveBeenCalledWith('attempt-orphaned-2');
  });

  it('returns scanned: 0 when no orphaned CAPTURED attempts exist', async () => {
    mockPrisma.paymentAttempt.findMany.mockResolvedValueOnce([]);

    const result = await recoveryService.recoverOrphanedCapturedPayments();

    expect(result.scanned).toBe(0);
    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(0);
    expect(mockOrderService.finalizeFromPayment).not.toHaveBeenCalled();
  });

  it('handles individual attempt failure gracefully and continues recovering remaining attempts', async () => {
    mockPrisma.paymentAttempt.findMany.mockResolvedValueOnce([mockAttempt1, mockAttempt2]);
    mockOrderService.finalizeFromPayment
      .mockRejectedValueOnce(new Error('Integrity check failed: snapshot missing'))
      .mockResolvedValueOnce(mockFinalizedOrder2);

    const result = await recoveryService.recoverOrphanedCapturedPayments(30_000);

    expect(result.scanned).toBe(2);
    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(1);

    expect(mockOrderService.finalizeFromPayment).toHaveBeenCalledTimes(2);
    expect(mockOrderService.finalizeFromPayment).toHaveBeenCalledWith('attempt-orphaned-2');
  });

  it('handleCronRecovery runs sweep and does not throw if sweep encounters an error', async () => {
    mockPrisma.paymentAttempt.findMany.mockRejectedValueOnce(
      new Error('Database connectivity error'),
    );

    await expect(recoveryService.handleCronRecovery()).resolves.toBeUndefined();
  });

  it('is strictly idempotent on repeated recovery runs', async () => {
    // First run recovers mockAttempt1
    mockPrisma.paymentAttempt.findMany.mockResolvedValueOnce([mockAttempt1]);
    mockOrderService.finalizeFromPayment.mockResolvedValueOnce(mockFinalizedOrder1);

    const result1 = await recoveryService.recoverOrphanedCapturedPayments();
    expect(result1.recovered).toBe(1);

    // Second run finds no orphaned attempts because order was created
    mockPrisma.paymentAttempt.findMany.mockResolvedValueOnce([]);

    const result2 = await recoveryService.recoverOrphanedCapturedPayments();
    expect(result2.scanned).toBe(0);
    expect(result2.recovered).toBe(0);
  });
});
