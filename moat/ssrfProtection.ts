/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * moat/ssrfProtection.ts — Aiden v4.0.0
 *
 * Destination policy for untrusted HTTP requests. Callers must use the
 * connection-bound fetch path as a separate URL precheck cannot prevent a
 * changed DNS answer between validation and connection.
 *
 * Returns a structured `SSRFCheckResult`; never throws on bad input.
 *
 * Status: PHASE 9.
 */

import dns from 'node:dns';
import net from 'node:net';

// ipaddr.js is an existing MIT-licensed runtime dependency, declared directly
// for this policy. It parses mapped IPv6 numerically, including dotted tails.
const ipaddr = require('ipaddr.js') as {
  parse(input: string): {
    kind(): 'ipv4' | 'ipv6';
    toByteArray(): number[];
    isIPv4MappedAddress?(): boolean;
    toIPv4Address?(): { toByteArray(): number[] };
  };
};

export type SSRFCategory =
  | 'rfc1918'
  | 'loopback'
  | 'link_local'
  | 'cgnat'
  | 'cloud_metadata'
  | 'reserved'
  | 'invalid'
  | 'unsupported_scheme';

export interface SSRFCheckResult {
  blocked: boolean;
  reason?: string;
  category?: SSRFCategory;
  /** The IP / hostname that triggered the block. */
  ip?: string;
}

/** Hostnames that resolve into cloud-metadata services. Checked
 *  case-insensitively against the URL's hostname. */
const BLOCKED_HOSTNAMES: readonly string[] = [
  'metadata.google.internal',
  'metadata.azure.com',
  'metadata.aws.amazon.com',
  '169.254.169.254',
  'fd00:ec2::254',
];

interface CIDR {
  base: bigint;
  prefix: number;
  width: number; // 32 or 128
  category: SSRFCategory;
  description: string;
}

const BLOCKED_NETWORKS: readonly CIDR[] = [
  // IPv4
  cidr4('0.0.0.0', 8, 'reserved', 'IPv4 current-network/unspecified (0/8)'),
  cidr4('10.0.0.0', 8, 'rfc1918', 'RFC 1918 private (10.0.0.0/8)'),
  cidr4('172.16.0.0', 12, 'rfc1918', 'RFC 1918 private (172.16.0.0/12)'),
  cidr4('192.168.0.0', 16, 'rfc1918', 'RFC 1918 private (192.168.0.0/16)'),
  cidr4('127.0.0.0', 8, 'loopback', 'loopback (127.0.0.0/8)'),
  cidr4('169.254.0.0', 16, 'link_local', 'link-local / cloud metadata (169.254.0.0/16)'),
  cidr4('100.64.0.0', 10, 'cgnat', 'CGNAT (100.64.0.0/10) — Tailscale et al.'),
  cidr4('192.0.0.0', 24, 'reserved', 'IPv4 protocol assignments (192.0.0/24)'),
  cidr4('192.0.2.0', 24, 'reserved', 'IPv4 documentation'),
  cidr4('192.88.99.0', 24, 'reserved', 'Deprecated IPv4 transition relay'),
  cidr4('198.18.0.0', 15, 'reserved', 'IPv4 benchmarking (198.18/15)'),
  cidr4('198.51.100.0', 24, 'reserved', 'IPv4 documentation'),
  cidr4('203.0.113.0', 24, 'reserved', 'IPv4 documentation'),
  cidr4('224.0.0.0', 4, 'reserved', 'IPv4 multicast (224/4)'),
  cidr4('240.0.0.0', 4, 'reserved', 'IPv4 reserved/broadcast (240/4)'),
  // IPv6
  cidr6('::', 128, 'reserved', 'IPv6 unspecified (::)'),
  cidr6('::1', 128, 'loopback', 'IPv6 loopback (::1)'),
  cidr6('64:ff9b::', 96, 'reserved', 'NAT64 well-known translation prefix'),
  cidr6('64:ff9b:1::', 48, 'reserved', 'NAT64 local-use translation prefix'),
  cidr6('2002::', 16, 'reserved', '6to4 transition prefix'),
  cidr6('2001::', 32, 'reserved', 'Teredo transition prefix'),
  cidr6('2001::', 23, 'reserved', 'IPv6 protocol assignments without a public destination exception'),
  cidr6('2001:db8::', 32, 'reserved', 'IPv6 documentation'),
  cidr6('3fff::', 20, 'reserved', 'IPv6 documentation'),
  cidr6('ff00::', 8, 'reserved', 'IPv6 multicast'),
  cidr6('fe80::', 10, 'link_local', 'IPv6 link-local (fe80::/10)'),
  cidr6('fc00::', 7, 'rfc1918', 'IPv6 unique-local (fc00::/7)'),
];

