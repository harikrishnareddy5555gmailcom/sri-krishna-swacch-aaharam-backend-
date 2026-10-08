import type { OrderStatus } from '@vishkaraa/types';

export interface AdminOrderListQuery {
  page?: number;
  limit?: number;
  status?: OrderStatus;
  search?: string;
  userId?: string;
  fromDate?: string;
  toDate?: string;
}

export interface UserOrderListQuery {
  page?: number;
  limit?: number;
  status?: OrderStatus;
}
