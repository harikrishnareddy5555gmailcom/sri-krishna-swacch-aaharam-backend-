import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { Permissions, type ShipmentDto } from '@vishkaraa/types';
import { PermissionsService, type MinimalUser } from '../../permissions/permissions.service.js';
import { ShipmentService } from '../shipping.service.js';
import { ReconcileShipmentDto } from '../dto/reconcile-shipment.dto.js';
import { ShippingQueryDto } from '../dto/shipping-query.dto.js';

@Injectable()
export class ShippingReconciliationService {
  private readonly logger = new Logger(ShippingReconciliationService.name);

  constructor(
    private readonly shipmentService: ShipmentService,
    private readonly permissionsService: PermissionsService,
  ) {}

  /**
   * Asserts the actor holds SHIPPING_RECONCILE permission.
   */
  private async assertReconcilePermission(actor: MinimalUser): Promise<void> {
    const hasPermission = await this.permissionsService.can(
      actor,
      Permissions.SHIPPING_RECONCILE,
    );
    if (!hasPermission) {
      throw new ForbiddenException(
        `Actor ${actor.id} lacks permission ${Permissions.SHIPPING_RECONCILE}`,
      );
    }
  }

  /**
   * Lists all shipments requiring administrative reconciliation.
   */
  async listReconciliationQueue(
    actor: MinimalUser,
    query: ShippingQueryDto,
  ): Promise<{ data: ShipmentDto[]; total: number; page: number; limit: number }> {
    await this.assertReconcilePermission(actor);
    return await this.shipmentService.listReconciliationShipments(query);
  }

  /**
   * Resolves a reconciliation flag on a shipment.
   */
  async reconcileShipment(
    shipmentId: string,
    actor: MinimalUser,
    input: ReconcileShipmentDto,
  ): Promise<ShipmentDto> {
    await this.assertReconcilePermission(actor);

    this.logger.log(
      `[RECONCILIATION] Reconciling shipment ${shipmentId} by ${actor.role}(${actor.id}): ${input.notes}`,
    );

    return await this.shipmentService.resolveReconciliation(
      shipmentId,
      actor,
      input,
    );
  }
}