export class SSRFProtection {
  /**
   * `dnsLookup` is injectable so tests can simulate rebinding without
   * a network round-trip.
   */
  constructor(
    private readonly dnsLookup: (
      hostname: string,
    ) => Promise<dns.LookupAddress[]> = defaultLookup,
  ) {}

  async check(url: string): Promise<SSRFCheckResult> {
    const resolved = await this.resolve(url);
    return resolved.verdict;
  }

  /** Resolve the complete candidate set once for connection-bound callers. */
  async resolve(url: string, allowLoopbackOrigin?: string): Promise<{
    verdict: SSRFCheckResult;
    addresses: dns.LookupAddress[];
    parsed?: URL;
  }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        verdict: { blocked: true, reason: 'Invalid URL', category: 'invalid' }, addresses: [],
      };
    }

    if (!/^https?:$/i.test(parsed.protocol)) {
      return {
        verdict: { blocked: true, reason: `Unsupported scheme: ${parsed.protocol}`, category: 'unsupported_scheme' }, addresses: [],
      };
    }

    if (parsed.username || parsed.password) {
      return { verdict: { blocked: true, reason: 'URL credentials are not allowed', category: 'invalid' }, addresses: [] };
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!hostname) {
      return {
        verdict: { blocked: true, reason: 'Empty hostname', category: 'invalid' }, addresses: [],
      };
    }

    if (BLOCKED_HOSTNAMES.includes(hostname)) {
      return {
        verdict: { blocked: true, reason: `${hostname} is a cloud-metadata endpoint`, category: 'cloud_metadata', ip: hostname }, addresses: [],
      };
    }

    const localAllowed = allowLoopbackOrigin === parsed.origin
      && parsed.protocol === 'http:'
      && ['localhost', '127.0.0.1', '::1'].includes(hostname);

    if (net.isIP(hostname)) {
      const direct = checkIp(hostname);
      const verdict = localAllowed && direct.category === 'loopback' ? { blocked: false } : direct;
      return { verdict, addresses: verdict.blocked ? [] : [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }], parsed };
    }

    // Otherwise resolve and check every returned address.
    let addrs: dns.LookupAddress[];
    try {
      addrs = await boundedLookup(this.dnsLookup(hostname));
    } catch (e) {
      return {
        verdict: { blocked: true, reason: `DNS lookup failed: ${(e as Error).message}`, category: 'invalid' }, addresses: [],
      };
    }
    if (!Array.isArray(addrs) || addrs.length === 0 || addrs.length > 64) {
      return { verdict: { blocked: true, reason: 'DNS returned no bounded address set', category: 'invalid' }, addresses: [] };
    }
    for (const a of addrs) {
      if (!a || net.isIP(a.address) !== a.family || ![4, 6].includes(a.family)) {
        return { verdict: { blocked: true, reason: 'DNS returned an invalid address record', category: 'invalid' }, addresses: [] };
      }
      const r = checkIp(a.address);
      if (localAllowed && r.category !== 'loopback') {
        return { verdict: { blocked: true, reason: 'Local target resolved outside loopback', category: 'invalid' }, addresses: [] };
      }
      if (r.blocked && !(localAllowed && r.category === 'loopback')) return { verdict: r, addresses: [] };
    }
    return { verdict: { blocked: false }, addresses: addrs, parsed };
  }
}

