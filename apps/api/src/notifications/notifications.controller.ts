import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { NotificationService, mapToCustomerNotificationDto } from './notification.service.js';
import { NotificationQueryDto } from './dto/notification-query.dto.js';
import type {
  CustomerNotificationItemDto,
  CustomerNotificationListDto,
  UnreadNotificationCountDto,
  ReadAllNotificationsDto,
} from '@vishkaraa/types';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    role: string;
    email: string;
  };
}

/**
 * Customer Notification Center Controller — Phase 14E
 *
 * Exposes customer-facing endpoints for persistent in-app notifications.
 * All routes require authentication and strictly enforce server-side user ownership.
 *
 * Endpoints:
 * - GET   /notifications              — List paginated notifications for current user (newest first)
 * - GET   /notifications/unread-count — Get count of unread notifications for current user
 * - PATCH /notifications/read-all     — Mark all unread notifications as read for current user
 * - PATCH /notifications/:id/read     — Mark a single notification as read (idempotent, IDOR-safe)
 */
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationService: NotificationService) {}

  /**
   * GET /notifications
   * List notifications for the authenticated user, newest first.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  async getMyNotifications(
    @Req() req: Request,
    @Query() query: NotificationQueryDto,
  ): Promise<CustomerNotificationListDto> {
    const userId = (req as AuthenticatedRequest).user.id;
    return this.notificationService.getCustomerNotificationList(userId, {
      page: query.page,
      limit: query.limit,
      unreadOnly: query.unreadOnly,
    });
  }

  /**
   * GET /notifications/unread-count
   * Return unread notification count for the authenticated user.
   */
  @Get('unread-count')
  @HttpCode(HttpStatus.OK)
  async getUnreadCount(@Req() req: Request): Promise<UnreadNotificationCountDto> {
    const userId = (req as AuthenticatedRequest).user.id;
    const unreadCount = await this.notificationService.getUnreadCount(userId);
    return { unreadCount };
  }

  /**
   * PATCH /notifications/read-all
   * Mark all unread notifications as read for the authenticated user.
   * Placed before :id route to prevent path param collision.
   */
  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  async markAllAsRead(@Req() req: Request): Promise<ReadAllNotificationsDto> {
    const userId = (req as AuthenticatedRequest).user.id;
    const updatedCount = await this.notificationService.markAllAsRead(userId);
    return { updatedCount };
  }

  /**
   * PATCH /notifications/:id/read
   * Mark a single notification as read, validating user ownership.
   */
  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  async markAsRead(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<CustomerNotificationItemDto> {
    const userId = (req as AuthenticatedRequest).user.id;
    const notification = await this.notificationService.markAsRead(id, userId);
    return mapToCustomerNotificationDto(notification);
  }
}
