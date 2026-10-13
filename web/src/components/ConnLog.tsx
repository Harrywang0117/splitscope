import { Download, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Device } from '../../../shared/types.ts';
import { useData } from '../api.ts';
import { fmtBytes, fmtDateTime, fmtDuration } from '../lib/format.ts';
import { Card, FallbackTag, GroupChip, KindIcon, RuleBadge, Segmented, Toggle } from './bits.tsx';
import { Favicon, RowMenu } from './data.tsx';

interface LogRow {
  id: string;
  start: number;
  end: number | null;
  src: string;
  src_port: number;
  host: string;
  dst_ip: string;
  dst_port: number;
  network: string;
  rule: string;
  rule_payload: string;
  rule_index: number;
  grp: string;
  chain: string;
  node: string;
  direct: number;
  fallback: string;
  svc_name: string;
  target_ip: string;
  country: string;
  org: string;
  up: number;
  down: number;
  anomaly: string;
  /** connections folded into this row (same device, host, rule and route within a minute) */
  n: number;
}

const SPANS = { '1h': 3_600_000, '6h': 6 * 3_600_000, '24h': 86_400_000, '3d': 3 * 86_400_000, '7d': 7 * 86_400_000 } as const;
type Span = keyof typeof SPANS;
const ANOMALY: Record<string, string> = { expect: '违反预期', cn_proxy: '国内走代理', intl_direct: '境外走直连', fallback: '兜底', udp_fallback: 'UDP 兜底' };
const PAGE = 100;

