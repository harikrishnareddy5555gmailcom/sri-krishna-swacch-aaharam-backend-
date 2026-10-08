import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';

export interface AuditEventParams {
  actorId: string;
  actorRole: string;
  actorEmail?: string;
  action: string;
  entityType: string;
  entityId: string;
  orderId?: string;     // Order context (for financial audit records)
  userId?: string;      // Affected user (may differ from actor)
  amount?: number;
  currency?: string;
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string;
  correlationId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Sensitive field regex patterns that must be redacted from all audit payloads.
 */
export const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /password/i,
  /hash/i,
  /secret/i,
  /token/i,
  /authorization/i,
  /creditCard/i,
  /cardNumber/i,
  /cvv/i,
  /cvc/i,
  /accessToken/i,
  /refreshToken/i,
  /apiKey/i,
  /privateKey/i,
  /credential/i,
];

/**
 * Checks whether a given property key is sensitive.
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Recursively sanitizes any payload destined for audit logging.
 * Redacts passwords, tokens, hashes, API keys, credentials, and payment data.
 * Safely handles circular references and nested arrays/objects.
 */
export function sanitizeAuditPayload(data: unknown, seen = new WeakSet<object>()): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data !== 'object') {
    return data;
  }

  // Prevent infinite loops on circular structures
  if (seen.has(data)) {
    return '[CIRCULAR]';
  }
  seen.add(data);

  // Arrays
  if (Array.isArray(data)) {
    return data.map((item: unknown) => sanitizeAuditPayload(item, seen));
  }

  // Built-in special objects
  if (data instanceof Date || data instanceof RegExp || data instanceof Error) {
    return data;
  }

  // Generic objects
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (isSensitiveKey(key)) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeAuditPayload(value, seen);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Audit Service — Append-only audit logger.
 *
 * Captures regulatory, security, and administrative state changes.
 * Guaranteed to never update or delete existing audit logs.
 * Sanitizes all payloads at the service boundary.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async logEvent(params: AuditEventParams, tx?: Prisma.TransactionClient): Promise<void> {
    try {
      this.logger.log(
        `[AUDIT] Action: ${params.action} by ${params.actorRole}(${params.actorId}) on ${params.entityType}:${params.entityId}`,
      );

      // Centralized recursive sanitization of all audit payload data
      const sanitizedPrevious =
        params.previousValue !== undefined
          ? sanitizeAuditPayload(params.previousValue)
          : undefined;

      const sanitizedNew =
        params.newValue !== undefined
          ? sanitizeAuditPayload(params.newValue)
          : undefined;

      const sanitizedMetadata =
        params.metadata !== undefined
          ? sanitizeAuditPayload(params.metadata)
          : undefined;

      const client = tx ?? this.prisma;

      // Attempt DB insert if connected
      await client.auditLog.create({
        data: {
          actorId: params.actorId,
          actorRole: params.actorRole,
          actorEmail: params.actorEmail,
          action: params.action,
          entityType: params.entityType,
          entityId: params.entityId,
          orderId: params.orderId,
          userId: params.userId,
          amount: params.amount,
          currency: params.currency,
          previousValue:
            sanitizedPrevious !== undefined
              ? JSON.stringify(sanitizedPrevious)
              : null,
          newValue:
            sanitizedNew !== undefined
              ? JSON.stringify(sanitizedNew)
              : null,
          reason: params.reason,
          correlationId: params.correlationId,
          metadata: sanitizedMetadata
            ? (sanitizedMetadata as Prisma.InputJsonObject)
            : undefined,
        },
      });
    } catch (error) {
      // Never crash the primary business operation if audit write encounters a transient error
      this.logger.warn(
        `Failed to persist audit log record: ${(error as Error).message}`,
      );
    }
  }
}
