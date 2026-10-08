/**
 * Razorpay Webhook Signature Verification
 *
 * Razorpay signs webhook payloads using HMAC-SHA256 over the raw request body.
 * The signature is passed in the `X-Razorpay-Signature` HTTP header.
 *
 * SECURITY:
 * - Verification MUST use the exact raw request body bytes, not a re-serialised
 *   JSON representation. Any JSON.stringify/parse round-trip will break the HMAC.
 * - Timing-safe comparison is used to prevent timing-oracle attacks.
 * - The webhook secret is read from RAZORPAY_WEBHOOK_SECRET only (never from request data).
 */

import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verifies a Razorpay webhook request.
 *
 * @param rawBody  The raw request body buffer (must be the original bytes from Express).
 * @param signature The value of the X-Razorpay-Signature header.
 * @param secret   The RAZORPAY_WEBHOOK_SECRET value.
 * @returns true if the signature is valid, false otherwise.
 */
export function verifyRazorpayWebhookSignature(
  rawBody: Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!rawBody || !signature || !secret) {
    return false;
  }

  const expectedSignature = createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
  const receivedBuffer = Buffer.from(signature, 'utf8');

  // Buffers must be same length for timingSafeEqual
  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, receivedBuffer);
}
