import {
  Controller,
  Post,
  Body,
  Get,
  UseGuards,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  Version,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { LocalAuthGuard } from './guards/local-auth.guard.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RequestPhoneOtpDto, VerifyPhoneOtpDto } from './dto/phone-otp.dto.js';
import { GoogleAuthDto } from './dto/google-auth.dto.js';
import type { ApiResponse, AuthResponse, UserRole, UserStatus } from '@vishkaraa/types';
import type { User } from '@prisma/client';

/**
 * Hardened Auth Controller
 *
 * Implements:
 * - Rate limiting against brute force attacks (@Throttle)
 * - Input validation via DTOs (RegisterDto, LoginDto)
 * - httpOnly, SameSite=Strict, Secure cookies for refresh tokens
 * - Token rotation on /refresh
 * - Server-side token revocation on /logout
 * - Replay attack protection
 */
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @Version('1')
  @Throttle({ default: { limit: 5, ttl: 60000 } }) // 5 registration attempts per min
  @ApiOperation({ summary: 'Register a new user account' })
  async register(
    @Body() registerDto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<AuthResponse>> {
    const { user, tokens, refreshToken } =
      await this.authService.register(registerDto);

    this.setRefreshTokenCookie(res, refreshToken);

    return {
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role as UserRole,
          status: user.status as UserStatus,
          createdAt: user.createdAt,
        },
        tokens,
      },
      message: 'Account created successfully',
    };
  }

  @Post('login')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } }) // 5 login attempts per min
  @UseGuards(LocalAuthGuard)
  @ApiOperation({ summary: 'Login with email and password' })
  async login(
    @Body() _loginDto: LoginDto, // Validates shape before reaching guard
    @Req() req: Request & { user: Omit<User, 'passwordHash'> },
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<AuthResponse>> {
    const { authResponse, refreshToken } = await this.authService.login(req.user);

    this.setRefreshTokenCookie(res, refreshToken);

    return {
      success: true,
      data: authResponse,
      message: 'Login successful',
    };
  }

  @Post('phone-otp/request')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Request a 6-digit OTP code for phone login/registration' })
  async requestPhoneOtp(
    @Body() dto: RequestPhoneOtpDto,
  ): Promise<ApiResponse<{ message: string; expiresInSeconds: number }>> {
    const result = await this.authService.requestPhoneOtp(dto.phone);
    return {
      success: true,
      data: {
        message: result.message,
        expiresInSeconds: result.expiresInSeconds,
      },
      message: result.message,
    };
  }

  @Post('phone-otp/verify')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Verify Phone OTP / Firebase Token and authenticate customer' })
  async verifyPhoneOtp(
    @Body() dto: VerifyPhoneOtpDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<AuthResponse>> {
    const { authResponse, refreshToken } = await this.authService.verifyPhoneOtp(dto);
    this.setRefreshTokenCookie(res, refreshToken);
    return {
      success: true,
      data: authResponse,
      message: 'Phone verification successful',
    };
  }

  @Post('google')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Authenticate with Google OAuth 1-Tap / ID Token' })
  async authenticateGoogle(
    @Body() dto: GoogleAuthDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<AuthResponse>> {
    const { authResponse, refreshToken } = await this.authService.authenticateGoogle(dto);
    this.setRefreshTokenCookie(res, refreshToken);
    return {
      success: true,
      data: authResponse,
      message: 'Google authentication successful',
    };
  }

  @Post('logout')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout and revoke active session' })
  async logout(
    @Req() req: Request & { user?: Omit<User, 'passwordHash'> },
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<null>> {
    const rawToken = this.extractRefreshToken(req);
    const userId = req.user?.id;

    if (rawToken) {
      await this.authService.revokeRefreshToken(rawToken, userId);
    }

    // Clear refresh cookie
    res.clearCookie('refresh_token', {
      path: '/api/v1/auth',
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env['NODE_ENV'] === 'production',
    });

    return {
      success: true,
      data: null,
      message: 'Logged out successfully',
    };
  }

  @Post('refresh')
  @Version('1')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60000 } }) // 60 refresh calls per min to prevent 429 during normal navigation/multi-tab use
  @ApiOperation({ summary: 'Rotate and refresh access token via secure cookie' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse<{ accessToken: string; expiresIn: number }>> {
    const rawToken = this.extractRefreshToken(req);

    if (!rawToken) {
      throw new UnauthorizedException('No refresh token provided in session');
    }

    try {
      // Rotate token (revokes old, generates new, verifies replay protection)
      const { accessToken, expiresIn, newRefreshToken } =
        await this.authService.rotateRefreshToken(rawToken);

      // Set rotated refresh token in secure cookie
      this.setRefreshTokenCookie(res, newRefreshToken);

      return {
        success: true,
        data: { accessToken, expiresIn },
        message: 'Token rotated and refreshed successfully',
      };
    } catch (err) {
      // Clear invalid/revoked refresh token cookie so browser does not keep retrying it
      res.clearCookie('refresh_token', {
        path: '/api/v1/auth',
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env['NODE_ENV'] === 'production',
      });
      throw err;
    }
  }

  @Get('profile')
  @Version('1')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  getProfile(
    @Req() req: Request & { user: Omit<User, 'passwordHash'> },
  ): Promise<ApiResponse<Omit<User, 'passwordHash'>>> {
    return Promise.resolve({
      success: true,
      data: req.user,
      message: 'Profile retrieved',
    });
  }

  /**
   * Sets the refresh token in a secure httpOnly cookie.
   * Path is scoped to /api/v1/auth so refresh and logout can both access it.
   */
  private setRefreshTokenCookie(res: Response, token: string): void {
    res.cookie('refresh_token', token, {
      httpOnly: true,
      secure: process.env['NODE_ENV'] === 'production',
      sameSite: 'strict',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
    });
  }

  /**
   * Safely extracts refresh token from parsed cookies or header fallback.
   */
  private extractRefreshToken(req: Request): string | null {
    const cookies = req.cookies as Record<string, string> | undefined;
    if (cookies && typeof cookies['refresh_token'] === 'string') {
      return cookies['refresh_token'];
    }

    // Fallback: parse raw Cookie header if cookie-parser missed it
    const rawCookie = req.headers['cookie'];
    if (rawCookie) {
      const match = rawCookie.match(/refresh_token=([^;]+)/);
      if (match && match[1]) {
        return decodeURIComponent(match[1]);
      }
    }

    return null;
  }
}
