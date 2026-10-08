import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { LocalStrategy } from './strategies/local.strategy.js';
import { UsersModule } from '../users/users.module.js';

/**
 * Auth Module
 *
 * Establishes the authentication boundary.
 *
 * Strategy:
 * - Local strategy: email/password login (uses bcrypt comparison)
 * - JWT strategy: validates access tokens on protected routes
 *
 * Token Architecture:
 * - Access token: Short-lived (15m), stored in memory on frontend
 * - Refresh token: Long-lived (7d), stored in httpOnly cookie
 *
 * This module does NOT implement OAuth/social login yet.
 * That is a future phase addition.
 */
import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';

@Module({
  imports: [
    UsersModule,
    AuditModule,
    DatabaseModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') ?? 'fallback-secret-for-dev',
        signOptions: {
          expiresIn: (config.get<string>('JWT_EXPIRES_IN', '15m') ??
            '15m') as unknown as number,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, LocalStrategy],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
