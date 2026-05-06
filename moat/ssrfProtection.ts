/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * moat/ssrfProtection.ts — Aiden v4.0.0
 *
 * Always-on URL validator. Blocks requests to RFC 1918 private nets,
 * loopback, link-local, CGNAT, and well-known cloud-metadata
 * endpoints (AWS / GCP / Azure / DigitalOcean / OCI). DNS is resolved
 * BEFORE the network check so `evil.example.com -> 127.0.0.1`
 * rebinding attacks fail closed.
 *
 * Returns a structured `SSRFCheckResult`; never throws on bad input.
 *
 * Status: PHASE 9.
 */

import dns from 'node:dns';

export type SSRFCategory =
  | 'rfc1918'
  | 'loopback'
  | 'link_local'
  | 'cgnat'
  | 'cloud_metadata'
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
  cidr4('10.0.0.0', 8, 'rfc1918', 'RFC 1918 private (10.0.0.0/8)'),
  cidr4('172.16.0.0', 12, 'rfc1918', 'RFC 1918 private (172.16.0.0/12)'),
  cidr4('192.168.0.0', 16, 'rfc1918', 'RFC 1918 private (192.168.0.0/16)'),
  cidr4('127.0.0.0', 8, 'loopback', 'loopback (127.0.0.0/8)'),
  cidr4('169.254.0.0', 16, 'link_local', 'link-local / cloud metadata (169.254.0.0/16)'),
  cidr4('100.64.0.0', 10, 'cgnat', 'CGNAT (100.64.0.0/10) — Tailscale et al.'),
  // IPv6
  cidr6('::1', 128, 'loopback', 'IPv6 loopback (::1)'),
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
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        blocked: true,
        reason: `Invalid URL: ${url}`,
        category: 'invalid',
      };
    }

    if (!/^https?:$/i.test(parsed.protocol)) {
      return {
        blocked: true,
        reason: `Unsupported scheme: ${parsed.protocol}`,
        category: 'unsupported_scheme',
      };
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!hostname) {
      return {
        blocked: true,
        reason: 'Empty hostname',
        category: 'invalid',
      };
    }

    if (BLOCKED_HOSTNAMES.includes(hostname)) {
      return {
        blocked: true,
        reason: `${hostname} is a cloud-metadata endpoint`,
        category: 'cloud_metadata',
        ip: hostname,
      };
    }

    // If hostname is itself an IP literal, check directly.
    const direct = checkIp(hostname);
    if (direct.blocked) return direct;
    if (parseIp4(hostname) != null || parseIp6(hostname) != null) {
      return { blocked: false };
    }

    // Otherwise resolve and check every returned address.
    let addrs: dns.LookupAddress[];
    try {
      addrs = await this.dnsLookup(hostname);
    } catch (e) {
      return {
        blocked: true,
        reason: `DNS lookup failed: ${(e as Error).message}`,
        category: 'invalid',
      };
    }
    for (const a of addrs) {
      const r = checkIp(a.address);
      if (r.blocked) return r;
    }
    return { blocked: false };
  }
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
  const v4 = parseIp4(clean);
  if (v4 != null) {
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
  const v6 = parseIp6(clean);
  if (v6 != null) {
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
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = [m[1], m[2], m[3], m[4]].map(Number);
  if (parts.some((n) => n < 0 || n > 255 || Number.isNaN(n))) return null;
  return (
    (BigInt(parts[0]) << 24n) |
    (BigInt(parts[1]) << 16n) |
    (BigInt(parts[2]) << 8n) |
    BigInt(parts[3])
  );
}

function parseIp6(s: string): bigint | null {
  if (!/^[0-9a-fA-F:]+$/.test(s)) return null;
  let groups: string[];
  if (s.includes('::')) {
    const [headRaw, tailRaw = ''] = s.split('::');
    const head = headRaw ? headRaw.split(':') : [];
    const tail = tailRaw ? tailRaw.split(':') : [];
    const fillCount = 8 - head.length - tail.length;
    if (fillCount < 0) return null;
    groups = [...head, ...new Array(fillCount).fill('0'), ...tail];
  } else {
    groups = s.split(':');
  }
  if (groups.length !== 8) return null;
  let acc = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    acc = (acc << 16n) | BigInt(parseInt(g, 16));
  }
  return acc;
}
