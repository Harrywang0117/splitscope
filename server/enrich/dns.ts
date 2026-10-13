import { mihomo } from '../mihomo/client.ts';
import { proxyJson } from '../net.ts';
import { isIPv4 } from './geoip.ts';

/**
 * Reference resolution of a hostname, used only to label the target's provider.
 * Domestic (direct) hosts go through mihomo's own resolver; everything else through DoH over the
 * proxy, because the domestic resolver returns polluted answers for blocked domains.
 */

interface Entry {
  at: number;
  ips: string[];
  via: 'mihomo' | 'doh';
}

const TTL = 10 * 60 * 1000;
/** failed or empty lookups are retried soon instead of being remembered for the full TTL */
const FAIL_TTL = 30 * 1000;
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();
let active = 0;
const waiters: (() => void)[] = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 4) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

async function viaDoh(host: string): Promise<string[]> {
  const r = await proxyJson<{ Answer?: { type: number; data: string }[] }>(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
    { accept: 'application/dns-json' },
  );
  return (r.Answer ?? []).filter((a) => a.type === 1 && isIPv4(a.data)).map((a) => a.data);
}

async function viaMihomo(host: string): Promise<string[]> {
  const r = await mihomo.dnsQuery(host, 'A');
  return (r.Answer ?? []).filter((a) => a.type === 1 && isIPv4(a.data)).map((a) => a.data);
}

export function resolveHost(host: string, domestic: boolean): Promise<Entry> {
  const key = `${domestic ? 'd' : 'f'}:${host}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.ips.length ? TTL : FAIL_TTL)) return Promise.resolve(hit);
  let p = inflight.get(key);
  if (!p) {
    p = limited(async () => {
      let ips: string[] = [];
      try {
        ips = domestic ? await viaMihomo(host) : await viaDoh(host);
      } catch {
        ips = [];
      }
      const e: Entry = { at: Date.now(), ips, via: domestic ? 'mihomo' : 'doh' };
      cache.set(key, e);
      if (cache.size > 5000) cache.delete(cache.keys().next().value!);
      return e;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}
