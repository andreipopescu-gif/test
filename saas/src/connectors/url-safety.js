/**
 * Outbound URL checks for MDM connectors. Blocks private/link-local/metadata
 * targets so a tenant-supplied baseUrl cannot turn the server into an SSRF
 * proxy against cloud metadata or the host network.
 */

const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data'
]);

export function normalizeOutboundBaseUrl(value, {
  allowHttpLoopback = true,
  label = 'baseUrl'
} = {}) {
  const raw = String(value ?? '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    const error = new Error(`${label} must be a valid http(s) URL.`);
    error.status = 400;
    throw error;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    const error = new Error(`${label} must use http or https.`);
    error.status = 400;
    throw error;
  }

  const host = url.hostname.toLowerCase();
  const loopback = isLoopbackHost(host);
  const allowInsecure = process.env.SAAS_MDM_ALLOW_INSECURE === '1'
    || process.env.SAAS_JAMF_ALLOW_INSECURE === '1';
  const allowPrivate = process.env.SAAS_MDM_ALLOW_PRIVATE === '1';

  if (url.protocol === 'http:') {
    const httpOk = allowInsecure || (allowHttpLoopback && loopback && !isProduction());
    if (!httpOk) {
      const error = new Error(`${label} must use https.`);
      error.status = 400;
      throw error;
    }
  }

  if (!allowPrivate && isBlockedHost(host)) {
    // Loopback over http is already gated above for local connector tests.
    if (!(allowHttpLoopback && loopback && url.protocol === 'http:' && !isProduction())) {
      const error = new Error(`${label} must not target private, link-local or metadata addresses.`);
      error.status = 400;
      throw error;
    }
  }

  if (url.username || url.password) {
    const error = new Error(`${label} must not include credentials.`);
    error.status = 400;
    throw error;
  }

  return String(url.toString()).replace(/\/+$/, '');
}

export function isBlockedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (METADATA_HOSTS.has(host)) return true;
  if (host.endsWith('.internal') || host.endsWith('.local')) return true;
  if (isLoopbackHost(host)) return true;
  if (isPrivateIpv4(host)) return true;
  if (isPrivateIpv6(host)) return true;
  return false;
}

function isLoopbackHost(host) {
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '0:0:0:0:0:0:0:1'
    || host.endsWith('.localhost');
}

function isPrivateIpv4(host) {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  return false;
}

function isPrivateIpv6(host) {
  if (!host.includes(':')) return false;
  const normalized = host.toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA
  if (normalized.startsWith('fe80:')) return true; // link-local
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isPrivateIpv4(mapped)) return true;
  }
  return false;
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}
