import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InventoryService } from './inventory.service.js';

@Injectable()
export class InventoryRecoveryService {
  private readonly logger = new Logger(InventoryRecoveryService.name);
  private isRunning = false;

  constructor(private readonly inventoryService: InventoryService) {}

  /**
   * Sweeper: scans for expired stock reservations every minute and releases stock.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async handleExpiredReservations(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    try {
      const result = await this.inventoryService.expireStaleReservations(50);
      if (result.expiredCount > 0) {
        this.logger.log(
          `[INVENTORY RECOVERY] Expired and released ${result.expiredCount} stale stock reservations.`,
        );
      }
    } catch (err: unknown) {
      this.logger.error(
        `[INVENTORY RECOVERY] Sweeper failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    } finally {
      this.isRunning = false;
    }
  }
}
