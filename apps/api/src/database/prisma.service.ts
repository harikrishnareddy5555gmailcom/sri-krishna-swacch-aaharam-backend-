import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma Service
 *
 * Wraps the PrismaClient and manages its lifecycle with NestJS.
 *
 * - Connects to the database when the module initializes
 * - Disconnects gracefully when the module is destroyed
 * - Logs database events in development
 *
 * SECURITY:
 * - Database credentials come from environment variables only (DATABASE_URL)
 * - No credentials are hardcoded
 * - The service is only available through the NestJS DI container
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log:
        process.env['NODE_ENV'] === 'development'
          ? [
              { emit: 'event', level: 'query' },
              { emit: 'stdout', level: 'info' },
              { emit: 'stdout', level: 'warn' },
              { emit: 'stdout', level: 'error' },
            ]
          : [{ emit: 'stdout', level: 'error' }],
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('✅ Database connection established');
    } catch (error) {
      this.logger.warn(
        '⚠️ Failed to connect to database. Ensure PostgreSQL is running and credentials in .env are correct.',
      );
      if (process.env['NODE_ENV'] === 'production') {
        throw error;
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }
}
