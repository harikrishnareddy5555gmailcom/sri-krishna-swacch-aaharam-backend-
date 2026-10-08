/**
 * Billing & Invoice Domain Types — Phase 12
 */

export enum InvoiceStatus {
  ISSUED = 'ISSUED',
  CANCELLED = 'CANCELLED',
}

export interface InvoiceItemDto {
  id: string;
  invoiceId: string;
  orderItemId?: string | null;
  productId?: string | null;
  variantId?: string | null;
  productName: string;
  variantName?: string | null;
  productSku: string;
  quantity: number;
  unitPrice: number;
  discountAmount: number;
  taxableAmount: number;
  taxAmount: number;
  lineTotal: number;
  currency: string;
  hsnSac?: string | null;
  taxRate?: number;
  cgstAmount?: number;
  sgstAmount?: number;
  igstAmount?: number;
  cessAmount?: number;
  createdAt: string;
}

export interface InvoiceDto {
  id: string;
  invoiceNumber: string;
  orderId: string;
  userId: string;
  status: InvoiceStatus;
  currency: string;
  subtotal: number;
  discountTotal: number;
  shippingTotal: number;
  taxTotal: number;
  grandTotal: number;

  // Billing address snapshot
  billingName?: string | null;
  billingPhone?: string | null;
  billingLine1?: string | null;
  billingLine2?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingPostalCode?: string | null;
  billingCountry?: string | null;
  billingAddress?: Record<string, unknown> | null;

  // Seller business snapshot
  sellerName: string;
  sellerAddressLine1?: string | null;
  sellerAddressLine2?: string | null;
  sellerCity?: string | null;
  sellerState?: string | null;
  sellerPostalCode?: string | null;
  sellerCountry: string;
  sellerEmail?: string | null;
  sellerPhone?: string | null;
  sellerGstin?: string | null;
  sellerSnapshot?: Record<string, unknown> | null;

  // Future GST extension points
  customerGstin?: string | null;
  placeOfSupply?: string | null;
  isReverseCharge: boolean;
  invoiceType: string;

  issuedAt: string;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  createdAt: string;
  updatedAt: string;

  items?: InvoiceItemDto[];
  orderNumber?: string;
}

export interface AdminInvoiceListQueryDto {
  page?: number | undefined;
  limit?: number | undefined;
  status?: InvoiceStatus | undefined;
  search?: string | undefined;
  orderNumber?: string | undefined;
  userId?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
}

export interface AdminInvoiceListResultDto {
  items: InvoiceDto[];
  total: number;
  page: number;
  limit: number;
}

