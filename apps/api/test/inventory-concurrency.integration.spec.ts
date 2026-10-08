import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PrismaClient,
  CartStatus,
  ProductStatus,
  ProductVariantStatus,
  CheckoutStatus,
  ReservationStatus,
  InventoryMovementType,
} from '@prisma/client';
import { InventoryService } from '../src/inventory/inventory.service.js';
import { AuditService } from '../src/audit/audit.service.js';

describe('Phase 11: Inventory Concurrency & Stock Integrity — Physical PostgreSQL Integration', () => {
  const testDbUrl =
    process.env['DATABASE_URL_TEST'] ||
    process.env['DATABASE_URL'] ||
    'postgresql://postgres:Hari@950@localhost:5432/vishkaraa_test?schema=public';

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: testDbUrl,
      },
    },
  });

  let inventoryService: InventoryService;
  let testUserId: string;
  let testProductId: string;
  let singleStockVariantId: string;
  let multiStockVariantIdA: string;
  let multiStockVariantIdB: string;
  const createdSessionIds: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();

    const mockAuditService = {
      logEvent: async () => {},
    } as unknown as AuditService;

    inventoryService = new InventoryService(
      prisma as any,
      mockAuditService,
    );

    const timestamp = Date.now();

    // 1. Create test user
    const user = await prisma.user.create({
      data: {
        email: `inv-concur-${timestamp}@vishkaraa.local`,
        passwordHash: 'dummy-hash',
        firstName: 'Inventory',
        lastName: 'Tester',
        role: 'USER',
      },
    });
    testUserId = user.id;

    // 2. Create test product & variants
    const product = await prisma.product.create({
      data: {
        name: `Inventory Test Product ${timestamp}`,
        slug: `inv-test-prod-${timestamp}`,
        status: ProductStatus.ACTIVE,
        category: {
          create: {
            name: `Inv Test Category ${timestamp}`,
            slug: `inv-test-cat-${timestamp}`,
            status: 'ACTIVE',
          },
        },
      },
    });
    testProductId = product.id;

    // Single unit stock variant (for 10-way concurrency test)
    const varSingle = await prisma.productVariant.create({
      data: {
        productId: product.id,
        name: 'Single Unit Variant',
        sku: `INV-1UNIT-${timestamp}`,
        price: 10000,
        currency: 'INR',
        status: ProductVariantStatus.ACTIVE,
      },
    });
    singleStockVariantId = varSingle.id;

    // Multi-unit variants (for deadlock ordering test)
    const varA = await prisma.productVariant.create({
      data: {
        productId: product.id,
        name: 'Deadlock Variant A',
        sku: `INV-DL-A-${timestamp}`,
        price: 15000,
        currency: 'INR',
        status: ProductVariantStatus.ACTIVE,
      },
    });
    multiStockVariantIdA = varA.id;

    const varB = await prisma.productVariant.create({
      data: {
        productId: product.id,
        name: 'Deadlock Variant B',
        sku: `INV-DL-B-${timestamp}`,
        price: 20000,
        currency: 'INR',
        status: ProductVariantStatus.ACTIVE,
      },
    });
    multiStockVariantIdB = varB.id;

    // 3. Set physical inventory on PostgreSQL
    // Ensure rows exist
    await inventoryService.ensureInventoryItem(singleStockVariantId);
    await inventoryService.ensureInventoryItem(multiStockVariantIdA);
    await inventoryService.ensureInventoryItem(multiStockVariantIdB);

    // Initial stock setup: Single has exactly 1 unit
    await prisma.inventoryItem.update({
      where: { variantId: singleStockVariantId },
      data: { onHand: 1, reserved: 0, committed: 0 },
    });

    // Multi variants have 10 units each
    await prisma.inventoryItem.update({
      where: { variantId: multiStockVariantIdA },
      data: { onHand: 10, reserved: 0, committed: 0 },
    });
    await prisma.inventoryItem.update({
      where: { variantId: multiStockVariantIdB },
      data: { onHand: 10, reserved: 0, committed: 0 },
    });
  });

  afterAll(async () => {
    try {
      // Cleanup in reverse foreign key order
      await prisma.inventoryMovement.deleteMany({
        where: {
          variantId: {
            in: [singleStockVariantId, multiStockVariantIdA, multiStockVariantIdB],
          },
        },
      });

      await prisma.inventoryReservation.deleteMany({
        where: {
          variantId: {
            in: [singleStockVariantId, multiStockVariantIdA, multiStockVariantIdB],
          },
        },
      });

      await prisma.inventoryItem.deleteMany({
        where: {
          variantId: {
            in: [singleStockVariantId, multiStockVariantIdA, multiStockVariantIdB],
          },
        },
      });

      if (createdSessionIds.length > 0) {
        await prisma.checkoutItemSnapshot.deleteMany({
          where: { checkoutSessionId: { in: createdSessionIds } },
        });
        await prisma.checkoutSession.deleteMany({
          where: { id: { in: createdSessionIds } },
        });
      }

      await prisma.cartItem.deleteMany({ where: { cart: { userId: testUserId } } });
      await prisma.cart.deleteMany({ where: { userId: testUserId } });

      await prisma.productVariant.deleteMany({
        where: {
          id: { in: [singleStockVariantId, multiStockVariantIdA, multiStockVariantIdB] },
        },
      });
      await prisma.product.deleteMany({ where: { id: testProductId } });
      await prisma.user.deleteMany({ where: { id: testUserId } });
    } catch {
      // Best-effort cleanup
    } finally {
      await prisma.$disconnect();
    }
  });

  it('guarantees exactly 1 winner and 9 safe rejections during 10-way concurrent reservations for a single stock unit', async () => {
    // 1. Create 10 distinct shoppers with their own cart and checkout session
    const sessions = await Promise.all(
      Array.from({ length: 10 }, async (_, idx) => {
        const shopper = await prisma.user.create({
          data: {
            email: `shopper-${idx}-${Date.now()}@vishkaraa.local`,
            passwordHash: 'dummy',
            firstName: `Shopper${idx}`,
            lastName: 'Test',
            role: 'USER',
          },
        });
        const cart = await prisma.cart.create({
          data: {
            userId: shopper.id,
            status: CartStatus.ACTIVE,
            currency: 'INR',
          },
        });
        const s = await prisma.checkoutSession.create({
          data: {
            userId: shopper.id,
            cartId: cart.id,
            status: CheckoutStatus.ACTIVE,
            subtotal: 10000,
            currency: 'INR',
            expiresAt: new Date(Date.now() + 1800 * 1000), // 30 min TTL
          },
        });
        createdSessionIds.push(s.id);
        return s;
      }),
    );

    // 2. Fire 10 concurrent reservation requests simultaneously
    const requests = sessions.map((s) =>
      inventoryService.reserveStock({
        checkoutSessionId: s.id,
        items: [{ variantId: singleStockVariantId, quantity: 1 }],
        expiresAt: s.expiresAt,
        actorId: testUserId,
      }),
    );

    const results = await Promise.allSettled(requests);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Invariant 1: Exactly ONE request succeeds
    expect(fulfilled).toHaveLength(1);

    // Invariant 2: Exactly 9 requests fail safely
    expect(rejected).toHaveLength(9);

    // Invariant 3: All 9 rejected errors are INSUFFICIENT_STOCK
    for (const r of rejected) {
      if (r.status === 'rejected') {
        const err = r.reason as Error;
        expect(err.message).toMatch(/insufficient stock/i);
      }
    }

    // Invariant 4: Check physical database row
    const itemInDb = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: singleStockVariantId },
    });

    expect(itemInDb.onHand).toBe(1);
    expect(itemInDb.reserved).toBe(1);
    expect(itemInDb.committed).toBe(0);

    // Derived available is exactly 0
    const available = itemInDb.onHand - itemInDb.reserved - itemInDb.committed;
    expect(available).toBe(0);

    // Exactly 1 reservation row exists
    const reservationsInDb = await prisma.inventoryReservation.findMany({
      where: { variantId: singleStockVariantId, status: ReservationStatus.PENDING },
    });
    expect(reservationsInDb).toHaveLength(1);
    expect(reservationsInDb[0]!.quantity).toBe(1);

    // Exactly 1 CHECKOUT_RESERVED movement row exists
    const movementsInDb = await prisma.inventoryMovement.findMany({
      where: { variantId: singleStockVariantId, type: InventoryMovementType.CHECKOUT_RESERVED },
    });
    expect(movementsInDb).toHaveLength(1);
    expect(movementsInDb[0]!.quantityDelta).toBe(1);
  });

  it('guarantees deadlock-free execution when concurrent requests lock multiple variants in reverse order', async () => {
    // Session 1 tries to reserve [Variant A, Variant B]
    // Session 2 tries to reserve [Variant B, Variant A]
    const shopper1 = await prisma.user.create({
      data: {
        email: `dl1-${Date.now()}@vishkaraa.local`,
        passwordHash: 'dummy',
        firstName: 'DL1',
        lastName: 'Shopper',
        role: 'USER',
      },
    });
    const cart1 = await prisma.cart.create({
      data: { userId: shopper1.id, status: CartStatus.ACTIVE, currency: 'INR' },
    });
    const session1 = await prisma.checkoutSession.create({
      data: {
        userId: shopper1.id,
        cartId: cart1.id,
        status: CheckoutStatus.ACTIVE,
        subtotal: 35000,
        currency: 'INR',
        expiresAt: new Date(Date.now() + 1800 * 1000),
      },
    });
    createdSessionIds.push(session1.id);

    const shopper2 = await prisma.user.create({
      data: {
        email: `dl2-${Date.now()}@vishkaraa.local`,
        passwordHash: 'dummy',
        firstName: 'DL2',
        lastName: 'Shopper',
        role: 'USER',
      },
    });
    const cart2 = await prisma.cart.create({
      data: { userId: shopper2.id, status: CartStatus.ACTIVE, currency: 'INR' },
    });
    const session2 = await prisma.checkoutSession.create({
      data: {
        userId: shopper2.id,
        cartId: cart2.id,
        status: CheckoutStatus.ACTIVE,
        subtotal: 35000,
        currency: 'INR',
        expiresAt: new Date(Date.now() + 1800 * 1000),
      },
    });
    createdSessionIds.push(session2.id);

    // Request 1: [A, B]
    const req1 = inventoryService.reserveStock({
      checkoutSessionId: session1.id,
      items: [
        { variantId: multiStockVariantIdA, quantity: 2 },
        { variantId: multiStockVariantIdB, quantity: 3 },
      ],
      expiresAt: session1.expiresAt,
      actorId: testUserId,
    });

    // Request 2: [B, A] (deliberately opposite order to induce deadlock if un-sorted)
    const req2 = inventoryService.reserveStock({
      checkoutSessionId: session2.id,
      items: [
        { variantId: multiStockVariantIdB, quantity: 4 },
        { variantId: multiStockVariantIdA, quantity: 1 },
      ],
      expiresAt: session2.expiresAt,
      actorId: testUserId,
    });

    // Both should complete without deadlock
    const [res1, res2] = await Promise.all([req1, req2]);

    expect(res1).toHaveLength(2);
    expect(res2).toHaveLength(2);

    const itemA = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: multiStockVariantIdA },
    });
    const itemB = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: multiStockVariantIdB },
    });

    // Variant A: 2 + 1 = 3 reserved out of 10
    expect(itemA.reserved).toBe(3);
    expect(itemA.onHand - itemA.reserved - itemA.committed).toBe(7);

    // Variant B: 3 + 4 = 7 reserved out of 10
    expect(itemB.reserved).toBe(7);
    expect(itemB.onHand - itemB.reserved - itemB.committed).toBe(3);
  });

  it('guarantees atomic commit of reservations into committed stock on order finalization and idempotent retry', async () => {
    // 1. Create active session and reserve 2 units of Variant A
    const commitShopper = await prisma.user.create({
      data: {
        email: `commit-${Date.now()}@vishkaraa.local`,
        passwordHash: 'dummy',
        firstName: 'Commit',
        lastName: 'Shopper',
        role: 'USER',
      },
    });
    const commitCart = await prisma.cart.create({
      data: { userId: commitShopper.id, status: CartStatus.ACTIVE, currency: 'INR' },
    });
    const session = await prisma.checkoutSession.create({
      data: {
        userId: commitShopper.id,
        cartId: commitCart.id,
        status: CheckoutStatus.ACTIVE,
        subtotal: 30000,
        currency: 'INR',
        expiresAt: new Date(Date.now() + 1800 * 1000),
      },
    });
    createdSessionIds.push(session.id);

    await inventoryService.reserveStock({
      checkoutSessionId: session.id,
      items: [{ variantId: multiStockVariantIdA, quantity: 2 }],
      expiresAt: session.expiresAt,
      actorId: testUserId,
    });

    const itemBefore = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: multiStockVariantIdA },
    });
    const reservedBefore = itemBefore.reserved;
    const committedBefore = itemBefore.committed;

    // 2. Commit inside a transaction with a real PaymentAttempt and Order
    let createdOrderId = '';
    await prisma.$transaction(async (tx) => {
      const attempt = await tx.paymentAttempt.create({
        data: {
          userId: commitShopper.id,
          checkoutSessionId: session.id,
          amount: 30000,
          currency: 'INR',
          status: 'CAPTURED',
          provider: 'MOCK',
          providerOrderId: `po_${Date.now()}`,
          providerPaymentId: `pp_${Date.now()}`,
        },
      });

      const order = await tx.order.create({
        data: {
          orderNumber: `VN-COMMIT-${Date.now().toString().slice(-8)}`,
          userId: commitShopper.id,
          checkoutSessionId: session.id,
          paymentAttemptId: attempt.id,
          status: 'CONFIRMED',
          subtotal: 30000,
          totalAmount: 30000,
          currency: 'INR',
        },
      });
      createdOrderId = order.id;

      await inventoryService.commitReservation(
        session.id,
        order.id,
        commitShopper.id,
        tx,
      );
    });

    const itemAfter = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: multiStockVariantIdA },
    });

    // Reserved decremented by 2, committed incremented by 2
    expect(itemAfter.reserved).toBe(reservedBefore - 2);
    expect(itemAfter.committed).toBe(committedBefore + 2);

    // Reservation row updated to COMMITTED
    const reservation = await prisma.inventoryReservation.findUniqueOrThrow({
      where: {
        checkoutSessionId_variantId: {
          checkoutSessionId: session.id,
          variantId: multiStockVariantIdA,
        },
      },
    });
    expect(reservation.status).toBe(ReservationStatus.COMMITTED);
    expect(reservation.orderId).toBe(createdOrderId);

    // 3. Idempotent Retry: committing again with same orderId is a safe no-op
    await prisma.$transaction(async (tx) => {
      const retryResult = await inventoryService.commitReservation(
        session.id,
        createdOrderId,
        commitShopper.id,
        tx,
      );
      expect(retryResult[0]!.status).toBe(ReservationStatus.COMMITTED);
    });

    // Counts remain unchanged after idempotent retry
    const itemAfterRetry = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: multiStockVariantIdA },
    });
    expect(itemAfterRetry.reserved).toBe(itemAfter.reserved);
    expect(itemAfterRetry.committed).toBe(itemAfter.committed);
  });

  it('guarantees stock restoration to unreserved pool when expired reservations are swept', async () => {
    // 1. Create a session expired in the past
    const expShopper = await prisma.user.create({
      data: {
        email: `exp-${Date.now()}@vishkaraa.local`,
        passwordHash: 'dummy',
        firstName: 'Exp',
        lastName: 'Shopper',
        role: 'USER',
      },
    });
    const expCart = await prisma.cart.create({
      data: { userId: expShopper.id, status: CartStatus.ACTIVE, currency: 'INR' },
    });
    const expiredSession = await prisma.checkoutSession.create({
      data: {
        userId: expShopper.id,
        cartId: expCart.id,
        status: CheckoutStatus.ACTIVE,
        subtotal: 15000,
        currency: 'INR',
        expiresAt: new Date(Date.now() - 60 * 1000), // Expired 1 min ago
      },
    });
    createdSessionIds.push(expiredSession.id);

    // Direct insert of an expired reservation to simulate passed TTL
    const itemBefore = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: multiStockVariantIdA },
    });

    await prisma.inventoryItem.update({
      where: { id: itemBefore.id },
      data: { reserved: itemBefore.reserved + 1 },
    });

    const reservation = await prisma.inventoryReservation.create({
      data: {
        inventoryItemId: itemBefore.id,
        variantId: multiStockVariantIdA,
        checkoutSessionId: expiredSession.id,
        quantity: 1,
        status: ReservationStatus.PENDING,
        expiresAt: new Date(Date.now() - 30 * 1000), // Expired
      },
    });

    // 2. Run the sweeper
    const sweepResult = await inventoryService.expireStaleReservations(50);
    expect(sweepResult.expiredCount).toBeGreaterThanOrEqual(1);

    // 3. Verify reservation is marked EXPIRED and reserved count decremented
    const resAfter = await prisma.inventoryReservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(resAfter.status).toBe(ReservationStatus.EXPIRED);

    const itemAfterSweep = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: itemBefore.id },
    });
    expect(itemAfterSweep.reserved).toBe(itemBefore.reserved); // Decremented back by 1

    // Expiry movement recorded
    const expMovement = await prisma.inventoryMovement.findUnique({
      where: { idempotencyKey: `res_expire_${reservation.id}` },
    });
    expect(expMovement).not.toBeNull();
    expect(expMovement!.type).toBe(InventoryMovementType.RESERVATION_EXPIRED);
    expect(expMovement!.quantityDelta).toBe(-1);
  });

  it('guarantees admin adjustment idempotency and prevents negative on-hand stock', async () => {
    const key = `test-adj-${Date.now()}`;

    // 1. Initial balance
    const itemBefore = await inventoryService.getBalance(multiStockVariantIdA);

    // 2. Positive adjustment (+5 units)
    const adjusted = await inventoryService.adjustStock({
      variantId: multiStockVariantIdA,
      delta: 5,
      reason: 'Warehouse delivery intake',
      idempotencyKey: key,
      actorId: testUserId,
      actorRole: 'ADMIN',
    });

    expect(adjusted.onHand).toBe(itemBefore.onHand + 5);

    // 3. Idempotent call with same idempotencyKey -> safe no-op
    const retryAdjusted = await inventoryService.adjustStock({
      variantId: multiStockVariantIdA,
      delta: 5,
      reason: 'Warehouse delivery intake retry',
      idempotencyKey: key,
      actorId: testUserId,
      actorRole: 'ADMIN',
    });

    expect(retryAdjusted.onHand).toBe(adjusted.onHand);

    // 4. Invariant violation: Attempting to write off stock below active reserved/committed obligations fails
    await expect(
      inventoryService.adjustStock({
        variantId: multiStockVariantIdA,
        delta: -99999, // Exceeds available
        reason: 'Illegal reduction',
        idempotencyKey: `illegal-${Date.now()}`,
        actorId: testUserId,
        actorRole: 'ADMIN',
      }),
    ).rejects.toThrow(/negative on-hand stock/i);
  });

  it('guarantees two-entity lock hierarchy and consistency during concurrent Finalization vs Expiry race', async () => {
    // 1. Setup user, cart, and session for race test
    const raceUser = await prisma.user.create({
      data: {
        email: `race-${Date.now()}@vishkaraa.local`,
        passwordHash: 'dummy',
        firstName: 'Race',
        lastName: 'Shopper',
        role: 'USER',
      },
    });

    const raceCart = await prisma.cart.create({
      data: { userId: raceUser.id, status: CartStatus.ACTIVE, currency: 'INR' },
    });

    // Session expiring right at this boundary
    const raceSession = await prisma.checkoutSession.create({
      data: {
        userId: raceUser.id,
        cartId: raceCart.id,
        status: CheckoutStatus.ACTIVE,
        subtotal: 10000,
        currency: 'INR',
        expiresAt: new Date(Date.now() - 500), // Barely expired
      },
    });
    createdSessionIds.push(raceSession.id);

    // Initial item stock
    const itemBefore = await prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: multiStockVariantIdB },
    });

    // Create reservation for 2 units
    await prisma.inventoryItem.update({
      where: { id: itemBefore.id },
      data: { reserved: itemBefore.reserved + 2 },
    });

    const raceRes = await prisma.inventoryReservation.create({
      data: {
        inventoryItemId: itemBefore.id,
        variantId: multiStockVariantIdB,
        checkoutSessionId: raceSession.id,
        quantity: 2,
        status: ReservationStatus.PENDING,
        expiresAt: raceSession.expiresAt,
      },
    });

    // Prepare simulated Order row
    const raceOrderId = `race-order-${Date.now()}`;
    const racePaymentAttempt = await prisma.paymentAttempt.create({
      data: {
        userId: raceUser.id,
        checkoutSessionId: raceSession.id,
        amount: 10000,
        currency: 'INR',
        status: 'CAPTURED',
        provider: 'MOCK',
        providerOrderId: `po_race_${Date.now()}`,
        providerPaymentId: `pp_race_${Date.now()}`,
      },
    });

    const raceOrder = await prisma.order.create({
      data: {
        id: raceOrderId,
        orderNumber: `VN-RACE-${Date.now().toString().slice(-8)}`,
        userId: raceUser.id,
        checkoutSessionId: raceSession.id,
        paymentAttemptId: racePaymentAttempt.id,
        status: 'CONFIRMED',
        currency: 'INR',
        subtotal: 10000,
        totalAmount: 10000,
      },
    });

    // 2. CONCURRENT RACE: Run commitReservation and expireStaleReservations at the same instant
    const [finalizerOutcome, sweeperOutcome] = await Promise.allSettled([
      prisma.$transaction(async (tx) => {
        return inventoryService.commitReservation(
          raceSession.id,
          raceOrder.id,
          raceUser.id,
          tx,
        );
      }),
      inventoryService.expireStaleReservations(50),
    ]);

    // 3. VERIFY OUTCOMES:
    // Because both follow inventory_items lock FIRST -> inventory_reservations lock SECOND:
    // Exactly ONE outcome is valid:
    // Case A: Finalizer won (status COMMITTED). Sweeper saw status != PENDING or skipped.
    // Case B: Sweeper won (status EXPIRED). Finalizer rejected commit with BadRequestException.
    const resAfterRace = await prisma.inventoryReservation.findUniqueOrThrow({
      where: { id: raceRes.id },
    });

    const itemAfterRace = await prisma.inventoryItem.findUniqueOrThrow({
      where: { id: itemBefore.id },
    });

    if (finalizerOutcome.status === 'fulfilled') {
      // Finalizer won
      expect(resAfterRace.status).toBe(ReservationStatus.COMMITTED);
      expect(resAfterRace.orderId).toBe(raceOrder.id);
      expect(itemAfterRace.committed).toBe(itemBefore.committed + 2);
      expect(itemAfterRace.reserved).toBe(itemBefore.reserved);
    } else {
      // Sweeper won
      expect(finalizerOutcome.reason.message).toMatch(/cannot be committed because it is EXPIRED|has expired/i);
      expect(resAfterRace.status).toBe(ReservationStatus.EXPIRED);
      expect(itemAfterRace.reserved).toBe(itemBefore.reserved); // Restored
      expect(itemAfterRace.committed).toBe(itemBefore.committed); // Not committed
    }

    // Physical CHECK constraint invariants remain unbroken
    expect(itemAfterRace.onHand).toBeGreaterThanOrEqual(itemAfterRace.reserved + itemAfterRace.committed);
    expect(itemAfterRace.reserved).toBeGreaterThanOrEqual(0);
    expect(itemAfterRace.committed).toBeGreaterThanOrEqual(0);
  });
});
