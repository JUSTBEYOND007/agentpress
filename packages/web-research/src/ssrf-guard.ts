// Copyright (c) 2025 Nico Bailon. MIT License.
// Adapted from nicobailon/pi-web-access, commit b537183632d555d1b2e61cb8f6bdf585766f2380.
// AgentPress keeps only server-side URL validation and makes DNS injectable for deterministic tests.
import { isIP } from 'node:net';
import { lookup as systemLookup } from 'node:dns/promises';

export type DnsAddress = { readonly address: string; readonly family: number };
export type SsrfOptions = {
  readonly lookup?: (hostname: string) => Promise<readonly DnsAddress[]>;
  readonly allowRanges?: readonly string[];
};

export type ResearchUrlFailureKind =
  | 'invalid_url'
  | 'invalid_scheme'
  | 'embedded_credentials'
  | 'blocked_private'
  | 'dns_failure'
  | 'invalid_dns_answer';

export class ResearchUrlError extends Error {
  public override readonly name = 'ResearchUrlError';

  public constructor(
    public readonly kind: ResearchUrlFailureKind,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}

export async function assertSafeUrl(raw: string, options: SsrfOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new ResearchUrlError('invalid_url', 'Research URL is invalid', { cause: error });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new ResearchUrlError('invalid_scheme', 'Only HTTP(S) research URLs are allowed');
  if (url.username || url.password)
    throw new ResearchUrlError('embedded_credentials', 'Research URLs cannot contain credentials');
  const allowRanges = parseAllowRanges(options.allowRanges);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost'))
    throw new ResearchUrlError('blocked_private', 'Private or loopback research hosts are blocked');
  const literalVersion = isIP(hostname);
  if (literalVersion !== 0) {
    assertPublicAddress(hostname, hostname, allowRanges);
    return url;
  }
  let addresses: readonly DnsAddress[];
  try {
    addresses = await (
      options.lookup ??
      (async (host) =>
        (await systemLookup(host, { all: true, verbatim: true })).map(({ address, family }) => ({
          address,
          family,
        })))
    )(hostname);
  } catch (error) {
    throw new ResearchUrlError('dns_failure', `DNS lookup failed for ${hostname}`, {
      cause: error,
    });
  }
  for (const entry of addresses) assertPublicAddress(entry.address, hostname, allowRanges);
  return url;
}

type Cidr = { readonly bytes: Uint8Array; readonly prefix: number };

function assertPublicAddress(
  address: string,
  hostname: string,
  allowRanges: readonly Cidr[],
): void {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const family = isIP(normalized);
  if (family === 0)
    throw new ResearchUrlError(
      'invalid_dns_answer',
      `Resolved non-IP address for ${hostname}: ${address}`,
    );
  if (isInAllowedRange(normalized, family, allowRanges)) return;
  if ((family === 4 && blockedIpv4(normalized)) || (family === 6 && blockedIpv6(normalized))) {
    throw new ResearchUrlError(
      'blocked_private',
      `Blocked internal address for ${hostname}: ${normalized}`,
    );
  }
}

function blockedIpv4(address: string): boolean {
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const a = p[0] ?? -1;
  const b = p[1] ?? -1;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function blockedIpv6(address: string): boolean {
  const groups = parseIpv6(address);
  if (!groups) return true;
  const first = groups[0] ?? 0;
  if (groups.every((g) => g === 0) || (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1))
    return true;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const sixth = groups[6] ?? 0;
    const seventh = groups[7] ?? 0;
    return blockedIpv4([sixth >> 8, sixth & 255, seventh >> 8, seventh & 255].join('.'));
  }
  return false;
}

function parseIpv6(address: string): number[] | null {
  let value = address;
  if (value.includes('.')) {
    const i = value.lastIndexOf(':');
    const v4 = value.slice(i + 1);
    if (isIP(v4) !== 4) return null;
    const p = v4.split('.').map(Number);
    value = `${value.slice(0, i)}:${(((p[0] ?? 0) << 8) | (p[1] ?? 0)).toString(16)}:${(((p[2] ?? 0) << 8) | (p[3] ?? 0)).toString(16)}`;
  }
  const parts = value.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((parts.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right].map(
    (part) => (/^[0-9a-f]{1,4}$/i.test(part) ? Number.parseInt(part, 16) : -1),
  );
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

function parseAllowRanges(input: readonly string[] | undefined): readonly Cidr[] {
  if (!input) return [];
  return input.map((raw) => {
    const slash = raw.lastIndexOf('/');
    const host = slash >= 0 ? raw.slice(0, slash) : raw;
    const prefix = slash >= 0 ? raw.slice(slash + 1) : undefined;
    if (prefix !== undefined && !/^\d+$/.test(prefix))
      throw new Error(`Invalid CIDR notation in ssrf.allowRanges: "${raw}"`);
    const family = isIP(host);
    const groups = family === 4 ? host.split('.').map(Number) : parseIpv6(host);
    const max = family === 4 ? 32 : 128;
    const p = prefix === undefined ? max : Number(prefix);
    if (!family || !groups || p < 1 || p > max)
      throw new Error(`Invalid CIDR notation in ssrf.allowRanges: "${raw}"`);
    const bytes =
      family === 4
        ? Uint8Array.from(groups)
        : Uint8Array.from(groups.flatMap((g) => [g >> 8, g & 255]));
    return { bytes, prefix: p };
  });
}

function isInAllowedRange(address: string, family: number, ranges: readonly Cidr[]): boolean {
  const groups = family === 4 ? address.split('.').map(Number) : parseIpv6(address);
  if (!groups) return false;
  const bytes =
    family === 4
      ? Uint8Array.from(groups)
      : Uint8Array.from(groups.flatMap((g) => [g >> 8, g & 255]));
  return ranges.some(
    (range) =>
      range.bytes.length === bytes.length &&
      (() => {
        const full = range.prefix >> 3;
        const rem = range.prefix & 7;
        for (let i = 0; i < full; i++) if (bytes[i] !== range.bytes[i]) return false;
        if (rem === 0) return true;
        const mask = (0xff << (8 - rem)) & 0xff;
        return ((bytes[full] ?? 0) & mask) === ((range.bytes[full] ?? 0) & mask);
      })(),
  );
}
