import { ShipmentStatus } from '@prisma/client';

/**
 * Canonical Shipping Status Mapper
 *
 * Implements Section 6 of Phase 13A Architecture.
 * Maps provider raw tracking statuses into canonical 13-state ShipmentStatus values.
 * Unknown statuses return null to avoid arbitrary domain mutations and trigger reconciliation.
 */

const RAW_STATUS_MAPPING: Record<string, ShipmentStatus> = {
  // READY_TO_SHIP milestones
  MANIFESTED: ShipmentStatus.READY_TO_SHIP,
  MANIFEST_GENERATED: ShipmentStatus.READY_TO_SHIP,
  ORDER_CREATED: ShipmentStatus.READY_TO_SHIP,
  DATA_RECEIVED: ShipmentStatus.READY_TO_SHIP,
  LABEL_GENERATED: ShipmentStatus.READY_TO_SHIP,

  // SHIPPED milestones (First physical carrier custody)
  PICKED_UP: ShipmentStatus.SHIPPED,
  HANDOVER_TO_COURIER: ShipmentStatus.SHIPPED,
  DEPARTED_FACILITY: ShipmentStatus.SHIPPED,
  DISPATCHED: ShipmentStatus.SHIPPED,

  // IN_TRANSIT milestones
  IN_TRANSIT: ShipmentStatus.IN_TRANSIT,
  REACHED_HUB: ShipmentStatus.IN_TRANSIT,
  SORTING_FACILITY: ShipmentStatus.IN_TRANSIT,
  HUB_SCAN: ShipmentStatus.IN_TRANSIT,

  // OUT_FOR_DELIVERY milestones
  OUT_FOR_DELIVERY: ShipmentStatus.OUT_FOR_DELIVERY,
  DISPATCHED_TO_DELIVERY_AGENT: ShipmentStatus.OUT_FOR_DELIVERY,
  WITH_DELIVERY_BOY: ShipmentStatus.OUT_FOR_DELIVERY,

  // DELIVERED milestones (Terminal Success)
  DELIVERED: ShipmentStatus.DELIVERED,
  DELIVERY_CONFIRMED: ShipmentStatus.DELIVERED,
  SIGNED: ShipmentStatus.DELIVERED,

  // DELIVERY_FAILED milestones (Non-Delivery Reports - NDR)
  DELIVERY_FAILED: ShipmentStatus.DELIVERY_FAILED,
  CUSTOMER_UNAVAILABLE: ShipmentStatus.DELIVERY_FAILED,
  RESCHEDULED: ShipmentStatus.DELIVERY_FAILED,
  UNDELIVERED: ShipmentStatus.DELIVERY_FAILED,
  ADDRESS_INCORRECT: ShipmentStatus.DELIVERY_FAILED,

  // RTO_INITIATED milestones
  RTO_INITIATED: ShipmentStatus.RTO_INITIATED,
  RETURNING_TO_ORIGIN: ShipmentStatus.RTO_INITIATED,
  RETURN_TO_SENDER: ShipmentStatus.RTO_INITIATED,

  // RTO_DELIVERED milestones (Terminal Failure - Dock Receipt)
  RTO_DELIVERED: ShipmentStatus.RTO_DELIVERED,
  RETURNED_TO_SENDER: ShipmentStatus.RTO_DELIVERED,
  RETURN_DELIVERED: ShipmentStatus.RTO_DELIVERED,

  // LOST milestones (Terminal Failure)
  LOST: ShipmentStatus.LOST,
  PACKAGE_DAMAGED_DESTROYED: ShipmentStatus.LOST,
  DAMAGED_IN_TRANSIT: ShipmentStatus.LOST,

  // CANCELLED milestones (Terminal)
  CANCELLED_BY_CARRIER: ShipmentStatus.CANCELLED,
  BOOKING_VOIDED: ShipmentStatus.CANCELLED,
  CANCELLED: ShipmentStatus.CANCELLED,
};

/**
 * Normalizes a raw provider status string into a canonical ShipmentStatus.
 *
 * @param rawStatus The external status string reported by the courier
 * @returns Canonical ShipmentStatus, or null if status is unrecognized
 */
export function mapProviderStatusToCanonical(rawStatus: string): ShipmentStatus | null {
  if (!rawStatus || typeof rawStatus !== 'string') {
    return null;
  }

  const normalizedKey = rawStatus
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');

  return RAW_STATUS_MAPPING[normalizedKey] ?? null;
}
