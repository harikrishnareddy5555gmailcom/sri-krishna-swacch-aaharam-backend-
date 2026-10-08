import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/**
 * Database Module
 *
 * Provides PrismaService globally to all modules.
 * @Global() ensures we don't need to import DatabaseModule in every module.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