/** Stored connections (kept for the configured number of days), queried on the server. */
export function ConnLog({ devices, keepDays }: { devices: Map<string, Device>; keepDays: number }) {
  const [span, setSpan] = useState<Span>('24h');
  const [device, setDevice] = useState('');
  const [q, setQ] = useState('');
  const [onlyFallback, setOnlyFallback] = useState(false);
  const [onlyAnomaly, setOnlyAnomaly] = useState(false);
  const [page, setPage] = useState(0);
  // the window is fixed when the filters change, so paging is stable while new rows keep arriving
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setPage(0);
    setNow(Date.now());
  }, [span, device, q, onlyFallback, onlyAnomaly]);

  const filters = useMemo(
    () =>
      new URLSearchParams({
        from: String(now - SPANS[span]),
        to: String(now),
        ...(device ? { src: device } : {}),
        ...(q ? { q } : {}),
        ...(onlyFallback ? { fallback: '1' } : {}),
        ...(onlyAnomaly ? { anomaly: '1' } : {}),
      }),
    [now, span, device, q, onlyFallback, onlyAnomaly],
  );
  const { data, loading } = useData<{ total: number; conns: number; rows: LogRow[] }>(`/api/connlog?${filters}&limit=${PAGE}&offset=${page * PAGE}`, 0);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const deviceList = useMemo(() => [...devices.values()].filter((d) => !d.special || d.special === 'docker').sort((a, b) => a.label.localeCompare(b.label, 'zh')), [devices]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="时间"
          value={span}
          onChange={setSpan}
          options={(Object.keys(SPANS) as Span[]).filter((s) => SPANS[s] <= keepDays * 86_400_000).map((s) => [s, { '1h': '1 小时', '6h': '6 小时', '24h': '24 小时', '3d': '3 天', '7d': '7 天' }[s]] as [Span, string])}
        />
        <label className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="域名、IP、服务、节点、规则" className="h-9 w-full rounded-control bg-page pr-3 pl-9 text-[13px] shadow-card outline-none focus:shadow-[0_0_0_1.5px_var(--accent)]" />
        </label>
        <select value={device} onChange={(e) => setDevice(e.target.value)} className="h-9 max-w-[220px] rounded-control bg-page px-2.5 text-[13px] shadow-card" aria-label="设备">
          <option value="">全部设备</option>
          {deviceList.map((d) => (
            <option key={d.ip} value={d.ip}>
              {d.label} · {d.ip}
            </option>
          ))}
        </select>
        <Toggle on={onlyFallback} set={setOnlyFallback} tone="signal">
          只看兜底
        </Toggle>
        <Toggle on={onlyAnomaly} set={setOnlyAnomaly} tone="signal">
          只看异常
        </Toggle>
        <a href={`/api/connlog/export?${filters}&format=csv`} className="tap inline-flex h-9 items-center gap-1.5 rounded-control bg-page px-3 text-[13px] shadow-card hover:bg-hover">
          <Download className="h-3.5 w-3.5" /> CSV
        </a>
        <a href={`/api/connlog/export?${filters}&format=json`} className="tap inline-flex h-9 items-center gap-1.5 rounded-control bg-page px-3 text-[13px] shadow-card hover:bg-hover">
          <Download className="h-3.5 w-3.5" /> JSON
        </a>
      </div>
      <p className="text-[12px] text-ink-3">
        共 <span className="num font-mono text-ink-2">{total.toLocaleString()}</span> 条
        {data && data.conns > total && (
          <>
            （合计 <span className="num font-mono text-ink-2">{data.conns.toLocaleString()}</span> 次连接：同一设备一分钟内重复连同一个地址、走同一条线路的合并成一条，标着 ×次数）
          </>
        )}
        。连接记录保留 {keepDays} 天（在「数据源」里改）。导出的是当前筛选下的全部记录，不只这一页。
      </p>
      <Card className="overflow-hidden">
        <div className="eyebrow hidden border-b border-dashed border-line-strong px-4 py-2.5 lg:grid lg:grid-cols-[118px_minmax(130px,0.9fr)_minmax(200px,1.6fr)_minmax(150px,1.1fr)_minmax(160px,1.2fr)_96px_24px] lg:gap-4">
          <span>开始</span>
          <span>设备</span>
          <span>目标 · 服务</span>
          <span>命中规则</span>
          <span>线路</span>
          <span className="text-right">流量 · 时长</span>
          <span />
        </div>
        {rows.length === 0 ? (
          <p className="px-4 py-12 text-center text-[13px] text-ink-3">{loading ? '读取中…' : '这段时间没有符合条件的连接记录。'}</p>
        ) : (
          <ul className={`divide-y divide-line ${loading ? 'opacity-60' : ''}`}>
            {rows.map((r) => {
              const d = devices.get(r.src);
              const host = r.host || r.dst_ip;
              const fb = r.fallback === 'match' ? 'match' : r.fallback === 'udp' ? 'udp' : '';
              return (
                <li key={r.id} className={`dense-row flex flex-col gap-1 px-4 py-2 lg:grid lg:grid-cols-[118px_minmax(130px,0.9fr)_minmax(200px,1.6fr)_minmax(150px,1.1fr)_minmax(160px,1.2fr)_96px_24px] lg:items-center lg:gap-4 ${fb ? 'fallback-row' : ''}`}>
                  <span className="num hidden font-mono text-[11.5px] text-ink-2 lg:block">{fmtDateTime(r.start)}</span>
                  <span className="hidden min-w-0 items-center gap-2 lg:flex">
                    <KindIcon kind={d?.kind ?? ''} className="h-3.5 w-3.5 text-ink-3" />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px]">{d?.label ?? r.src}</span>
                      <span className="sub block truncate font-mono text-[11px] text-ink-3">{r.src}</span>
                    </span>
                  </span>
                  <span className="block min-w-0">
                    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[13px]">
                      <Favicon host={host} size={14} />
                      <span className="truncate">{host}</span>
                      <span className="text-ink-3">:{r.dst_port}</span>
                      {r.network === 'udp' && <span className="font-pixel text-[10px] text-ink-3">UDP</span>}
                      {r.n > 1 && (
                        <span className="shrink-0 rounded-chip bg-field px-1 font-pixel text-[10px] text-ink-2" title={`一分钟内 ${r.n} 次同样的连接，已合并`}>
                          ×{r.n}
                        </span>
                      )}
                    </span>
                    <span className="sub flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3">
                      {r.svc_name && <span className="truncate">{r.svc_name}</span>}
                      {r.anomaly &&
                        r.anomaly.split(',').map((a) => (
                          <span key={a} className="rounded-chip bg-signal-bg px-1 font-pixel text-[10px] text-signal">
                            {ANOMALY[a] ?? a}
                          </span>
                        ))}
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <RuleBadge type={r.rule} payload={r.rule_payload} index={r.rule_index} />
                    <FallbackTag kind={fb} />
                    {/* phone: the route sits on the rule's line */}
                    <span className="flex min-w-0 items-center gap-1.5 lg:hidden">
                      <GroupChip name={r.grp} />
                      <span className="truncate text-[12px] text-ink-2">{r.node}</span>
                    </span>
                  </span>
                  <span className="hidden min-w-0 items-center gap-1.5 lg:flex">
                    <GroupChip name={r.grp} />
                    <span className="truncate text-[12px] text-ink-2" title={r.chain}>
                      {r.node}
                    </span>
                  </span>
                  <span className="num hidden font-mono text-[11.5px] lg:block lg:text-right">
                    {fmtBytes(r.up + r.down)}
                    <span className="sub block text-ink-3">{r.end ? fmtDuration(r.end - r.start) : '进行中'}</span>
                  </span>
                  <span className="num flex min-w-0 flex-wrap gap-x-2 font-mono text-[11.5px] text-ink-3 lg:hidden">
                    <span>{fmtDateTime(r.start)}</span>
                    <span className="min-w-0 truncate font-sans text-ink-2">{d?.label ?? r.src}</span>
                    <span>
                      {fmtBytes(r.up + r.down)} · {r.end ? fmtDuration(r.end - r.start) : '进行中'}
                    </span>
                  </span>
                  <span className="hidden justify-end lg:flex">
                    <RowMenu host={host} from="连接记录" />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {total > PAGE && (
          <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[12px] text-ink-2">
            <span className="num font-mono">
              {page * PAGE + 1}–{Math.min((page + 1) * PAGE, total)} / {total.toLocaleString()}
            </span>
            <span className="flex gap-1">
              <button disabled={page === 0} onClick={() => setPage(page - 1)} className="tap rounded-chip px-2 py-1 hover:bg-hover disabled:opacity-35">
                上一页
              </button>
              <button disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)} className="tap rounded-chip px-2 py-1 hover:bg-hover disabled:opacity-35">
                下一页
              </button>
            </span>
          </div>
        )}
      </Card>
    </div>
  );
}
