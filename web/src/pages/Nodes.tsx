import { Gauge, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { sendJson, useData, type Range } from '../api.ts';
import { Button, Card, GroupChip, rise, SectionHead, Segmented, Toggle, useToast } from '../components/bits.tsx';
import { Country, Flag } from '../components/data.tsx';
import { fmtAgo, fmtBytes } from '../lib/format.ts';

interface Node {
  name: string;
  type: string;
  region: string;
  provider: string;
  bytes: number;
  up: number;
  down: number;
  conns: number;
  last: number;
  services: { label: string; bytes: number }[];
  usedBy: string[];
}

interface ProviderInfo {
  name: string;
  vehicle: string;
  nodes: number;
  notes: string[];
  used?: number;
  total?: number;
  expire?: number;
  updatedAt?: string;
}

interface DelayResult {
  name: string;
  delay: number;
  at: number;
}

function delayColor(d: number | undefined) {
  if (d === undefined) return 'var(--ink-3)';
  if (d < 0) return 'var(--stop)';
  if (d < 250) return 'var(--go)';
  if (d < 600) return 'var(--signal)';
  return 'var(--stop)';
}

export function Nodes({ range }: { range: Range }) {
  const { data, loading, reload } = useData<{ nodes: Node[]; delays: Record<string, DelayResult>; providers: ProviderInfo[] }>(`/api/nodes?range=${range}`, 120_000);
  const [onlyUsed, setOnlyUsed] = useState(true);
  const [sort, setSort] = useState<'traffic' | 'delay' | 'name'>('traffic');
  const [q, setQ] = useState(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('q') ?? '');
  const [testing, setTesting] = useState(false);
  const [delays, setDelays] = useState<Record<string, DelayResult>>({});
  const toast = useToast();

  const all = useMemo(() => ({ ...(data?.delays ?? {}), ...delays }), [data, delays]);
  const nodes = useMemo(() => {
    let list = (data?.nodes ?? []).filter((n) => !onlyUsed || n.bytes > 0 || n.usedBy.length > 0);
    if (q) list = list.filter((n) => `${n.name} ${n.provider} ${n.usedBy.join(' ')}`.toLowerCase().includes(q.toLowerCase()));
    const d = (n: Node) => {
      const v = all[n.name]?.delay;
      return v === undefined ? 1e9 : v < 0 ? 1e8 : v;
    };
    return [...list].sort((a, b) => (sort === 'traffic' ? b.bytes - a.bytes : sort === 'delay' ? d(a) - d(b) : a.name.localeCompare(b.name, 'zh')));
  }, [data, onlyUsed, sort, q, all]);
  const max = Math.max(1, ...nodes.map((n) => n.bytes));

  const test = async (names: string[]) => {
    if (!names.length) return;
    setTesting(true);
    try {
      const { results } = await sendJson<{ results: DelayResult[] }>('/api/nodes/delay', 'POST', { names });
      setDelays((m) => ({ ...m, ...Object.fromEntries(results.map((r) => [r.name, r])) }));
      const ok = results.filter((r) => r.delay >= 0).length;
      toast(`测速完成：${ok}/${results.length} 个节点可用`);
    } catch (e) {
      toast(`测速失败：${(e as Error).message}`, 'error');
    }
    setTesting(false);
    reload();
  };

  return (
    <div className="space-y-4">
      <SectionHead
        className="rise"
        style={rise(0)}
        title="出口节点"
        desc="测速经节点请求 gstatic 的 generate_204，只发一个很小的请求"
        aside={
          <span className="flex flex-wrap items-center gap-2">
            <label className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="筛选节点" className="h-9 w-40 rounded-control bg-page pr-2 pl-8 text-[13px] shadow-card outline-none focus:shadow-[0_0_0_1.5px_var(--accent)]" />
            </label>
            <Toggle on={onlyUsed} set={setOnlyUsed}>
              只看在用的
            </Toggle>
            <Segmented
              label="排序"
              value={sort}
              onChange={setSort}
              options={[
                ['traffic', '流量'],
                ['delay', '延迟'],
                ['name', '名称'],
              ]}
            />
            <Button kind="primary" disabled={testing || !nodes.length} onClick={() => void test(nodes.map((n) => n.name))}>
              <Gauge className={`h-3.5 w-3.5 ${testing ? 'animate-spin' : ''}`} />
              {testing ? '测速中…' : `测速 ${nodes.length} 个`}
            </Button>
          </span>
        }
      />
      {(data?.providers.length ?? 0) > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {data!.providers.map((p, i) => {
            // providers report "unlimited" as an absurd total / an expiry decades away
            const unlimited = !!p.total && p.total > 1e15;
            const share = p.used != null && p.total && !unlimited ? p.used / p.total : null;
            const days = p.expire && p.expire - Date.now() < 10 * 365 * 86_400_000 ? Math.ceil((p.expire - Date.now()) / 86_400_000) : null;
            return (
              <Card key={p.name} className="rise px-4 py-3" style={rise(i + 1)}>
                <p className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[13.5px] font-medium">{p.name}</span>
                  <span className="flex-none font-mono text-[11px] text-ink-3">
                    {p.nodes} 个节点 · {p.vehicle === 'Inline' ? '内联' : '订阅'}
                  </span>
                </p>
                {share != null && (
                  <>
                    <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-field">
                      <span className="block h-full rounded-full transition-[width] duration-700 ease-(--ease-out)" style={{ width: `${Math.min(100, share * 100)}%`, background: share > 0.85 ? 'var(--stop)' : share > 0.6 ? 'var(--signal)' : 'var(--accent)' }} />
                    </span>
                    <span className="mt-1 block font-mono text-[11px] text-ink-3">
                      已用 {fmtBytes(p.used!)} / {fmtBytes(p.total!)}
                    </span>
                  </>
                )}
                {unlimited && p.used != null && <span className="mt-2 block font-mono text-[11px] text-ink-3">已用 {fmtBytes(p.used)} · 不限量</span>}
                {days != null && <span className={`block text-[11.5px] ${days <= 7 ? 'text-signal' : 'text-ink-3'}`}>{days > 0 ? `${days} 天后到期` : '已到期'}</span>}
                {share == null && p.notes.length > 0 && <span className="mt-1 block truncate text-[11.5px] text-ink-3">{p.notes.join(' · ')}</span>}
              </Card>
            );
          })}
        </div>
      )}
      <Card className="rise overflow-hidden" style={rise(1)}>
        <div className="eyebrow hidden border-b border-dashed border-line-strong px-4 py-2.5 lg:grid lg:grid-cols-[minmax(220px,1.5fr)_minmax(160px,1.2fr)_minmax(160px,1.1fr)_90px_88px] lg:gap-4">
          <span>节点</span>
          <span>被哪些策略组选中</span>
          <span>流量 · 主要服务</span>
          <span className="text-right">延迟</span>
          <span className="text-right">最后</span>
        </div>
        {nodes.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] text-ink-3">{loading ? '读取中…' : '没有符合条件的节点。'}</p>
        ) : (
          <ul className="divide-y divide-line">
            {nodes.map((n, i) => {
              const d = all[n.name];
              return (
                <li key={n.name} className="rise px-4 py-2.5 lg:grid lg:grid-cols-[minmax(220px,1.5fr)_minmax(160px,1.2fr)_minmax(160px,1.1fr)_90px_88px] lg:items-center lg:gap-4" style={rise(Math.min(i, 20))}>
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span title={n.region}>
                      <Flag code={n.region} size={18} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-medium">{n.name}</span>
                      <span className="block truncate text-[11.5px] text-ink-3">
                        {n.type}
                        {n.provider ? ` · 订阅 ${n.provider}` : ''}
                        {n.region !== '?' ? ' · ' : ''}
                        {n.region !== '?' && <Country code={n.region} />}
                      </span>
                    </span>
                  </span>
                  <span className="mt-1.5 flex min-w-0 flex-wrap gap-1 lg:mt-0">
                    {n.usedBy.length ? n.usedBy.slice(0, 6).map((g) => <GroupChip key={g} name={g} dim />) : <span className="text-[12px] text-ink-3">当前没有策略组选它</span>}
                    {n.usedBy.length > 6 && <span className="text-[12px] text-ink-3">等 {n.usedBy.length} 个</span>}
                  </span>
                  <span className="mt-1.5 block min-w-0 lg:mt-0">
                    <span className="flex items-center gap-2">
                      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-field">
                        <span className="block h-full rounded-full bg-accent transition-[width] duration-700 ease-(--ease-out)" style={{ width: `${(n.bytes / max) * 100}%` }} />
                      </span>
                      <span className="num w-16 text-right font-mono text-[11.5px]">{fmtBytes(n.bytes)}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-ink-3">{n.services.map((s) => s.label).join('、') || '—'}</span>
                  </span>
                  <button
                    onClick={() => void test([n.name])}
                    disabled={testing}
                    className="tap mt-1 inline-flex items-center justify-end gap-1.5 rounded-chip px-1.5 py-0.5 font-mono text-[12px] hover:bg-hover lg:mt-0 lg:w-full"
                    title={d ? `测于 ${fmtAgo(d.at)}，点击重测` : '点击测速'}
                  >
                    <span className="lamp" style={{ color: delayColor(d?.delay) }} />
                    <span style={{ color: delayColor(d?.delay) }}>{d ? (d.delay < 0 ? '超时' : `${d.delay}ms`) : '测速'}</span>
                  </button>
                  <span className="hidden text-right text-[11.5px] text-ink-3 lg:block">{n.last ? fmtAgo(n.last) : '—'}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
