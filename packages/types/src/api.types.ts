/**
 * API Types
 *
 * Standard shapes for API requests and responses.
 * These ensure consistent API contracts between frontend and backend.
 */

/**
 * Standard API success response wrapper.
 */
export interface ApiResponse<T = unknown> {
  success: true;
  data: T;
  message?: string;
  meta?: PaginationMeta;
}

/**
 * Standard API error response wrapper.
 */
export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: string;
  path?: string;
}

/**
 * Pagination metadata included in list responses.
 */
export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Standard pagination query parameters.
 */
export interface PaginationQuery {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/**
 * Health check response structure.
 */
export interface HealthCheckResponse {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  timestamp: string;
  services: {
    database: 'ok' | 'error';
    // Add more services as needed
  };
}
