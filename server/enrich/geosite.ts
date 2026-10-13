import fs from 'node:fs';
import { pbFields, pbString } from './pb.ts';

/** v2ray Domain.Type */
export const enum DomainType {
  Keyword = 0,
  Regex = 1,
  Suffix = 2,
  Full = 3,
}

export interface SiteEntry {
  t: DomainType;
  v: string;
  attrs?: string[];
}

export interface SiteMatch {
  /** best category for display */
  key: string;
  /** suffix that matched */
  matched: string;
  /** every category containing this host (specific first) */
  all: string[];
}

/** Aggregate lists that say little about *which* service a domain is. */
export function isAggregate(code: string): boolean {
  return (
    /^(category-|geolocation-|tld-)/.test(code) ||
    code.includes('!') ||
    code.includes('@') ||
    ['cn', 'gfw', 'greatfire', 'private', 'proxy', 'direct', 'reject', 'httpdns', 'alphabet', 'win-spy', 'win-update', 'win-extra'].includes(code)
  );
}

/**
 * How many of a list key's words equal a label of the host. With `subOnly`, only labels left of the
 * registrable domain count, so "google" does not favour the generic list on mtalk.google.com, while
 * "gemini" still picks google-gemini for gemini.google.com.
 */
export function affinity(key: string, host: string, subOnly = false): number {
  let labels = host.toLowerCase().split('.');
  if (subOnly) labels = labels.slice(0, Math.max(0, labels.length - 2));
  const parts = new Set(labels.flatMap((l) => [l, ...l.split('-')]));
  return key
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && parts.has(w)).length;
}

export class GeoSite {
  categories = new Map<string, SiteEntry[]>();
  private full = new Map<string, string[]>();
  private suffix = new Map<string, string[]>();

  static parse(buf: Uint8Array): GeoSite {
    const g = new GeoSite();
    for (const site of pbFields(buf)) {
      if (site.no !== 1 || site.wire !== 2) continue;
      let code = '';
      const entries: SiteEntry[] = [];
      for (const f of pbFields(buf, site.start, site.end)) {
        if (f.no === 1 && f.wire === 2) code = pbString(buf, f).toLowerCase();
        else if (f.no === 2 && f.wire === 2) {
          const e: SiteEntry = { t: DomainType.Keyword, v: '' };
          for (const d of pbFields(buf, f.start, f.end)) {
            if (d.no === 1 && d.wire === 0) e.t = d.num as DomainType;
            else if (d.no === 2 && d.wire === 2) e.v = pbString(buf, d).toLowerCase();
            else if (d.no === 3 && d.wire === 2) {
              for (const a of pbFields(buf, d.start, d.end)) {
                if (a.no === 1 && a.wire === 2) (e.attrs ??= []).push(pbString(buf, a));
              }
            }
          }
          entries.push(e);
        }
      }
      if (code) g.categories.set(code, entries);
    }
    g.index();
    return g;
  }

  static load(file: string): GeoSite | null {
    if (!fs.existsSync(file)) return null;
    return GeoSite.parse(fs.readFileSync(file));
  }

  private index() {
    for (const [code, entries] of this.categories) {
      for (const e of entries) {
        const map = e.t === DomainType.Full ? this.full : e.t === DomainType.Suffix ? this.suffix : null;
        if (!map) continue;
        const list = map.get(e.v);
        if (!list) map.set(e.v, [code]);
        else if (!list.includes(code)) list.push(code);
      }
    }
  }

  size(code: string): number {
    return this.categories.get(code)?.length ?? Number.MAX_SAFE_INTEGER;
  }

  /** Every category containing host, grouped by the suffix that matched (most specific first). */
  private levels(host: string): { matched: string; codes: string[] }[] {
    const h = host.toLowerCase().replace(/\.$/, '');
    const out: { matched: string; codes: string[] }[] = [];
    const full = this.full.get(h);
    const levelCodes = new Set<string>(full ?? []);
    let cur = h;
    let first = true;
    for (;;) {
      // a bare TLD ("app", "dev") only tells which registry, not which service
      const s = cur.includes('.') || first ? this.suffix.get(cur) : undefined;
      const codes = new Set<string>(first ? levelCodes : []);
      for (const c of s ?? []) codes.add(c);
      if (codes.size) out.push({ matched: cur, codes: [...codes] });
      first = false;
      const dot = cur.indexOf('.');
      if (dot < 0) break;
      cur = cur.slice(dot + 1);
    }
    return out;
  }

  match(host: string): SiteMatch | null {
    const levels = this.levels(host);
    if (!levels.length) return null;
    // among lists matching at the same level, prefer one named after the host (google-gemini for
    // gemini.google.com), then the smaller, more specific list
    const h = host.toLowerCase();
    const bySize = (a: string, b: string) => affinity(b, h, true) - affinity(a, h, true) || this.size(a) - this.size(b);
    const all: string[] = [];
    for (const l of levels) for (const c of l.codes) if (!all.includes(c)) all.push(c);
    const specificAll = all.filter((c) => !isAggregate(c));
    for (const l of levels) {
      const specific = l.codes.filter((c) => !isAggregate(c)).sort(bySize);
      if (specific.length) {
        return { key: specific[0], matched: l.matched, all: [...specificAll, ...all.filter(isAggregate)] };
      }
    }
    const agg = levels[0].codes.filter((c) => /^category-/.test(c)).sort(bySize);
    return agg.length ? { key: agg[0], matched: levels[0].matched, all } : null;
  }

  stats() {
    let domains = 0;
    for (const e of this.categories.values()) domains += e.length;
    return { categories: this.categories.size, domains };
  }
}
