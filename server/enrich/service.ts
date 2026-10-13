import { getDomain } from 'tldts';
import type { ProviderInfo, ServiceInfo } from '../../shared/types.ts';
import { getSnapshot } from '../mihomo/snapshot.ts';
import { affinity, isAggregate } from './geosite.ts';
import { isIPv4 } from './geoip.ts';
import { intel } from './intel.ts';

export type { ProviderInfo, ServiceInfo };

const ACRONYMS = new Set(['ai', 'api', 'cdn', 'tv', 'id', 'io', 'aws', 'ntp', 'dns', 'vpn', 'gpt', 'ea', 'hbo', 'bbc', 'cnn', 'nba', 'nhk']);

/** "google-deepmind" -> "Google Deepmind", used when no curated name exists */
function prettify(key: string): string {
  return key
    .split(/[-_]/)
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export function categoryName(key: string): string {
  const cat = /^category-(.+?)(-cn|-!cn)?$/.exec(key);
  if (!cat) return key;
  const region = cat[2] === '-cn' ? '（国内）' : cat[2] ? '（境外）' : '';
  const base = intel.services.names[`category-${cat[1]}`];
  return base ? `${base}${region}` : `${prettify(cat[1])} 类${region}`;
}

export function geositeName(key: string): string {
  const named = intel.services.names[key];
  if (named) return named;
  if (key.startsWith('category-')) return categoryName(key);
  // a blackmatrix7 dir with the same key often carries a Chinese display name
  for (const m of intel.bm7.meta.values()) {
    if (m.dir.toLowerCase() === key && /[一-鿿]/.test(m.name)) return m.name;
  }
  return prettify(key);
}

export function bm7Name(dir: string): string {
  return intel.bm7.meta.get(dir)?.name ?? dir;
}

/**
 * Rule set -> service, from the provider URL in the running config, e.g.
 * ".../geo/geosite/openai.mrs" -> geosite:openai, ".../rule/Clash/Whatsapp/Whatsapp.list" -> bm7:Whatsapp.
 * Only service-specific sets count (no cn / private / proxy-style aggregates).
 */
let ruleSetCache: { hash: string; map: Map<string, ServiceInfo> } = { hash: '', map: new Map() };
export function serviceForRuleSet(payload: string): ServiceInfo | null {
  const snap = getSnapshot();
  if (!snap) return null;
  if (ruleSetCache.hash !== snap.running.hash) {
    const map = new Map<string, ServiceInfo>();
    for (const p of snap.providers) {
      const url = p.url ?? '';
      let m = /\/geo\/geosite\/([^/.]+)\.(?:mrs|list|yaml|txt)$/i.exec(url);
      if (m && !isAggregate(m[1].toLowerCase()) && intel.geosite?.categories.has(m[1].toLowerCase())) {
        const key = m[1].toLowerCase();
        map.set(p.name, { id: `geosite:${key}`, name: geositeName(key), source: 'geosite', also: [] });
        continue;
      }
      m = /\/geo\/geoip\/([^/.]+)\.(?:mrs|list|yaml|txt)$/i.exec(url);
      if (m && !['cn', 'private'].includes(m[1].toLowerCase())) {
        map.set(p.name, { id: `geoip:${m[1].toLowerCase()}`, name: geositeName(m[1].toLowerCase()), source: 'geoip', also: [] });
        continue;
      }
      m = /\/rule\/Clash\/([^/]+)\//i.exec(url);
      // catch-all lists (Global, China, Proxy …) were not indexed (count 0) and name no service
      const meta = m ? intel.bm7.meta.get(m[1]) : undefined;
      if (m && meta && meta.count > 0 && meta.count <= 20000 && !intel.bm7Aggregate(m[1]) && !/^(global|china|proxy|direct|lan|domestic)/i.test(m[1])) {
        map.set(p.name, { id: `bm7:${m[1]}`, name: bm7Name(m[1]), source: 'bm7', also: [] });
      }
    }
    ruleSetCache = { hash: snap.running.hash, map };
  }
  return ruleSetCache.map.get(payload) ?? null;
}

/**
 * Picks one service for a host.
 *  1. GeoSite (v2fly/MetaCubeX, curated per service) is the default answer.
 *  2. A blackmatrix7 list wins only when it matches a longer suffix AND its domains mostly sit in the
 *     same GeoSite service — i.e. it is a sub-service ("支付宝" inside alibaba, "FitnessPlus" inside apple).
 *     Mixed lists such as bm7 "Mail" (gmail + outlook + qq …) never win.
 *  3. Bare TLD matches are ignored (geosite google-registry-tld lists "app", "dev" …).
 *  4. Only a category matched -> show the site, with the category alongside.
 *  5. Still nothing specific -> the service of the rule set the connection hit, if that set is service-specific.
 */
export function identifyHost(host: string, ruleSet?: string): ServiceInfo | null {
  const h = host.toLowerCase();
  const site = getDomain(h) ?? undefined;
  const gs = intel.geosite?.match(h) ?? null;
  const gSpecific = gs && !isAggregate(gs.key) ? gs : null;
  const gCategory = gs && isAggregate(gs.key) ? gs : null;

  const bmLevels = intel.bm7.matchHost(h);
  let bm: { dir: string; matched: string } | null = null;
  for (const l of bmLevels) {
    const dirs = l.dirs.filter((d) => !intel.bm7Aggregate(d));
    if (!dirs.length) continue;
    dirs.sort((a, b) => (intel.bm7.meta.get(a)?.count ?? 1e9) - (intel.bm7.meta.get(b)?.count ?? 1e9));
    bm = { dir: dirs[0], matched: l.matched };
    break;
  }

  const also = [
    ...(gs?.all.filter((k) => !isAggregate(k)).map((k) => `geosite:${k}`) ?? []),
    ...bmLevels.flatMap((l) => l.dirs.filter((d) => !intel.bm7Aggregate(d)).map((d) => `bm7:${d}`)),
  ];
  const finish = (s: ServiceInfo): ServiceInfo => ({ ...s, also: [...new Set(also)].filter((x) => x !== s.id) });
  const fromGeo = (g: NonNullable<typeof gs>): ServiceInfo => ({ id: `geosite:${g.key}`, name: geositeName(g.key), source: 'geosite', matched: g.matched, site, also: [] });
  const fromBm = (b: NonNullable<typeof bm>): ServiceInfo => ({ id: `bm7:${b.dir}`, name: bm7Name(b.dir), source: 'bm7', matched: b.matched, site, also: [] });

  if (gSpecific && bm) {
    const fam = intel.bm7Family.get(bm.dir);
    // "www." is not a sub-service (bm7 PrimeVideo lists www.amazon.com)
    const deeper = bm.matched.replace(/^www\./, '').length > gSpecific.matched.length;
    const sameLevel = bm.matched === gSpecific.matched;
    const subService = fam?.key === gSpecific.key && fam.share >= 0.6;
    if (deeper && (subService || !fam?.key)) return finish(fromBm(bm));
    // same suffix: take the bm7 list only if it is a named sub-service (AliPay for *.alipay.com inside alibaba)
    const sameService = bm.dir.toLowerCase().replace(/[^a-z0-9]/g, '') === gSpecific.key.replace(/[^a-z0-9]/g, '');
    if (sameLevel && subService && !sameService && affinity(bm.dir, h) > 0 && (intel.bm7.meta.get(bm.dir)?.count ?? 1e9) * 2 < (intel.geosite?.size(gSpecific.key) ?? 0)) {
      return finish(fromBm(bm));
    }
    return finish(fromGeo(gSpecific));
  }
  if (gSpecific) return finish(fromGeo(gSpecific));
  if (bm) return finish(fromBm(bm));

  const byRule = ruleSet ? serviceForRuleSet(ruleSet) : null;
  if (byRule) return finish({ ...byRule, site });
  if (gCategory) {
    const cat = categoryName(gCategory.key);
    return finish({ id: `geosite:${gCategory.key}`, name: site ?? cat, category: cat, source: 'geosite', matched: gCategory.matched, site, also: [] });
  }
  return site ? { id: `site:${site}`, name: site, source: 'site', site, also: [] } : null;
}

export function providerOf(ip: string): ProviderInfo | null {
  if (!isIPv4(ip)) return null;
  const a = intel.ipdb.lookupAsn(ip);
  const tags = (intel.geoipTags?.lookup(ip) ?? []).filter((t) => t !== 'private');
  return {
    ip,
    asn: a?.asn,
    org: a?.org,
    brand: a ? intel.services.asn[String(a.asn)] : undefined,
    country: intel.ipdb.lookupCountry(ip) || undefined,
    tags,
  };
}

/** Service for a bare IP (no hostname): rule set > geoip tag > blackmatrix7 IP-CIDR > ASN brand/org. */
export function identifyIp(ip: string, provider = providerOf(ip), ruleSet?: string): ServiceInfo | null {
  const byRule = ruleSet ? serviceForRuleSet(ruleSet) : null;
  if (byRule) return byRule;
  if (!provider) return null;
  const bmDirs = intel.bm7.matchIp(ip).filter((d) => !intel.bm7Aggregate(d));
  const tag = provider.tags.find((t) => t !== 'cn');
  const also = [...provider.tags.filter((t) => t !== tag).map((t) => `geoip:${t}`), ...bmDirs.map((d) => `bm7:${d}`)];
  if (tag) return { id: `geoip:${tag}`, name: geositeName(tag), source: 'geoip', also };
  if (bmDirs.length) return { id: `bm7:${bmDirs[0]}`, name: bm7Name(bmDirs[0]), source: 'bm7', also: also.slice(1) };
  if (provider.asn) {
    const asnDirs = intel.bm7.matchAsn(provider.asn).filter((d) => !intel.bm7Aggregate(d));
    if (asnDirs.length) return { id: `bm7:${asnDirs[0]}`, name: bm7Name(asnDirs[0]), source: 'bm7', also };
    return { id: `asn:${provider.asn}`, name: provider.brand ?? provider.org ?? `AS${provider.asn}`, source: 'asn', also };
  }
  return null;
}
