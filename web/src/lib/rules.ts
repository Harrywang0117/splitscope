import type { ProbeTarget } from '../../../shared/types.ts';

/** Turns a tested target plus the group it should go to into a Clash rule line. */
export function ruleFor(t: ProbeTarget, group: string, domainAsSuffix = false): string | null {
  switch (t.kind) {
    case 'domain':
      return `${domainAsSuffix ? 'DOMAIN-SUFFIX' : 'DOMAIN'},${t.value},${group}`;
    case 'suffix':
      return `DOMAIN-SUFFIX,${t.value},${group}`;
    case 'keyword':
      return `DOMAIN-KEYWORD,${t.value},${group}`;
    case 'ip':
      return `IP-CIDR,${t.value}/32,${group},no-resolve`;
    case 'cidr':
      return `IP-CIDR,${t.value},${group},no-resolve`;
    case 'asn':
      return `IP-ASN,${t.value},${group},no-resolve`;
    default:
      return null;
  }
}

/** YAML list item; quoted only when the line would otherwise parse as something else. */
export function yamlItem(line: string): string {
  return /(:\s|\s#)|^[*&!%@`'"{[|>?-]/.test(line) ? `  - '${line.replace(/'/g, "''")}'` : `  - ${line}`;
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((n, x) => n * 256 + Number(x), 0) >>> 0;
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, b] = cidr.split('/');
  const bits = Number(b);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(base) & mask) >>> 0);
}

export interface Adjustment {
  target: ProbeTarget;
  from: string;
  to: string;
  /** rule index the target currently stops at */
  hitIndex: number;
}

/** The other adjustment whose rule already sends this one to the same group, if any. */
function coverOf(a: Adjustment, all: Adjustment[], domainAsSuffix = false): Adjustment | undefined {
  const v = a.target.value.toLowerCase();
  if (a.target.kind === 'domain' || a.target.kind === 'suffix')
    return all.find(
      (s) => s !== a && s.to === a.to && (s.target.kind === 'suffix' || (domainAsSuffix && s.target.kind === 'domain')) && v.endsWith(`.${s.target.value.toLowerCase()}`),
    );
  if (a.target.kind === 'ip') return all.find((c) => c !== a && c.to === a.to && c.target.kind === 'cidr' && inCidr(a.target.value, c.target.value));
  return undefined;
}

/**
 * Rule lines for a set of adjustments, dropping entries made redundant by another adjustment to the
 * same group (www.x.com under DOMAIN-SUFFIX x.com, a single IP inside an adjusted CIDR).
 */
export function buildRules(adjs: Adjustment[], domainAsSuffix = false): { lines: string[]; skipped: number } {
  const lines: string[] = [];
  let skipped = 0;
  for (const a of adjs) {
    if (coverOf(a, adjs, domainAsSuffix)) {
      skipped++;
      continue;
    }
    const line = ruleFor(a.target, a.to, domainAsSuffix);
    if (line && !lines.includes(line)) lines.push(line);
    else if (!line) skipped++;
  }
  return { lines, skipped };
}

export interface RuleBlock {
  /** index of the rule these lines must precede; -1 = no known position, put them first */
  before: number;
  lines: string[];
}

/**
 * Rule lines grouped by where they have to go. A line must sit before the rule its target stops at
 * today; a line that also covers other entries (a suffix over www.…, a CIDR over an IP) must sit
 * before the earliest of those, or the covered ones would still stop at their old rule.
 */
export function planBlocks(adjs: Adjustment[]): { blocks: RuleBlock[]; skipped: number } {
  // the entry whose line will actually be written for `a` (follows www.a.x -> a.x -> x)
  const root = (a: Adjustment) => {
    let top = a;
    const seen = new Set([a]);
    for (let c = coverOf(top, adjs); c && !seen.has(c); c = coverOf(top, adjs)) {
      seen.add(c);
      top = c;
    }
    return top;
  };
  const place = new Map<Adjustment, number>();
  let skipped = 0;
  for (const a of adjs) {
    const top = root(a);
    if (top !== a) skipped++;
    const at = a.hitIndex < 0 ? -1 : a.hitIndex;
    const cur = place.get(top);
    place.set(top, cur === undefined ? at : cur < 0 || at < 0 ? -1 : Math.min(cur, at));
  }
  const byPos = new Map<number, string[]>();
  for (const [a, at] of place) {
    const line = ruleFor(a.target, a.to);
    if (!line) {
      skipped++;
      continue;
    }
    const list = byPos.get(at) ?? [];
    if (!list.includes(line)) list.push(line);
    byPos.set(at, list);
  }
  const blocks = [...byPos].sort(([x], [y]) => x - y).map(([before, lines]) => ({ before, lines }));
  return { blocks, skipped };
}
