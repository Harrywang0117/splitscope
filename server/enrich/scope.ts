import { isIPv4, ipToInt } from './geoip.ts';
import { intel } from './intel.ts';

/**
 * Is this destination a domestic (cn) or foreign (intl) service? Hostnames are judged by GeoSite's
 * region lists, bare IPs by country. Used to spot domestic traffic sent through a proxy and foreign
 * traffic sent direct.
 */

export type Scope = 'cn' | 'intl' | '';

const cache = new Map<string, Scope>();

function isPrivate(ip: string): boolean {
  const n = ipToInt(ip);
  const inNet = (base: string, bits: number) => {
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((ipToInt(base) & mask) >>> 0);
  };
  return inNet('10.0.0.0', 8) || inNet('172.16.0.0', 12) || inNet('192.168.0.0', 16) || inNet('127.0.0.0', 8) || inNet('100.64.0.0', 10) || inNet('169.254.0.0', 16) || inNet('198.18.0.0', 15);
}

function hostScope(host: string): Scope {
  const h = host.toLowerCase();
  const hit = cache.get(h);
  if (hit !== undefined) return hit;
  let s: Scope = '';
  const all = intel.geosite?.match(h)?.all ?? [];
  if (all.includes('cn') || all.includes('geolocation-cn') || all.includes('tld-cn')) s = 'cn';
  else if (all.includes('geolocation-!cn') || all.includes('gfw')) s = 'intl';
  else if (/\.(cn|中国)$/.test(h)) s = 'cn';
  if (cache.size > 50_000) cache.clear();
  cache.set(h, s);
  return s;
}

/** `country` is the target country when the caller already knows it (saves a lookup). */
export function scopeOf(host: string, ip: string, country = ''): Scope {
  if (host && !isIPv4(host)) {
    const s = hostScope(host);
    if (s) return s;
  }
  const addr = isIPv4(host) ? host : ip;
  if (!addr || !isIPv4(addr) || isPrivate(addr)) return '';
  const c = country || intel.ipdb.lookupCountry(addr);
  return c === 'CN' ? 'cn' : c ? 'intl' : '';
}
