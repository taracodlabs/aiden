import { describe, it, expect } from 'vitest';
import dns from 'node:dns';
import { SSRFProtection } from '../../../moat/ssrfProtection';

const fakeLookup = (
  map: Record<string, string[]>,
): ((h: string) => Promise<dns.LookupAddress[]>) => {
  return async (h: string) => {
    const ips = map[h];
    if (!ips) throw new Error(`ENOTFOUND ${h}`);
    return ips.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    })) as dns.LookupAddress[];
  };
};

describe('SSRFProtection', () => {
  it('1. blocks 127.0.0.1', async () => {
    const ssrf = new SSRFProtection();
    const r = await ssrf.check('http://127.0.0.1/admin');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('loopback');
  });

  it('2. blocks ::1 (IPv6 loopback)', async () => {
    const ssrf = new SSRFProtection();
    const r = await ssrf.check('http://[::1]:8080/');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('loopback');
  });

  it('3. blocks 10.x (RFC 1918)', async () => {
    const ssrf = new SSRFProtection();
    expect((await ssrf.check('http://10.0.0.5/')).blocked).toBe(true);
    expect((await ssrf.check('http://10.255.255.255/')).blocked).toBe(true);
  });

  it('4. blocks 172.16-31.x (RFC 1918)', async () => {
    const ssrf = new SSRFProtection();
    expect((await ssrf.check('http://172.16.0.1/')).blocked).toBe(true);
    expect((await ssrf.check('http://172.31.255.255/')).blocked).toBe(true);
    // 172.32.x.x is OUTSIDE RFC 1918 — public-ish range, not blocked.
    const out = await ssrf.check('http://172.32.0.1/');
    expect(out.blocked).toBe(false);
  });

  it('5. blocks 192.168.x', async () => {
    const ssrf = new SSRFProtection();
    expect((await ssrf.check('http://192.168.1.1/')).blocked).toBe(true);
  });

  it('6. blocks 169.254.169.254 (AWS/GCP/Azure metadata)', async () => {
    const ssrf = new SSRFProtection();
    const r = await ssrf.check('http://169.254.169.254/latest/meta-data/');
    expect(r.blocked).toBe(true);
    expect(['cloud_metadata', 'link_local']).toContain(r.category);
  });

  it('7. blocks 100.64.x (CGNAT / Tailscale)', async () => {
    const ssrf = new SSRFProtection();
    const r = await ssrf.check('http://100.64.0.1/');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('cgnat');
  });

  it('8. blocks metadata.google.internal by hostname', async () => {
    const ssrf = new SSRFProtection(fakeLookup({}));
    const r = await ssrf.check('http://metadata.google.internal/');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('cloud_metadata');
  });

  it('9. allows public IP after DNS lookup', async () => {
    const ssrf = new SSRFProtection(
      fakeLookup({ 'example.com': ['93.184.216.34'] }),
    );
    const r = await ssrf.check('http://example.com/path');
    expect(r.blocked).toBe(false);
  });

  it('10. blocks DNS rebinding (evil.example resolving to 127.0.0.1)', async () => {
    const ssrf = new SSRFProtection(
      fakeLookup({ 'evil.example.com': ['127.0.0.1'] }),
    );
    const r = await ssrf.check('http://evil.example.com/');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('loopback');
  });

  it('11. blocks even when one of multiple resolved IPs is private', async () => {
    const ssrf = new SSRFProtection(
      fakeLookup({ 'mixed.example.com': ['8.8.8.8', '10.0.0.5'] }),
    );
    const r = await ssrf.check('http://mixed.example.com/');
    expect(r.blocked).toBe(true);
  });

  it('12. blocks non-http schemes', async () => {
    const ssrf = new SSRFProtection();
    const r = await ssrf.check('file:///etc/passwd');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('unsupported_scheme');
  });

  it('13. handles invalid URL gracefully', async () => {
    const ssrf = new SSRFProtection();
    const r = await ssrf.check('not a url');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('invalid');
  });

  it('14. blocks IPv6 link-local fe80::/10', async () => {
    const ssrf = new SSRFProtection();
    const r = await ssrf.check('http://[fe80::1]/');
    expect(r.blocked).toBe(true);
    expect(r.category).toBe('link_local');
  });

  it('15. allows public IP literal (8.8.8.8)', async () => {
    const ssrf = new SSRFProtection();
    const r = await ssrf.check('http://8.8.8.8/');
    expect(r.blocked).toBe(false);
  });

  it('blocks mapped IPv4 private and metadata destinations in every accepted spelling', async () => {
    const ssrf = new SSRFProtection();
    for (const input of [
      'http://[::ffff:169.254.169.254]/latest/meta-data/',
      'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
      'http://[0:0:0:0:0:ffff:7f00:1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:10.0.0.5]/',
      'http://0.0.0.0/',
      'http://[::]/',
    ]) {
      expect((await ssrf.check(input)).blocked, input).toBe(true);
    }
    expect((await ssrf.check('http://[::ffff:8.8.8.8]/')).blocked).toBe(false);
  });

  it('rejects mapped private DNS, empty answers, invalid records and URL userinfo', async () => {
    const mapped = new SSRFProtection(fakeLookup({ 'mapped.example': ['::ffff:7f00:1'] }));
    expect((await mapped.check('https://mapped.example/')).blocked).toBe(true);
    const empty = new SSRFProtection(fakeLookup({ 'empty.example': [] }));
    expect((await empty.check('https://empty.example/')).blocked).toBe(true);
    const malformed = new SSRFProtection(async () => [{ address: 'not-an-ip', family: 4 }]);
    expect((await malformed.check('https://bad.example/')).blocked).toBe(true);
    expect((await mapped.check('https://user:pass@8.8.8.8/')).blocked).toBe(true);
  });

  it('uses the request parser for alternate numeric IPv4 and normalized hostnames', async () => {
    const ssrf = new SSRFProtection(fakeLookup({ 'public.example': ['8.8.8.8'] }));
    for (const input of [
      'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/',
      'http://127.1/', 'http://0x0/', 'http://METADATA.GOOGLE.INTERNAL./',
    ]) expect((await ssrf.check(input)).blocked, input).toBe(true);
    expect((await ssrf.check('https://PUBLIC.EXAMPLE./')).blocked).toBe(false);
    expect((await ssrf.check('https://[2606:4700:4700::1111]/')).blocked).toBe(false);
  });

  it('rejects translation, multicast, unspecified, invalid family and mixed DNS sets', async () => {
    const ssrf = new SSRFProtection();
    for (const input of [
      'http://[64:ff9b::a9fe:a9fe]/',
      'http://[64:ff9b:1::1]/',
      'http://[2002:a9fe:a9fe::]/',
      'http://[ff02::1]/',
      'http://224.0.0.1/',
    ]) expect((await ssrf.check(input)).blocked, input).toBe(true);
    const wrongFamily = new SSRFProtection(async () => [{ address: '127.0.0.1', family: 6 }]);
    expect((await wrongFamily.check('https://wrong.example/')).blocked).toBe(true);
    const mixed = new SSRFProtection(fakeLookup({ 'mixed.example': ['8.8.8.8', '::ffff:127.0.0.1'] }));
    expect((await mixed.check('https://mixed.example/')).blocked).toBe(true);
  });

  it('rejects non-global destinations but preserves public service exceptions', async () => {
    const ssrf = new SSRFProtection();
    for (const host of ['192.0.2.1', '198.51.100.1', '203.0.113.1', '192.88.99.2',
      '[100::1]', '[100:0:0:1::1]', '[2001:2::1]', '[2001:db8::1]', '[3fff::1]',
      '[5f00::1]', '[fec0::1]', '[::127.0.0.1]', '[2001:20::1]']) {
      expect((await ssrf.check(`http://${host}/`)).blocked, host).toBe(true);
    }
    for (const host of ['192.0.0.9', '192.0.0.10', '192.31.196.1', '[2001:1::1]',
      '[2001:3::1]', '[2001:4:112::1]', '[2620:4f:8000::1]']) {
      expect((await ssrf.check(`https://${host}/`)).blocked, host).toBe(false);
    }
  });

  it('fails closed on resolver rejection and malformed URL separators', async () => {
    const ssrf = new SSRFProtection(async () => { throw new Error('synthetic DNS failure'); });
    expect((await ssrf.check('https://missing.example/')).category).toBe('invalid');
    for (const url of ['http://[fe80::1%25eth0]/', 'http://127.0.0.1%2f.example/', 'http://[::gggg]/']) {
      expect((await ssrf.check(url)).blocked).toBe(true);
    }
  });
});
