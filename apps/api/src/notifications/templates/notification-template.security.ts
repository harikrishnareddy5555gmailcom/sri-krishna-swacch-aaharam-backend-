/**
 * Notification Template Security Helpers — Phase 14C
 *
 * Implements HTML escaping and action URL validation to ensure zero XSS
 * or phishing vulnerability in generated notifications.
 */

/**
 * Escapes characters with special meaning in HTML contexts:
 * &, <, >, ", '
 */
export function escapeHtml(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }

  const str = typeof value === 'string' ? value : String(value);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitizes action URLs for notification templates.
 * Enforces that only safe relative application paths are allowed from template data.
 * Prevents javascript:, data:, external open redirects, and protocol-relative links.
 *
 * @param path The relative path (e.g. '/orders/123')
 * @param trustedBaseUrl Optional trusted application base URL (e.g. 'https://vishkaraanaturals.com')
 */
export function sanitizeActionUrl(
  path: string | null | undefined,
  trustedBaseUrl?: string,
): string | null {
  if (!path || typeof path !== 'string') {
    return null;
  }

  const trimmed = path.trim();
  if (!trimmed) {
    return null;
  }

  // Reject javascript:, data:, vbscript: schemes
  if (/^(javascript|data|vbscript):/i.test(trimmed)) {
    return null;
  }

  // Reject protocol-relative URLs (e.g. //evil.com)
  if (trimmed.startsWith('//')) {
    return null;
  }

  // Reject absolute URLs with http/https - only relative paths are permitted from template data
  if (/^https?:\/\//i.test(trimmed)) {
    return null;
  }

  // Must begin with a single forward slash
  if (!trimmed.startsWith('/')) {
    return null;
  }

  // If a trusted base URL is provided, safely compose the full URL
  if (trustedBaseUrl) {
    const cleanBase = trustedBaseUrl.replace(/\/+$/, '');
    return `${cleanBase}${trimmed}`;
  }

  return trimmed;
}