function boundedLookup(pending: Promise<dns.LookupAddress[]>): Promise<dns.LookupAddress[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DNS lookup timed out')), 3_000);
    timer.unref?.();
    pending.then(
      (addresses) => { clearTimeout(timer); resolve(addresses); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function defaultLookup(hostname: string): Promise<dns.LookupAddress[]> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) reject(err);
      else resolve(addrs);
    });
  });
}

function checkIp(ip: string): SSRFCheckResult {
  const clean = ip.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.includes(clean.toLowerCase())) {
    return {
      blocked: true,
      reason: `${clean} is a cloud-metadata endpoint`,
      category: 'cloud_metadata',
      ip: clean,
    };
  }
  let parsed: ReturnType<typeof ipaddr.parse>;
  try { parsed = ipaddr.parse(clean); } catch {
    return { blocked: true, reason: 'Invalid IP address', category: 'invalid' };
  }
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress?.()) {
    const mapped = parsed.toIPv4Address?.();
    if (!mapped) return { blocked: true, reason: 'Invalid mapped IPv4 address', category: 'invalid' };
    return checkIp(mapped.toByteArray().join('.'));
  }
  const v4 = parsed.kind() === 'ipv4' ? bytesToBigInt(parsed.toByteArray()) : null;
  if (v4 != null) {
    // IANA global-destination exceptions within 192.0.0/24.
    if (clean === '192.0.0.9' || clean === '192.0.0.10') return { blocked: false };
    for (const c of BLOCKED_NETWORKS) {
      if (c.width !== 32) continue;
      if (inCidr(v4, c)) {
        return {
          blocked: true,
          reason: `${clean} is in ${c.description}`,
          category: c.category,
          ip: clean,
        };
      }
    }
    return { blocked: false };
  }
  const v6 = parsed.kind() === 'ipv6' ? bytesToBigInt(parsed.toByteArray()) : null;
  if (v6 != null) {
    // Public protocol-service exceptions, not a blanket special-range ban.
    const publicServices = [
      cidr6('2001:1::1', 128, 'reserved', ''), cidr6('2001:1::2', 128, 'reserved', ''),
      cidr6('2001:1::3', 128, 'reserved', ''), cidr6('2001:3::', 32, 'reserved', ''),
      cidr6('2001:4:112::', 48, 'reserved', ''),
    ];
    if (publicServices.some((c) => inCidr(v6, c))) return { blocked: false };
    for (const c of BLOCKED_NETWORKS) {
      if (c.width !== 128) continue;
      if (inCidr(v6, c)) {
        return {
          blocked: true,
          reason: `${clean} is in ${c.description}`,
          category: c.category,
          ip: clean,
        };
      }
    }
    // Ordinary global unicast is 2000::/3. Other allocations (discard-only,
    // dummy, site-local, SRv6, unallocated space) are not public HTTP targets.
    if ((v6 >> 125n) !== 1n) return { blocked: true, reason: 'IPv6 destination is outside supported global unicast', category: 'reserved', ip: clean };
    return { blocked: false };
  }
  return { blocked: false };
}

// ── CIDR helpers ────────────────────────────────────────────────

function cidr4(
  base: string,
  prefix: number,
  cat: SSRFCategory,
  desc: string,
): CIDR {
  return {
    base: parseIp4(base)!,
    prefix,
    width: 32,
    category: cat,
    description: desc,
  };
}

function cidr6(
  base: string,
  prefix: number,
  cat: SSRFCategory,
  desc: string,
): CIDR {
  return {
    base: parseIp6(base)!,
    prefix,
    width: 128,
    category: cat,
    description: desc,
  };
}

function inCidr(addr: bigint, c: CIDR): boolean {
  const shift = BigInt(c.width - c.prefix);
  return (addr >> shift) === (c.base >> shift);
}

function parseIp4(s: string): bigint | null {
  try { const parsed = ipaddr.parse(s); return parsed.kind() === 'ipv4' ? bytesToBigInt(parsed.toByteArray()) : null; }
  catch { return null; }
}

function parseIp6(s: string): bigint | null {
  try { const parsed = ipaddr.parse(s); return parsed.kind() === 'ipv6' ? bytesToBigInt(parsed.toByteArray()) : null; }
  catch { return null; }
}

function bytesToBigInt(bytes: number[]): bigint {
  return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}
