import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getJson } from '../api.ts';
import { Card, GroupChip, RuleBadge, rise, SectionHead } from '../components/bits.tsx';
import { RuleTrack } from '../components/RuleTrack.tsx';
import { fmtAgo, groupColor } from '../lib/format.ts';

interface Snap {
  running: { rules: { index: number; type: string; payload: string; target: string; hitCount?: number }[] };
  groups: { name: string; type: string; now?: string; all: string[] }[];
  providers: { name: string; behavior: string; format: string; count: number; updatedAt?: string; url?: string }[];
  customRules: string[];
  configPath: string;
}

const GROUP_TYPE: Record<string, string> = { Selector: '手动', URLTest: '自动测速', Fallback: '故障转移', LoadBalance: '负载均衡', Relay: '链式' };

export function Rules({ metaVersion }: { metaVersion: number }) {
  const [snap, setSnap] = useState<Snap | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    getJson<{ snapshot: Snap | null }>('/api/snapshot').then((r) => setSnap(r.snapshot)).catch(() => undefined);
  }, [metaVersion]);

  const groupMap = useMemo(() => new Map(snap?.groups.map((g) => [g.name, g]) ?? []), [snap]);
  const providerMap = useMemo(() => new Map(snap?.providers.map((p) => [p.name, p]) ?? []), [snap]);
  const custom = useMemo(() => new Set((snap?.customRules ?? []).map((k) => k.toLowerCase())), [snap]);

  if (!snap) return <p className="py-10 text-center text-ink-2">正在读取配置…</p>;

  const resolveChain = (name: string) => {
    const chain: string[] = [];
    let cur = groupMap.get(name);
    const seen = new Set<string>();
    while (cur?.now && !seen.has(cur.name)) {
      seen.add(cur.name);
      chain.push(cur.now);
      cur = groupMap.get(cur.now);
    }
    return chain;
  };

  const rules = snap.running.rules;
  const hits = new Map(rules.filter((r) => (r.hitCount ?? 0) > 0).map((r) => [r.index, r.hitCount!]));
  const udpIndex = rules.find((r) => r.type === 'Network' && r.payload === 'udp')?.index;
  const filtered = rules.filter((r) => !q || `${r.type} ${r.payload} ${r.target}`.toLowerCase().includes(q.toLowerCase()));
  const usedGroups = snap.groups.filter((g) => rules.some((r) => r.target === g.name));

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SectionHead className="rise" style={rise(0)} title="命中分布" desc="内核自 OpenClash 上次启动以来，每条规则拦下了多少连接" />
        <Card className="rise px-5 pt-4 pb-3.5" style={rise(1)}>
          <RuleTrack rules={rules} hits={hits} udpIndex={udpIndex} barHeight={64} />
        </Card>
      </section>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section className="min-w-0 space-y-3">
          <SectionHead
            className="rise"
            style={rise(2)}
            title="规则顺序"
            desc={`${rules.length} 条，从上往下匹配`}
            aside={
              <label className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="筛选规则" className="h-8 w-48 rounded-control bg-page pr-2 pl-8 text-[13px] shadow-card outline-none focus:shadow-[0_0_0_1.5px_var(--accent)]" aria-label="筛选规则" />
              </label>
            }
          />
          <Card className="rise overflow-hidden" style={rise(3)}>
            <ul className="divide-y divide-line">
              {filtered.map((r) => {
                const key = `${r.type},${r.payload},${r.target}`.toLowerCase();
                const p = r.type === 'RuleSet' ? providerMap.get(r.payload) : undefined;
                return (
                  <li key={r.index} className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_64px] items-center gap-3 px-4 py-2 hover:bg-hover">
                    <span className="min-w-0">
                      <RuleBadge type={r.type} payload={r.payload} index={r.index} />
                      {(custom.has(key) || p) && (
                        <span className="block truncate text-[11.5px] text-ink-3" title={p?.url}>
                          {custom.has(key) && 'OpenClash 自定义规则'}
                          {p && `${p.count} 条 · ${p.format.replace('Rule', '')} · 更新于 ${p.updatedAt ? fmtAgo(Date.parse(p.updatedAt)) : '—'}`}
                        </span>
                      )}
                    </span>
                    <span className="min-w-0">
                      <GroupChip name={r.target} />
                    </span>
                    <span className="num text-right font-mono text-[11.5px] text-ink-2">{(r.hitCount ?? 0).toLocaleString()}</span>
                  </li>
                );
              })}
            </ul>
          </Card>
        </section>

        <section className="min-w-0 space-y-3">
          <SectionHead className="rise" style={rise(2)} title="策略组当前选择" desc={`${usedGroups.length} 个被规则引用`} />
          <Card className="rise overflow-hidden" style={rise(3)}>
            <ul className="divide-y divide-line">
              {usedGroups.map((g) => {
                const chain = resolveChain(g.name);
                return (
                  <li key={g.name} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <GroupChip name={g.name} />
                      <span className="font-pixel text-[10.5px] text-ink-3">{GROUP_TYPE[g.type] ?? g.type}</span>
                    </div>
                    {chain.length > 0 && (
                      <p className="mt-1.5 flex flex-wrap items-center gap-1 text-[12px] text-ink-2">
                        {chain.map((n, i) => (
                          <span key={i} className="flex items-center gap-1">
                            <span className="h-[2px] w-2.5 rounded" style={{ background: groupColor(g.name) }} />
                            <span className={i === chain.length - 1 ? 'text-ink' : ''}>{n}</span>
                          </span>
                        ))}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        </section>
      </div>
    </div>
  );
}
