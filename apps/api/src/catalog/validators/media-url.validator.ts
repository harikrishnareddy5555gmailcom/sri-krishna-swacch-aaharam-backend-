import {
  registerDecorator,
  type ValidationOptions,
  type ValidationArguments,
} from 'class-validator';

/**
 * Checks whether an IPv4 address belongs to private, loopback, or link-local ranges.
 */
export function isPrivateOrReservedIp(host: string): boolean {
  // Strip IPv6 brackets if present
  const cleanHost = host.replace(/^\[|\]$/g, '').toLowerCase();

  // Loopback
  if (cleanHost === 'localhost' || cleanHost === '::1' || cleanHost === '0.0.0.0') {
    return true;
  }

  // IPv6 private / link-local
  if (cleanHost.startsWith('fe80:') || cleanHost.startsWith('fc00:') || cleanHost.startsWith('fd00:')) {
    return true;
  }

  // IPv4 regex matching
  const ipv4Match = cleanHost.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octet1 = parseInt(ipv4Match[1] ?? '0', 10);
    const octet2 = parseInt(ipv4Match[2] ?? '0', 10);

    // 127.0.0.0/8 Loopback
    if (octet1 === 127) return true;

    // 10.0.0.0/8 Private network
    if (octet1 === 10) return true;

    // 172.16.0.0/12 Private network
    if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) return true;

    // 192.168.0.0/16 Private network
    if (octet1 === 192 && octet2 === 168) return true;

    // 169.254.0.0/16 Link-local / Cloud Metadata service (AWS, GCP, Azure, DO)
    if (octet1 === 169 && octet2 === 254) return true;

    // 0.0.0.0/8 or 255.255.255.255
    if (octet1 === 0 || octet1 === 255) return true;
  }

  // Metadata hostnames
  if (cleanHost === 'metadata.google.internal' || cleanHost === 'instance-data') {
    return true;
  }

  return false;
}

/**
 * Functional check ensuring URL is safe, non-SSRF, and well-formed.
 */
export function validateSafeMediaUrl(value: string): boolean {
  if (typeof value !== 'string') return false;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  const isProduction = process.env['NODE_ENV'] === 'production';

  // Protocol requirement: strictly https in production; http allowed only in dev/test
  if (isProduction && parsed.protocol !== 'https:') {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return false;
  }

  // Must not embed authentication credentials
  if (parsed.username || parsed.password) {
    return false;
  }

  // Anti-SSRF: Forbid private, loopback, link-local, and cloud metadata IP/host targets
  if (isPrivateOrReservedIp(parsed.hostname)) {
    return false;
  }

  return true;
}

/**
 * Class-validator decorator to ensure media URLs:
 * 1. Are well-formed HTTP/HTTPS URLs
 * 2. Enforce HTTPS in production
 * 3. Prohibit credentials in the URL
 * 4. Forbid loopback, private RFC-1918, link-local, and cloud metadata targets (anti-SSRF)
 * 5. Retain provider independence (S3, Cloudinary, R2, GCS, CDNs all supported)
 */
export function IsValidMediaUrl(validationOptions?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol): void {
    if (typeof propertyName !== 'string') return;
    registerDecorator({
      name: 'isValidMediaUrl',
      target: object.constructor,
      propertyName,
      options: {
        message:
          'Media URL must be a valid public HTTPS URL and cannot target internal or private network addresses (anti-SSRF)',
        ...validationOptions,
      },
      validator: {
        validate(value: unknown, _args: ValidationArguments) {
          if (typeof value !== 'string') return false;
          return validateSafeMediaUrl(value);
        },
      },
    });
  };
}

