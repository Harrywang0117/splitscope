import type { Candidate, ProbeTarget, TargetKind } from '../../shared/types.ts';
import { intToIp, ipToInt, isIPv4 } from '../enrich/geoip.ts';
import { DomainType, isAggregate } from '../enrich/geosite.ts';
import { intel } from '../enrich/intel.ts';
import { bm7Name, geositeName } from '../enrich/service.ts';
import { curatedLists, curatedTargets } from './curated.ts';

export type InputKind = 'domain' | 'ip' | 'cidr' | 'name';

export function classifyInput(raw: string): { kind: InputKind; value: string } {
  let s = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      /* keep as is */
    }
  }
  s = s.replace(/^\[|\]$/g, '');
  const cidr = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(s);
  if (cidr && isIPv4(cidr[1]) && Number(cidr[2]) <= 32) return { kind: 'cidr', value: s };
  if (isIPv4(s)) return { kind: 'ip', value: s };
  const hostPort = /^([a-z0-9_.-]+\.[a-z0-9-]{2,})(?::\d+)?(?:\/.*)?$/i.exec(s);
  if (hostPort && !/\s/.test(s)) return { kind: 'domain', value: hostPort[1].toLowerCase().replace(/\.$/, '') };
  return { kind: 'name', value: raw.trim() };
}

/** First usable host address of a CIDR (the address itself for /31 and /32). */
export function cidrSample(cidr: string): string {
  const [ip, b] = cidr.split('/');
  const bits = Number(b);
  const n = ipToInt(ip);
  if (n < 0 || !Number.isInteger(bits)) return '';
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const net = (n & mask) >>> 0;
  return intToIp(bits >= 31 ? net : net + 1);
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '');

export function searchCandidates(q: string): Candidate[] {
  const query = norm(q);
  if (!query) return [];
  const scored = new Map<string, { c: Candidate; score: number }>();
  const put = (c: Candidate, score: number) => {
    const prev = scored.get(c.id);
    if (!prev || prev.score < score) scored.set(c.id, { c, score });
  };
  const geoCand = (key: string, reason: string): Candidate | null => {
    const entries = intel.geosite?.categories.get(key);
    return entries ? { id: `geosite:${key}`, source: 'geosite', key, name: geositeName(key), count: entries.length, reason } : null;
  };
  const bmCand = (dir: string, reason: string): Candidate | null => {
    const m = intel.bm7.meta.get(dir);
    return m ? { id: `bm7:${dir}`, source: 'bm7', key: dir, name: m.name, category: m.category, count: m.count, reason } : null;
  };

  // hand-assembled lists rank first when their name or an alias matches
  for (const l of curatedLists()) {
    const names = [l.name, l.id, ...l.aliases].map(norm);
    const exact = names.some((n) => n === query);
    const partial = query.length >= 2 && names.some((n) => n.includes(query) || query.includes(n));
    if (exact || partial) {
      put({ id: `curated:${l.id}`, source: 'curated', key: l.id, name: l.name, count: l.entries.length, reason: `整理清单 · ${l.updated}` }, exact ? 140 : 95);
    }
  }

  // curated aliases (Chinese names, nicknames)
  for (const [alias, ids] of Object.entries(intel.services.aliases)) {
    const a = norm(alias);
    if (a !== query && !(query.length >= 2 && (a.includes(query) || query.includes(a)))) continue;
    for (const id of ids) {
      const [src, key] = id.split(':');
      const c = src === 'geosite' ? geoCand(key, `别名「${alias}」`) : bmCand(key, `别名「${alias}」`);
      if (c) put(c, a === query ? 120 : 85);
    }
  }

  if (intel.geosite) {
    for (const key of intel.geosite.categories.keys()) {
      const k = norm(key);
      const name = norm(geositeName(key));
      let score = 0;
      if (k === query || name === query) score = 100;
      else if (isAggregate(key)) continue;
      else if (k.startsWith(query) || name.startsWith(query)) score = 75;
      else if (query.length >= 3 && (k.includes(query) || name.includes(query))) score = 55;
      if (score) {
        const c = geoCand(key, 'GeoSite 分类');
        if (c) put(c, score);
      }
    }
  }

  for (const m of intel.bm7.meta.values()) {
    const d = norm(m.dir);
    const n = norm(m.name);
    let score = 0;
    if (d === query || n === query) score = 110;
    else if (d.startsWith(query) || n.startsWith(query)) score = 80;
    else if (query.length >= 2 && (d.includes(query) || n.includes(query))) score = 60;
    if (score) {
      const c = bmCand(m.dir, 'blackmatrix7 规则');
      if (c) put(c, score);
    }
  }

  return [...scored.values()]
    .sort((a, b) => b.score - a.score || a.c.count - b.c.count)
    .slice(0, 30)
    .map((x) => x.c);
}

