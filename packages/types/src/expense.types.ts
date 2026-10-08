/**
 * Expense Domain Types — Phase 15C
 */

export enum ExpenseStatus {
  DRAFT = 'DRAFT',
  SUBMITTED = 'SUBMITTED',
  APPROVED = 'APPROVED',
  POSTED = 'POSTED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

export enum ExpensePaymentMethod {
  CASH = 'CASH',
  BANK_TRANSFER = 'BANK_TRANSFER',
  UPI = 'UPI',
  CARD = 'CARD',
  NET_BANKING = 'NET_BANKING',
  CHEQUE = 'CHEQUE',
  OTHER = 'OTHER',
}

export interface ExpenseAttachmentDto {
  id: string;
  expenseId: string;
  fileName: string;
  fileUrl: string;
  fileSize?: number | null;
  mimeType?: string | null;
  uploadedById: string;
  createdAt: Date | string;
}

export interface ExpenseDto {
  id: string;
  expenseNumber: string;
  status: ExpenseStatus;
  category: string;
  vendor: string;
  description: string;
  amountPaise: number;
  currency: string;
  expenseDate: Date | string;
  expenseAccountId?: string | null;
  isPaid: boolean;
  paymentMethod?: ExpensePaymentMethod | null;
  paymentReference?: string | null;
  paymentDate?: Date | string | null;
  receiptUrl?: string | null;
  notes?: string | null;

  submittedById?: string | null;
  submittedAt?: Date | string | null;
  approvedById?: string | null;
  approvedAt?: Date | string | null;
  rejectedById?: string | null;
  rejectedAt?: Date | string | null;
  rejectionReason?: string | null;
  cancelledById?: string | null;
  cancelledAt?: Date | string | null;
  cancellationReason?: string | null;
  postedById?: string | null;
  postedAt?: Date | string | null;

  financeTransactionId?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;

  attachments?: ExpenseAttachmentDto[];
}
