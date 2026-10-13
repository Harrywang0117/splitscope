import fs from 'node:fs';
import maxmind, { type AsnResponse, type CountryResponse, type Reader } from 'maxmind';
import { pbFields, pbString } from './pb.ts';

export function ipToInt(ip: string): number {
  const p = ip.split('.');
  if (p.length !== 4) return -1;
  let n = 0;
  for (const x of p) {
    const v = Number(x);
    if (!Number.isInteger(v) || v < 0 || v > 255) return -1;
    n = n * 256 + v;
  }
  return n;
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function isIPv4(s: string): boolean {
  return ipToInt(s) >= 0;
}

const maskOf = (bits: number) => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);

/**
 * Non-country categories from geoip.dat (telegram, google, netflix, cloudflare, …), IPv4 only.
 * Indexed per prefix length so overlapping ranges are all found.
 */
export class GeoIpTags {
  private byLen = new Map<number, Map<number, string[]>>();
  categories = new Map<string, { cidr: string }[]>();

  static parse(buf: Uint8Array): GeoIpTags {
    const g = new GeoIpTags();
    for (const entry of pbFields(buf)) {
      if (entry.no !== 1 || entry.wire !== 2) continue;
      let code = '';
      const cidrs: { ip: number; bits: number }[] = [];
      for (const f of pbFields(buf, entry.start, entry.end)) {
        if (f.no === 1 && f.wire === 2) {
          code = pbString(buf, f).toLowerCase();
          // country codes are the bulk of the file and covered by country.mmdb
          if (code.length <= 2) break;
        } else if (f.no === 2 && f.wire === 2) {
          let ip = -1;
          let bits = 0;
          for (const c of pbFields(buf, f.start, f.end)) {
            if (c.no === 1 && c.wire === 2 && c.end - c.start === 4) {
              ip = ((buf[c.start] << 24) | (buf[c.start + 1] << 16) | (buf[c.start + 2] << 8) | buf[c.start + 3]) >>> 0;
            } else if (c.no === 2 && c.wire === 0) bits = c.num;
          }
          if (ip >= 0) cidrs.push({ ip, bits });
        }
      }
      if (!code || code.length <= 2) continue;
      g.categories.set(
        code,
        cidrs.map((c) => ({ cidr: `${intToIp(c.ip)}/${c.bits}` })),
      );
      for (const c of cidrs) {
        const net = (c.ip & maskOf(c.bits)) >>> 0;
        let m = g.byLen.get(c.bits);
        if (!m) g.byLen.set(c.bits, (m = new Map()));
        const list = m.get(net);
        if (!list) m.set(net, [code]);
        else if (!list.includes(code)) list.push(code);
      }
    }
    return g;
  }

  static load(file: string): GeoIpTags | null {
    if (!fs.existsSync(file)) return null;
    return GeoIpTags.parse(fs.readFileSync(file));
  }

  lookup(ip: string): string[] {
    const n = ipToInt(ip);
    if (n < 0) return [];
    const out: string[] = [];
    for (const [bits, m] of [...this.byLen].sort((a, b) => b[0] - a[0])) {
      const hit = m.get((n & maskOf(bits)) >>> 0);
      if (hit) for (const c of hit) if (!out.includes(c)) out.push(c);
    }
    return out;
  }
}

export class IpDb {
  asn: Reader<AsnResponse> | null = null;
  country: Reader<CountryResponse> | null = null;

  async load(asnFile: string, countryFile: string) {
    if (fs.existsSync(asnFile)) this.asn = await maxmind.open<AsnResponse>(asnFile, { watchForUpdates: false });
    if (fs.existsSync(countryFile))
      this.country = await maxmind.open<CountryResponse>(countryFile, { watchForUpdates: false });
  }

  lookupAsn(ip: string): { asn: number; org: string } | null {
    try {
      const r = this.asn?.get(ip);
      return r?.autonomous_system_number ? { asn: r.autonomous_system_number, org: r.autonomous_system_organization ?? '' } : null;
    } catch {
      return null;
    }
  }

  lookupCountry(ip: string): string {
    try {
      const r = this.country?.get(ip);
      const code = (r?.country?.iso_code ?? r?.registered_country?.iso_code ?? '').toUpperCase();
      // MetaCubeX's country.mmdb also uses pseudo codes such as "CLOUDFLARE" / "GOOGLE"
      return /^[A-Z]{2}$/.test(code) ? code : '';
    } catch {
      return '';
    }
  }
}
