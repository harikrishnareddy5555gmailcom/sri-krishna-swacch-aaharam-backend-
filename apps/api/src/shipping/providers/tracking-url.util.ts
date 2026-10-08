import { CarrierCodes } from '../shipping.constants.js';

/**
 * Tracking URL Security & SSRF Protection
 *
 * Implements Section 12 of Phase 13A Architecture:
 * 1. Protocol Restrictions: Only HTTPS or internal relative routes are permitted.
 *    Rejects `http:`, `javascript:`, `data:`, `vbscript:`, and malformed URIs.
 * 2. Domain Allowlists: Validates public courier tracking links against approved patterns.
 * 3. Zero Outbound Fetch: Server-side fetching of external tracking URLs is strictly prohibited.
 */

const CARRIER_URL_ALLOWLIST: Record<string, RegExp[]> = {
  [CarrierCodes.SHIPROCKET]: [
    /^https:\/\/([a-zA-Z0-9-]+\.)*shiprocket\.co\/tracking\/[a-zA-Z0-9_-]+$/i,
  ],
  [CarrierCodes.DELHIVERY]: [
    /^https:\/\/([a-zA-Z0-9-]+\.)*delhivery\.com\/track\/package\/[a-zA-Z0-9_-]+$/i,
  ],
  [CarrierCodes.BLUEDART]: [
    /^https:\/\/([a-zA-Z0-9-]+\.)*bluedart\.com\/tracking\/[a-zA-Z0-9_-]+$/i,
  ],
  MOCK: [
    /^https:\/\/([a-zA-Z0-9-]+\.)*mockcourier\.local\/track\/[a-zA-Z0-9_-]+$/i,
  ],
  [CarrierCodes.MANUAL]: [
    /^\/account\/orders\/[a-zA-Z0-9_-]+\/tracking$/i,
  ],
};

const GENERIC_ALLOWLIST: RegExp[] = [
  /^https:\/\/([a-zA-Z0-9-]+\.)*(shiprocket\.co|delhivery\.com|bluedart\.com|mockcourier\.local)\//i,
  /^\/account\/orders\/[a-zA-Z0-9_-]+\/tracking$/i,
];

/**
 * Validates a tracking URL against strict security allowlists.
 *
 * @param url The tracking URL provided by carrier or operator
 * @param carrierCode Optional carrier code to restrict to carrier-specific pattern
 * @returns true if URL is safe and permitted; false otherwise
 */
export function validateTrackingUrl(url: string, carrierCode?: string): boolean {
  if (!url || typeof url !== 'string') {
    return false;
  }

  const trimmed = url.trim();

  // Reject dangerous pseudo-protocols or unencrypted schemes
  if (
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('vbscript:') ||
    trimmed.startsWith('http://')
  ) {
    return false;
  }

  // Carrier-specific verification
  if (carrierCode && CARRIER_URL_ALLOWLIST[carrierCode]) {
    const rules = CARRIER_URL_ALLOWLIST[carrierCode];
    return rules.some((regex) => regex.test(trimmed));
  }

  // Fallback to generic approved carriers allowlist
  return GENERIC_ALLOWLIST.some((regex) => regex.test(trimmed));
}
