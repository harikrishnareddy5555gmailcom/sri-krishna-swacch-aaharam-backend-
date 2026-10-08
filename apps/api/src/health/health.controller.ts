import {
  Controller,
  Get,
  Version,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../database/prisma.service.js';
import type { ApiResponse, HealthCheckResponse } from '@vishkaraa/types';

/**
 * Health Controller — Production-Hardened Health, Liveness, and Readiness
 *
 * GET /api/v1/health       - Comprehensive health status (returns 503 if degraded)
 * GET /api/v1/health/live  - Minimal process liveness probe
 * GET /api/v1/health/ready - Dependency readiness probe (PostgreSQL connectivity)
 *
 * SECURITY:
 * - Does NOT expose sensitive infrastructure details or credentials.
 * - Exempted from global IP rate limiting (@SkipThrottle) to avoid probe starvation.
 */
@ApiTags('Health')
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('live')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness probe endpoint' })
  getLiveness(): ApiResponse<{ status: 'ok'; timestamp: string }> {
    return {
      success: true,
      data: {
        status: 'ok',
        timestamp: new Date().toISOString(),
      },
      message: 'Application process is responsive',
    };
  }

  @Get('ready')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Readiness probe endpoint' })
  async getReadiness(): Promise<
    ApiResponse<{ status: 'ok'; database: 'ok'; timestamp: string }>
  > {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        success: true,
        data: {
          status: 'ok',
          database: 'ok',
          timestamp: new Date().toISOString(),
        },
        message: 'Application and dependencies ready for traffic',
      };
    } catch {
      throw new ServiceUnavailableException({
        success: false,
        error: {
          code: 'DATABASE_UNAVAILABLE',
          message: 'Database dependency is unreachable',
        },
        message: 'Readiness probe failed',
      });
    }
  }

  @Get()
  @Version('1')
  @ApiOperation({ summary: 'Health check endpoint' })
  async check(): Promise<ApiResponse<HealthCheckResponse>> {
    // Check database connectivity
    let dbStatus: 'ok' | 'error' = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'error';
    }

    const response: HealthCheckResponse = {
      status: dbStatus === 'ok' ? 'ok' : 'degraded',
      version: process.env['npm_package_version'] ?? '0.1.0',
      timestamp: new Date().toISOString(),
      services: {
        database: dbStatus,
      },
    };

    if (dbStatus !== 'ok') {
      throw new ServiceUnavailableException({
        success: false,
        data: response,
        error: {
          code: 'SERVICE_DEGRADED',
          message: 'One or more essential dependencies are degraded',
        },
        message: 'Health check failed: system degraded',
      });
    }

    return {
      success: true,
      data: response,
      message: 'Health check completed',
    };
  }
}
