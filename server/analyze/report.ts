import type { AnalysisSummary, ProbeResult, Suggestion } from '../../shared/types.ts';
import { ipToInt, isIPv4 } from '../enrich/geoip.ts';
import { scopeOf } from '../enrich/scope.ts';
import { expectationFor } from '../history/cases.ts';
import { homeGroups } from '../history/queries.ts';

function inCidr(ip: string, cidr: string): boolean {
  const [base, b] = cidr.split('/');
  const bits = Number(b);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(base) & mask) >>> 0);
}

const isFallback = (r: ProbeResult) => r.rule?.type === 'Match' || r.rule?.type === 'Network';

function ruleLine(r: ProbeResult, group: string): string | null {
  const t = r.target;
  switch (t.kind) {
    case 'domain':
      return `DOMAIN,${t.value},${group}`;
    case 'suffix':
      return `DOMAIN-SUFFIX,${t.value},${group}`;
    case 'keyword':
      return `DOMAIN-KEYWORD,${t.value},${group}`;
    case 'ip':
      return `IP-CIDR,${t.value}/32,${group},no-resolve`;
    case 'cidr':
      return `IP-CIDR,${t.value},${group},no-resolve`;
    default:
      return null;
  }
}

export function summarize(query: string, results: ProbeResult[]): AnalysisSummary {
  const routed = results.filter((r) => r.status === 'ok' || r.status === 'dial-error');
  const counts = new Map<string, number>();
  for (const r of routed) counts.set(r.group ?? '?', (counts.get(r.group ?? '?') ?? 0) + 1);
  const byGroup = [...counts].map(([group, count]) => ({ group, count })).sort((a, b) => b.count - a.count);

  const fallback = routed.filter(isFallback);
  const udpDiffers = routed.filter((r) => r.udp).length;
  const warnings: string[] = [];
  const suggestions: string[] = [];

  const ruled = byGroup.filter((g) => !fallback.some((f) => f.group === g.group));
  if (byGroup.length > 1) {
    warnings.push(`这些目标分散在 ${byGroup.length} 个策略组：${byGroup.map((g) => `${g.group} ${g.count}`).join('、')}`);
  }
  if (fallback.length) {
    warnings.push(`${fallback.length} 个目标没有被任何具体规则命中，落到兜底「${fallback[0].group}」`);
  }
  if (udpDiffers) {
    warnings.push(`${udpDiffers} 个目标走 UDP/QUIC 时会落到「${routed.find((r) => r.udp)?.udp?.group}」，与 TCP 不同`);
  }
  const failed = results.filter((r) => r.status === 'timeout' || r.status === 'error').length;
  if (failed) warnings.push(`${failed} 个目标探测失败（超时或连接错误），结果未计入`);

  // groups other than the majority are worth a look, but only fallback hits get a rule suggestion:
  // a target that already hit a specific rule (e.g. iOS location -> Apple) was routed on purpose
  const majority = ruled[0]?.group;
  const others = routed.filter((r) => !isFallback(r) && majority && r.group !== majority);
  if (others.length && byGroup.length > 1) {
    const names = [...new Set(others.map((r) => r.group))].join('、');
    warnings.push(`${others.length} 个目标被其他规则分到了「${names}」，确认一下是否符合预期`);
  }
  // single IPs already covered by a fallback CIDR target collapse into that one CIDR rule
  const cidrs = fallback.filter((r) => r.target.kind === 'cidr').map((r) => r.target.value);
  const suggested = fallback
    .filter((x) => x.target.kind !== 'ip' || !cidrs.some((c) => inCidr(x.target.value, c)))
    .slice(0, 50)
    .map((r) => suggestFor(r, routed));
  for (const s of suggested) if (s.line && !suggestions.includes(s.line)) suggestions.push(s.line);

  return {
    query,
    total: results.length,
    tested: routed.length,
    byGroup,
    fallback: fallback.length,
    udpDiffers,
    warnings,
    suggestions,
    suggested,
  };
}

/**
 * Where a fallback target probably belongs, judged on its own (a batch of unrelated targets has
 * no meaningful majority): the user's expectation, else how the config routes other targets of
 * the same service, else the domestic group when the target is in China. No guess otherwise.
 */
function suggestFor(r: ProbeResult, routed: ProbeResult[]): Suggestion {
  const t = r.target;
  const base = { kind: t.kind, value: t.value };
  const done = (group: string, basis: Suggestion['basis'], why: string): Suggestion => ({ ...base, group, basis, why, line: group ? ruleLine(r, group) : null });
  const home = homeGroups();

  const host = t.kind === 'domain' || t.kind === 'suffix' ? t.value : '';
  const ip = t.kind === 'ip' ? t.value : t.kind === 'cidr' ? t.test : (r.resolved?.[0]?.ip ?? '');
  const exp = expectationFor(host, isIPv4(ip) ? ip : '');
  if (exp) {
    if (exp.grp === '@direct') return done(home.domestic, 'expect', `你的预期是直连（${exp.value}），用直连组「${home.domestic}」`);
    if (exp.grp === '@proxy') return done('', 'none', `你的预期是「任意代理」（${exp.value}），选一个具体的代理组`);
    return done(exp.grp, 'expect', `按你的预期（${exp.value} → ${exp.grp}）`);
  }

  const svc = r.service;
  if (svc) {
    const votes = new Map<string, number>();
    for (const x of routed) if (!isFallback(x) && x.group && x.service?.id === svc.id) votes.set(x.group, (votes.get(x.group) ?? 0) + 1);
    const best = [...votes].sort((a, b) => b[1] - a[1])[0];
    if (best) return done(best[0], 'sibling', `同属「${svc.name}」的其他 ${best[1]} 个目标被规则分到「${best[0]}」`);
  }

  if (scopeOf(host, ip, r.resolved?.[0]?.country ?? '') === 'cn') return done(home.domestic, 'cn', `目标在国内，用直连组「${home.domestic}」`);
  const where = r.resolved?.[0]?.country;
  return done('', 'none', `${where ? `目标在 ${where}，` : ''}没有预期也没有同服务的参照，自己选`);
}
