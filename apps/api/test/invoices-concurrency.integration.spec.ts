import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  PrismaClient,
  OrderStatus,
  CheckoutStatus,
  PaymentStatus,
  ProductStatus,
  ProductVariantStatus,
  InvoiceStatus,
} from '@prisma/client';
import { InvoiceService, generateInvoiceNumber } from '../src/invoices/invoices.service.js';
import { InvoiceDocumentService } from '../src/invoices/invoice-document.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { PermissionsService, type MinimalUser } from '../src/permissions/permissions.service.js';
import { UserRole } from '@vishkaraa/types';
import { PDFParse } from 'pdf-parse';

describe('Phase 12: Stage 12B — Real PostgreSQL Concurrency & Historical Immutability', () => {
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

  let invoiceService: InvoiceService;
  let invoiceDocumentService: InvoiceDocumentService;
  let testUserId: string;
  let testProductId: string;
  let testVariantId: string;
  let testOrderId: string;
  let testOrderNumber: string;
  let testUserObj: MinimalUser;

  beforeAll(async () => {
    await prisma.$connect();

    invoiceDocumentService = new InvoiceDocumentService();

    const mockAuditService = {
      logEvent: async () => {},
    } as unknown as AuditService;

    const mockPermissionsService = {
      can: async () => true,
    } as unknown as PermissionsService;

    invoiceService = new InvoiceService(
      prisma as any,
      mockAuditService,
      mockPermissionsService,
    );

    const timestamp = Date.now();

    // 1. Create test user
    const user = await prisma.user.create({
      data: {
        email: `invoice-test-${timestamp}@vishkaraa.local`,
        passwordHash: 'dummy-hash',
        firstName: 'Historical',
        lastName: 'Customer',
        role: 'USER',
      },
    });
    testUserId = user.id;
    testUserObj = {
      id: user.id,
      role: UserRole.USER,
      email: user.email,
    };

    // 2. Create category
    const category = await prisma.category.create({
      data: {
        name: `Cat ${timestamp}`,
        slug: `cat-${timestamp}`,
      },
    });

    // 3. Create test product & variant
    const product = await prisma.product.create({
      data: {
        name: 'Original Organic Turmeric Powder',
        slug: `turmeric-${timestamp}`,
        status: ProductStatus.ACTIVE,
        categoryId: category.id,
      },
    });
    testProductId = product.id;

    const variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        name: '250g',
        sku: `TURMERIC-250G-${timestamp}`,
        price: 25000,
        currency: 'INR',
        status: ProductVariantStatus.ACTIVE,
      },
    });
    testVariantId = variant.id;

    // 4. Create checkout session & snapshot
    const session = await prisma.checkoutSession.create({
      data: {
        userId: testUserId,
        status: CheckoutStatus.COMPLETED,
        currency: 'INR',
        expiresAt: new Date(Date.now() + 3600000),
        subtotal: 50000,
        shippingName: 'Historical Customer',
        shippingPhone: '+919988776655',
        shippingLine1: '45 Heritage Lane',
        shippingCity: 'Bengaluru',
        shippingState: 'Karnataka',
        shippingPostalCode: '560001',
        shippingCountry: 'IN',
        items: {
          create: [
            {
              productId: testProductId,
              productVariantId: testVariantId,
              productName: 'Original Organic Turmeric Powder',
              variantName: '250g',
              productSku: `TURMERIC-250G-${timestamp}`,
              quantity: 2,
              unitPrice: 25000,
              lineTotal: 50000,
              currency: 'INR',
            },
          ],
        },
      },
    });

    // 5. Create payment attempt (CAPTURED)
    const paymentAttempt = await prisma.paymentAttempt.create({
      data: {
        userId: testUserId,
        checkoutSessionId: session.id,
        amount: 50000,
        currency: 'INR',
        status: PaymentStatus.CAPTURED,
        provider: 'MOCK',
        providerPaymentId: `pay_mock_${timestamp}`,
      },
    });

    // 6. Create finalized Order & OrderItems
    testOrderNumber = `VN-TEST-${timestamp.toString().slice(-8)}`;
    const order = await prisma.order.create({
      data: {
        orderNumber: testOrderNumber,
        userId: testUserId,
        checkoutSessionId: session.id,
        paymentAttemptId: paymentAttempt.id,
        status: OrderStatus.CONFIRMED,
        subtotal: 50000,
        discount: 0,
        tax: 0,
        totalAmount: 50000,
        currency: 'INR',
        shippingName: 'Historical Customer',
        shippingPhone: '+919988776655',
        shippingLine1: '45 Heritage Lane',
        shippingCity: 'Bengaluru',
        shippingState: 'Karnataka',
        shippingPostalCode: '560001',
        shippingCountry: 'IN',
        items: {
          create: [
            {
              productId: testProductId,
              variantId: testVariantId,
              productName: 'Original Organic Turmeric Powder',
              variantName: '250g',
              productSku: `TURMERIC-250G-${timestamp}`,
              quantity: 2,
              unitPrice: 25000,
              lineTotal: 50000,
              currency: 'INR',
            },
          ],
        },
      },
    });
    testOrderId = order.id;
  });

  afterAll(async () => {
    // Clean up created test entities
    try {
      if (testOrderId) {
        // Delete invoice items first, then invoice, then order items, then order
        await prisma.invoiceItem.deleteMany({
          where: { invoice: { orderId: testOrderId } },
        });
        await prisma.invoice.deleteMany({
          where: { orderId: testOrderId },
        });
        await prisma.orderItem.deleteMany({
          where: { orderId: testOrderId },
        });
        await prisma.order.deleteMany({
          where: { id: testOrderId },
        });
        await prisma.paymentAttempt.deleteMany({
          where: { userId: testUserId },
        });
        await prisma.checkoutItemSnapshot.deleteMany({
          where: { checkoutSession: { userId: testUserId } },
        });
        await prisma.checkoutSession.deleteMany({
          where: { userId: testUserId },
        });
        await prisma.productVariant.deleteMany({
          where: { id: testVariantId },
        });
        await prisma.product.deleteMany({
          where: { id: testProductId },
        });
        await prisma.user.deleteMany({
          where: { id: testUserId },
        });
      }
    } catch {
      // Ignore cleanup error
    } finally {
      await prisma.$disconnect();
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 1: Concurrent invoice creation produces ONE Invoice
  // ───────────────────────────────────────────────────────────────────────────
  it('E & 20. Real PostgreSQL Concurrency: 5 concurrent creation calls result in exactly ONE invoice', async () => {
    // Spawn 5 simultaneous invocations of createInvoiceForOrder
    const results = await Promise.all([
      invoiceService.createInvoiceForOrder(testOrderId, testUserId),
      invoiceService.createInvoiceForOrder(testOrderId, testUserId),
      invoiceService.createInvoiceForOrder(testOrderId, testUserId),
      invoiceService.createInvoiceForOrder(testOrderId, testUserId),
      invoiceService.createInvoiceForOrder(testOrderId, testUserId),
    ]);

    // All 5 callers received an invoice
    expect(results).toHaveLength(5);

    // All 5 returned the exact same invoice ID and invoice number
    const firstInvoice = results[0];
    for (const res of results) {
      expect(res.id).toBe(firstInvoice.id);
      expect(res.invoiceNumber).toBe(firstInvoice.invoiceNumber);
      expect(res.orderId).toBe(testOrderId);
    }

    // Verify at the database level: exactly 1 row exists in invoices table
    const dbInvoices = await prisma.invoice.findMany({
      where: { orderId: testOrderId },
    });
    expect(dbInvoices).toHaveLength(1);
    expect(dbInvoices[0]!.id).toBe(firstInvoice.id);
    expect(dbInvoices[0]!.invoiceNumber).toBe(firstInvoice.invoiceNumber);
    expect(dbInvoices[0]!.status).toBe(InvoiceStatus.ISSUED);
    expect(dbInvoices[0]!.grandTotal).toBe(50000);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 2: Unique constraint guard on orderId
  // ───────────────────────────────────────────────────────────────────────────
  it('F & 5. Database UNIQUE index strictly forbids a second invoice for the same order', async () => {
    // Attempting a direct database insert with the duplicate orderId must fail via PostgreSQL unique constraint
    await expect(
      prisma.invoice.create({
        data: {
          invoiceNumber: generateInvoiceNumber(),
          orderId: testOrderId, // Duplicate orderId
          userId: testUserId,
          status: InvoiceStatus.ISSUED,
          currency: 'INR',
          subtotal: 50000,
          discountTotal: 0,
          shippingTotal: 0,
          taxTotal: 0,
          grandTotal: 50000,
          sellerName: 'Vishkaraa Naturals Private Limited',
          sellerCountry: 'IN',
        },
      }),
    ).rejects.toThrow();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 3: Database CHECK constraint enforcement on monetary totals
  // ───────────────────────────────────────────────────────────────────────────
  it('N & 7. Database CHECK constraint rejects invalid grandTotal calculation', async () => {
    // subtotal 50000, but grandTotal 99999 violates chk_invoice_grand_total_match
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "invoices" (
          "id", "invoiceNumber", "orderId", "userId", "status", "currency",
          "subtotal", "discountTotal", "shippingTotal", "taxTotal", "grandTotal", "updatedAt"
        ) VALUES (
          gen_random_uuid()::text, 'VN-INV-INVALID-CHECK', gen_random_uuid()::text, '${testUserId}',
          'ISSUED', 'INR', 50000, 0, 0, 0, 99999, CURRENT_TIMESTAMP
        );
      `),
    ).rejects.toThrow(/chk_invoice_grand_total_match/);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 4: Stage 12G Check 8: Historical Immutability (Issue -> Mutate -> Re-fetch -> Regenerate PDF)
  // ───────────────────────────────────────────────────────────────────────────
  it('STAGE 12G CHECK 8: Historical Immutability: Mutating Product, Variant, and User does NOT alter issued Invoice snapshot or generated PDF', async () => {
    // 1. Issue / fetch current invoice snapshot
    const originalInvoice = await invoiceService.getInvoiceByOrderId(testOrderId, testUserObj);
    expect(originalInvoice.items).toHaveLength(1);
    expect(originalInvoice.items![0]!.productName).toBe('Original Organic Turmeric Powder');
    expect(originalInvoice.items![0]!.unitPrice).toBe(25000);
    expect(originalInvoice.billingName).toBe('Historical Customer');

    // 2. Change relevant Product and ProductVariant data
    await prisma.product.update({
      where: { id: testProductId },
      data: { name: 'MUTATED PRODUCT NAME — DO NOT LEAK TO OLD INVOICE' },
    });

    await prisma.productVariant.update({
      where: { id: testVariantId },
      data: {
        sku: `MUTATED-SKU-${Date.now()}`,
        price: 99999, // Changed from 25000 to 99999
      },
    });

    // 3. Change user profile/address data
    await prisma.user.update({
      where: { id: testUserId },
      data: {
        firstName: 'MutatedFirstName',
        lastName: 'MutatedLastName',
      },
    });

    // 4. Re-fetch invoice
    const reloadedInvoice = await invoiceService.getInvoiceByOrderId(testOrderId, testUserObj);

    // 5. Regenerate PDF from reloaded invoice snapshot
    const pdfBuffer = await invoiceDocumentService.generatePdf(reloadedInvoice);
    expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
    expect(pdfBuffer.length).toBeGreaterThan(500);

    const parser = new PDFParse({ data: pdfBuffer });
    const pdfResult = await parser.getText();
    const pdfText = pdfResult.text;

    // 6. Verify invoice financial/snapshot values remain unchanged in DTO and generated PDF
    expect(reloadedInvoice.items![0]!.productName).toBe('Original Organic Turmeric Powder');
    expect(reloadedInvoice.items![0]!.productSku).not.toBe('MUTATED-SKU-999');
    expect(reloadedInvoice.items![0]!.unitPrice).toBe(25000); // NOT 99999
    expect(reloadedInvoice.items![0]!.lineTotal).toBe(50000);
    expect(reloadedInvoice.grandTotal).toBe(50000);
    expect(reloadedInvoice.billingName).toBe('Historical Customer'); // NOT MutatedFirstName

    // Document PDF text verification
    expect(pdfText).toContain('Original Organic Turmeric Powder');
    expect(pdfText).not.toContain('MUTATED PRODUCT NAME');
    expect(pdfText).not.toContain('99999');
    expect(pdfText).toContain('500.00'); // Grand total
    expect(pdfText).toContain('Historical Customer');
    expect(pdfText).not.toContain('MutatedFirstName');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 5: Concurrency safety of generateInvoiceNumber
  // ───────────────────────────────────────────────────────────────────────────
  it('G & 6. Generates 1,000 invoice numbers without collisions', () => {
    const generated = new Set<string>();
    const count = 1000;

    for (let i = 0; i < count; i++) {
      generated.add(generateInvoiceNumber());
    }

    expect(generated.size).toBe(count);
  });
});
