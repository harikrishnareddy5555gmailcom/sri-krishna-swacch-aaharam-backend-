import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import type { ApiErrorResponse } from '@vishkaraa/types';

/**
 * Global All Exceptions Filter
 *
 * SECURITY:
 * - Catches all unhandled exceptions
 * - Strips internal paths, stack traces, and database errors in responses
 * - Assigns/preserves X-Correlation-ID for distributed tracing
 * - Logs technical error details on the server safely (without logging auth headers/passwords)
 * - Returns structured ApiErrorResponse
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // Correlation ID tracking
    const correlationId =
      (request.headers['x-correlation-id'] as string) || randomUUID();
    response.setHeader('X-Correlation-ID', correlationId);

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorCode = 'INTERNAL_SERVER_ERROR';
    let errorMessage = 'An unexpected internal error occurred';
    let errorDetails: unknown = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        errorMessage = res;
        errorCode = exception.name.replace('Exception', '').toUpperCase();
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, unknown>;
        errorCode =
          (resObj['error'] as string) ||
          exception.name.replace('Exception', '').toUpperCase();
        errorMessage = (resObj['message'] as string) || exception.message;

        // If validation errors, include details
        if (Array.isArray(resObj['message'])) {
          errorCode = 'VALIDATION_ERROR';
          errorMessage = 'Input validation failed';
          errorDetails = resObj['message'];
        }
      }
    } else if (exception instanceof Error) {
      // Non-HTTP exception (e.g., Prisma error, network error, TypeError)
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      errorCode = 'INTERNAL_ERROR';
      errorMessage =
        process.env['NODE_ENV'] === 'production'
          ? 'An internal error occurred. Please contact support with the correlation ID.'
          : exception.message;
    }

    const statusCode: number = Number(status);

    // In production, strictly sanitize all 5xx responses to avoid leaking internal/database details
    if (statusCode >= 500 && process.env['NODE_ENV'] === 'production') {
      errorMessage = 'An internal error occurred. Please contact support with the correlation ID.';
      errorDetails = undefined;
    }

    // Server-side audit log for server errors or client errors
    if (statusCode >= 500) {
      if (exception instanceof Error) {
        this.logger.error(
          `[${correlationId}] Server Error ${statusCode} on ${request.method} ${request.url}: ${exception.message}`,
          exception.stack,
        );
      } else {
        this.logger.error(
          `[${correlationId}] Server Error ${statusCode} on ${request.method} ${request.url}: ${String(exception)}`,
        );
      }
    } else if (statusCode >= 400) {
      this.logger.warn(
        `[${correlationId}] Client Error ${statusCode} on ${request.method} ${request.url} - ${errorMessage}`,
      );
    }

    const errorPayload: ApiErrorResponse = {
      success: false,
      error: {
        code: errorCode,
        message: errorMessage,
        ...(errorDetails ? { details: errorDetails } : {}),
      },
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.status(status).json(errorPayload);
  }
}
