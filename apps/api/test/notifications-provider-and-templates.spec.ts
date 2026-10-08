import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  DeliveryStatus,
  NotificationChannel,
  NotificationEventType,
  type EmailInput,
  type SmsInput,
} from '@vishkaraa/types';
import {
  NormalizedProviderError,
  sanitizeProviderErrorMessage,
} from '../src/notifications/providers/notification-provider.interface.js';
import { MockEmailProvider } from '../src/notifications/providers/mock/mock-email.provider.js';
import { MockSmsProvider } from '../src/notifications/providers/mock/mock-sms.provider.js';
import { NotificationProviderRegistry } from '../src/notifications/providers/notification-provider.registry.js';
import { NotificationTemplateRegistry } from '../src/notifications/templates/notification-template.registry.js';
import {
  escapeHtml,
  sanitizeActionUrl,
} from '../src/notifications/templates/notification-template.security.js';
import {
  EVENT_CHANNEL_PREFERENCE_MATRIX,
} from '../src/notifications/notification-domain.constants.js';

describe('Phase 14C — Notification Provider Layer & Code-Managed Templates', () => {
  let emailProvider: MockEmailProvider;
  let smsProvider: MockSmsProvider;
  let providerRegistry: NotificationProviderRegistry;
  let templateRegistry: NotificationTemplateRegistry;

  beforeEach(() => {
    emailProvider = new MockEmailProvider();
    smsProvider = new MockSmsProvider();
    providerRegistry = new NotificationProviderRegistry(emailProvider, smsProvider);
    templateRegistry = new NotificationTemplateRegistry();
  });

  // ==========================================================================
  // 1. PROVIDER ABSTRACTIONS & CONTRACTS
  // ==========================================================================

  describe('1. Provider Contracts & Sanitization', () => {
    it('1.1 should satisfy IEmailProvider contract with gateway acceptance semantics', async () => {
      expect(emailProvider.providerName).toBe('MOCK_EMAIL');
      expect(typeof emailProvider.sendEmail).toBe('function');

      const input: EmailInput = {
        to: 'user@example.com',
        subject: 'Contract Test',
        textBody: 'Testing email contract',
        idempotencyKey: 'idemp-email-contract-1',
      };

      const result = await emailProvider.sendEmail(input);
      expect(result.providerName).toBe('MOCK_EMAIL');
      expect(result.status).toBe(DeliveryStatus.SENT); // Gateway acceptance
      expect(result.providerMessageId).toBe('mock-email-idemp-email-contract-1');
      expect(result.acceptedAt).toBeInstanceOf(Date);
    });

    it('1.2 should satisfy ISmsProvider contract with gateway acceptance semantics', async () => {
      expect(smsProvider.providerName).toBe('MOCK_SMS');
      expect(typeof smsProvider.sendSms).toBe('function');

      const input: SmsInput = {
        to: '+919876543210',
        message: 'Testing SMS contract',
        dltTemplateId: 'DLT-12345',
        idempotencyKey: 'idemp-sms-contract-1',
      };

      const result = await smsProvider.sendSms(input);
      expect(result.providerName).toBe('MOCK_SMS');
      expect(result.status).toBe(DeliveryStatus.SENT);
      expect(result.providerMessageId).toBe('mock-sms-idemp-sms-contract-1');
      expect(result.acceptedAt).toBeInstanceOf(Date);
    });

    it('1.3 should sanitize provider error messages to prevent leakage of credentials or auth headers', () => {
      const leaked =
        'Error connecting: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc api_key=secret-123 Authorization: Bearer xyz Password=secretPass';
      const sanitized = sanitizeProviderErrorMessage(leaked);

      expect(sanitized).not.toContain('secret-123');
      expect(sanitized).not.toContain('secretPass');
      expect(sanitized).toContain('Bearer [REDACTED]');
      expect(sanitized).toContain('api_key=[REDACTED]');

      const error = new NormalizedProviderError({
        providerName: 'TEST_PROVIDER',
        errorCode: 'AUTH_FAILED',
        message: leaked,
        isRetryable: false,
      });

      expect(error.providerName).toBe('TEST_PROVIDER');
      expect(error.errorCode).toBe('AUTH_FAILED');
      expect(error.isRetryable).toBe(false);
      expect(error.sanitizedErrorMessage).not.toContain('secret-123');
    });
  });

  // ==========================================================================
  // 2. MOCK PROVIDER BEHAVIOR & SIMULATION
  // ==========================================================================

  describe('2. Mock Providers Simulation & Inspection', () => {
    it('2.1 MockEmailProvider records accepted sends in memory for test inspection', async () => {
      const input: EmailInput = {
        to: 'customer@example.com',
        subject: 'Order Confirmed',
        textBody: 'Your order is confirmed.',
        htmlBody: '<p>Your order is confirmed.</p>',
        idempotencyKey: 'idemp-email-rec-1',
      };

      await emailProvider.sendEmail(input);

      const sent = emailProvider.getSentEmails();
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('customer@example.com');
      expect(sent[0].idempotencyKey).toBe('idemp-email-rec-1');

      const lookup = emailProvider.getSentEmailByIdempotencyKey('idemp-email-rec-1');
      expect(lookup).toBeDefined();
      expect(lookup?.subject).toBe('Order Confirmed');
    });

    it('2.2 MockEmailProvider supports simulated retryable failure', async () => {
      emailProvider.simulateRetryableFailure(true, 'SMTP 421 Service not available');

      const input: EmailInput = {
        to: 'retry@example.com',
        subject: 'Retry Test',
        textBody: 'Retry body',
        idempotencyKey: 'idemp-email-retry-1',
      };

      await expect(emailProvider.sendEmail(input)).rejects.toThrow(NormalizedProviderError);

      try {
        await emailProvider.sendEmail(input);
      } catch (err: any) {
        expect(err).toBeInstanceOf(NormalizedProviderError);
        expect(err.isRetryable).toBe(true);
        expect(err.errorCode).toBe('CONNECTION_TIMEOUT');
      }
    });

    it('2.3 MockEmailProvider supports simulated permanent failure', async () => {
      emailProvider.simulatePermanentFailure(true, 'Mailbox not found');

      const input: EmailInput = {
        to: 'perm@example.com',
        subject: 'Perm Test',
        textBody: 'Perm body',
        idempotencyKey: 'idemp-email-perm-1',
      };

      try {
        await emailProvider.sendEmail(input);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(NormalizedProviderError);
        expect(err.isRetryable).toBe(false);
        expect(err.errorCode).toBe('MAILBOX_NOT_FOUND');
      }
    });

    it('2.4 MockSmsProvider records accepted sends and supports DLT template identifiers', async () => {
      const input: SmsInput = {
        to: '+919876543210',
        message: 'Vishkaraa: OTP is 123456.',
        dltTemplateId: 'DLT_OTP_1001',
        idempotencyKey: 'idemp-sms-rec-1',
      };

      const result = await smsProvider.sendSms(input);
      expect(result.status).toBe(DeliveryStatus.SENT);

      const messages = smsProvider.getSentMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].dltTemplateId).toBe('DLT_OTP_1001');

      const lookup = smsProvider.getSentMessageByIdempotencyKey('idemp-sms-rec-1');
      expect(lookup?.to).toBe('+919876543210');
    });

    it('2.5 MockSmsProvider supports simulated retryable failure', async () => {
      smsProvider.simulateRetryableFailure(true, 'Rate limit exceeded');

      const input: SmsInput = {
        to: '9876543210',
        message: 'Hello',
        idempotencyKey: 'idemp-sms-retry-1',
      };

      try {
        await smsProvider.sendSms(input);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(NormalizedProviderError);
        expect(err.isRetryable).toBe(true);
        expect(err.errorCode).toBe('GATEWAY_THROTTLED');
      }
    });

    it('2.6 MockSmsProvider supports simulated permanent failure', async () => {
      smsProvider.simulatePermanentFailure(true, 'Invalid recipient mobile format');

      const input: SmsInput = {
        to: '9876543210',
        message: 'Hello',
        idempotencyKey: 'idemp-sms-perm-1',
      };

      try {
        await smsProvider.sendSms(input);
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(NormalizedProviderError);
        expect(err.isRetryable).toBe(false);
        expect(err.errorCode).toBe('INVALID_DESTINATION');
      }
    });
  });

  // ==========================================================================
  // 3. PROVIDER REGISTRY
  // ==========================================================================

  describe('3. Provider Registry', () => {
    it('3.1 should lookup default registered email and SMS providers', () => {
      const email = providerRegistry.getEmailProvider();
      expect(email.providerName).toBe('MOCK_EMAIL');

      const sms = providerRegistry.getSmsProvider();
      expect(sms.providerName).toBe('MOCK_SMS');

      expect(providerRegistry.hasEmailProvider('MOCK_EMAIL')).toBe(true);
      expect(providerRegistry.hasSmsProvider('MOCK_SMS')).toBe(true);
    });

    it('3.2 should fail safely and throw BadRequestException for unsupported providers', () => {
      expect(() => providerRegistry.getEmailProvider('AWS_SES')).toThrow(BadRequestException);
      expect(() => providerRegistry.getSmsProvider('TWILIO')).toThrow(BadRequestException);
      expect(providerRegistry.hasEmailProvider('AWS_SES')).toBe(false);
      expect(providerRegistry.hasSmsProvider('TWILIO')).toBe(false);
    });
  });

  // ==========================================================================
  // 4. CODE-MANAGED TEMPLATES & SECURITY
  // ==========================================================================

  describe('4. Code-Managed Template Registry & Security', () => {
    it('4.1 should have all 14 required Phase 14 event template keys registered', () => {
      const requiredEvents = Object.values(NotificationEventType);
      expect(requiredEvents).toHaveLength(14);

      for (const eventType of requiredEvents) {
        // At least one channel must exist in the template registry for every required event
        const channelRules = EVENT_CHANNEL_PREFERENCE_MATRIX[eventType];
        const supportedChannels = Object.entries(channelRules)
          .filter(([, rule]) => rule.isSupported)
          .map(([channel]) => channel as NotificationChannel);

        expect(supportedChannels.length).toBeGreaterThan(0);

        for (const channel of supportedChannels) {
          expect(
            templateRegistry.hasTemplate(eventType, channel),
            `Missing template for ${eventType} on channel ${channel}`,
          ).toBe(true);
        }
      }
    });

    it('4.2 should enforce explicit template versions and allow version lookup', () => {
      const template = templateRegistry.getTemplate(
        NotificationEventType.ORDER_CONFIRMED,
        NotificationChannel.EMAIL,
        'v1',
      );
      expect(template.version).toBe('v1');
      expect(template.templateKey).toBe(NotificationEventType.ORDER_CONFIRMED);
    });

    it('4.3 should render subject, textBody, and htmlBody where defined', () => {
      const context = {
        customerName: 'Aarav Sharma',
        orderNumber: 'ORD-2026-001',
        totalAmount: '1,499.00',
        actionUrl: '/orders/ORD-2026-001',
      };

      const rendered = templateRegistry.render(
        NotificationEventType.ORDER_CONFIRMED,
        NotificationChannel.EMAIL,
        context,
      );

      expect(rendered.subject).toContain('ORD-2026-001');
      expect(rendered.textBody).toContain('Aarav Sharma');
      expect(rendered.textBody).toContain('₹1,499.00');
      expect(rendered.htmlBody).toBeDefined();
      expect(rendered.htmlBody).toContain('<strong>Aarav Sharma</strong>');
      expect(rendered.htmlBody).toContain('ORD-2026-001');
    });

    it('4.4 should properly escape HTML in dynamic values to prevent XSS (<script>, &, <, >, ", \')', () => {
      const dangerousContext = {
        firstName: '<script>alert("xss")</script> & Co. "quotes" \'single\'',
      };

      const rendered = templateRegistry.render(
        NotificationEventType.AUTH_WELCOME,
        NotificationChannel.EMAIL,
        dangerousContext,
      );

      expect(rendered.htmlBody).not.toContain('<script>');
      expect(rendered.htmlBody).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
      expect(rendered.htmlBody).toContain('&amp; Co.');
      expect(rendered.htmlBody).toContain('&quot;quotes&quot;');
      expect(rendered.htmlBody).toContain('&#39;single&#39;');
    });

    it('4.5 should sanitize action URLs to allow only safe relative application paths', () => {
      // Allowed relative paths
      expect(sanitizeActionUrl('/orders/123')).toBe('/orders/123');
      expect(sanitizeActionUrl('/account/profile', 'https://vishkaraanaturals.com')).toBe(
        'https://vishkaraanaturals.com/account/profile',
      );

      // Disallowed malicious / external URLs
      expect(sanitizeActionUrl('javascript:alert(1)')).toBeNull();
      expect(sanitizeActionUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
      expect(sanitizeActionUrl('//attacker.com/evil')).toBeNull();
      expect(sanitizeActionUrl('https://evil-phishing-site.com')).toBeNull();
      expect(sanitizeActionUrl('http://evil.com')).toBeNull();
      expect(sanitizeActionUrl('not-a-slash/path')).toBeNull();
      expect(sanitizeActionUrl(null)).toBeNull();
    });

    it('4.6 should fail safely and throw BadRequestException on unknown template lookup', () => {
      expect(() =>
        templateRegistry.getTemplate('UNKNOWN_EVENT', NotificationChannel.EMAIL),
      ).toThrow(BadRequestException);

      expect(() =>
        templateRegistry.render('UNKNOWN_EVENT', NotificationChannel.EMAIL, {}),
      ).toThrow(BadRequestException);
    });

    it('4.7 should not execute dynamic strings or eval in template rendering', () => {
      const template = templateRegistry.getTemplate(
        NotificationEventType.AUTH_WELCOME,
        NotificationChannel.EMAIL,
      );

      // Verify template renderers are pure functions without eval
      const textFnStr = template.renderText.toString();
      const htmlFnStr = template.renderHtml?.toString() ?? '';

      expect(textFnStr).not.toContain('eval(');
      expect(textFnStr).not.toContain('new Function(');
      expect(htmlFnStr).not.toContain('eval(');
      expect(htmlFnStr).not.toContain('new Function(');
    });
  });

  // ==========================================================================
  // 5. PROVIDER IDEMPOTENCY BEHAVIOR
  // ==========================================================================

  describe('5. Provider Idempotency Semantics', () => {
    it('5.1 MockEmailProvider receives and caches response deterministically by idempotencyKey', async () => {
      const input: EmailInput = {
        to: 'idemp@example.com',
        subject: 'Idempotency Test',
        textBody: 'First attempt',
        idempotencyKey: 'idemp-duplicate-key-1',
      };

      const firstResult = await emailProvider.sendEmail(input);
      const secondResult = await emailProvider.sendEmail({
        ...input,
        textBody: 'Different attempt text',
      });

      // Same idempotency key produces identical cached result
      expect(firstResult.providerMessageId).toBe(secondResult.providerMessageId);
      expect(firstResult.acceptedAt).toEqual(secondResult.acceptedAt);

      // Only one email record is stored in memory
      expect(emailProvider.getSentEmails()).toHaveLength(1);
    });

    it('5.2 MockSmsProvider receives and caches response deterministically by idempotencyKey', async () => {
      const input: SmsInput = {
        to: '9876543210',
        message: 'SMS Idempotency',
        idempotencyKey: 'idemp-sms-duplicate-key-1',
      };

      const firstResult = await smsProvider.sendSms(input);
      const secondResult = await smsProvider.sendSms(input);

      expect(firstResult.providerMessageId).toBe(secondResult.providerMessageId);
      expect(smsProvider.getSentMessages()).toHaveLength(1);
    });
  });
});