/** Lists that contain a domain or IP ("whose is this?"). */
export function reverseCandidates(kind: InputKind, value: string): Candidate[] {
  const out: Candidate[] = [];
  if (kind === 'domain') {
    const gs = intel.geosite?.match(value);
    for (const key of (gs?.all ?? []).filter((k) => !isAggregate(k))) {
      const entries = intel.geosite?.categories.get(key);
      if (entries) out.push({ id: `geosite:${key}`, source: 'geosite', key, name: geositeName(key), count: entries.length, reason: '包含该域名' });
    }
    for (const l of intel.bm7.matchHost(value)) {
      for (const dir of l.dirs) {
        const m = intel.bm7.meta.get(dir);
        if (m) out.push({ id: `bm7:${dir}`, source: 'bm7', key: dir, name: m.name, category: m.category, count: m.count, reason: `包含 ${l.matched}` });
      }
    }
  } else if (kind === 'ip' || kind === 'cidr') {
    const ip = kind === 'cidr' ? cidrSample(value) : value;
    for (const dir of intel.bm7.matchIp(ip)) {
      const m = intel.bm7.meta.get(dir);
      if (m) out.push({ id: `bm7:${dir}`, source: 'bm7', key: dir, name: m.name, category: m.category, count: m.count, reason: '包含该 IP 段' });
    }
  }
  return out;
}

function geositeTargets(key: string): ProbeTarget[] {
  const from = [`geosite:${key}`];
  return (intel.geosite?.categories.get(key) ?? []).map((e) => {
    const attrs = e.attrs?.length ? ` @${e.attrs.join(' @')}` : '';
    switch (e.t) {
      case DomainType.Full:
        return { value: e.v, kind: 'domain', test: e.v, from, note: attrs || undefined };
      case DomainType.Suffix:
        return { value: e.v, kind: 'suffix', test: e.v, from, note: attrs || undefined };
      case DomainType.Keyword:
        return { value: e.v, kind: 'keyword', test: `${e.v}.com`, from, note: `关键词规则，用 ${e.v}.com 示例测试${attrs}` };
      default:
        return { value: e.v, kind: 'regex', test: '', from, note: '正则规则，无法生成测试域名' };
    }
  });
}

function bm7Targets(dir: string): ProbeTarget[] {
  const from = [`bm7:${dir}`];
  return intel.bm7.rules(dir).map(([type, value]): ProbeTarget => {
    switch (type) {
      case 'DOMAIN':
        return { value, kind: 'domain', test: value, from };
      case 'DOMAIN-SUFFIX':
        return { value, kind: 'suffix', test: value, from };
      case 'DOMAIN-KEYWORD':
        return { value, kind: 'keyword', test: `${value}.com`, from, note: `关键词规则，用 ${value}.com 示例测试` };
      case 'IP-CIDR':
        return { value, kind: 'cidr', test: cidrSample(value), from, note: '取段内第一个地址测试' };
      case 'IP-CIDR6':
        return { value, kind: 'cidr', test: '', from, note: 'IPv6 段，当前网络未启用 IPv6' };
      case 'IP-ASN':
        return { value, kind: 'asn', test: '', from, note: 'ASN 规则无法反推具体 IP' };
      case 'PROCESS-NAME':
        return { value, kind: 'process', test: '', from, note: '进程规则只在本机客户端生效' };
      default:
        return { value: `${type},${value}`, kind: 'other' as TargetKind, test: '', from, note: `${type} 规则不测试` };
    }
  });
}

/** Expands candidate ids into a de-duplicated target list. */
export function expandCandidates(ids: string[]): ProbeTarget[] {
  const merged = new Map<string, ProbeTarget>();
  for (const id of ids) {
    const [src, ...rest] = id.split(':');
    const key = rest.join(':');
    const list = src === 'geosite' ? geositeTargets(key) : src === 'bm7' ? bm7Targets(key) : src === 'curated' ? curatedTargets(key, cidrSample) : [];
    for (const t of list) {
      const k = `${t.kind}|${t.value}`;
      const prev = merged.get(k);
      if (prev) {
        for (const f of t.from) if (!prev.from.includes(f)) prev.from.push(f);
      } else merged.set(k, { ...t, from: [...t.from] });
    }
  }
  return [...merged.values()];
}

export function targetFromInput(kind: InputKind, value: string): ProbeTarget {
  if (kind === 'cidr') return { value, kind: 'cidr', test: cidrSample(value), from: ['输入'], note: '取段内第一个地址测试' };
  if (kind === 'ip') return { value, kind: 'ip', test: value, from: ['输入'] };
  return { value, kind: 'domain', test: value, from: ['输入'] };
}

export { bm7Name };
