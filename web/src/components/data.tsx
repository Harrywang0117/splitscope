import { ArrowDown, ArrowUp, Copy, Download, FlaskConical, MoreHorizontal, Plus, Search } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Device } from '../../../shared/types.ts';
import { useData, type Range } from '../api.ts';
import { navigate } from '../App.tsx';
import { basket, targetOf } from '../lib/basket.ts';
import { downloadCsv } from '../lib/csv.ts';
import { fmtAgo, fmtBytes, groupColor } from '../lib/format.ts';
import { Card, GroupChip, Segmented, useToast } from './bits.tsx';

/* ---------- small atoms ---------- */

const TWO_LEVEL = /\.(com|net|org|gov|edu|co|ac)\.(cn|hk|tw|uk|jp|kr|au|sg)$/;

/** Registrable-ish site for a host (good enough to fetch a favicon). */
export function siteOf(host: string): string | null {
  if (!host || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !host.includes('.')) return null;
  const parts = host.toLowerCase().split('.');
  return parts.slice(TWO_LEVEL.test(host) ? -3 : -2).join('.');
}

export function Favicon({ host, size = 16 }: { host: string; size?: number }) {
  const site = siteOf(host);
  const [failed, setFailed] = useState(false);
  const letter = (site ?? host).replace(/^www\./, '').charAt(0).toUpperCase() || '?';
  if (!site || failed) {
    return (
      <span
        aria-hidden
        className="inline-flex flex-none items-center justify-center rounded-[4px] font-mono font-medium text-white"
        style={{ width: size, height: size, fontSize: size * 0.6, background: groupColor(site ?? host) }}
      >
        {/^\d/.test(host) ? '#' : letter}
      </span>
    );
  }
  return (
    <img
      src={`/api/favicon/${site}`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className="flex-none rounded-[4px] bg-field object-contain"
      style={{ width: size, height: size }}
    />
  );
}

const COUNTRY: Record<string, string> = {
  CN: '中国', HK: '香港', TW: '台湾', MO: '澳门', JP: '日本', KR: '韩国', SG: '新加坡', US: '美国', GB: '英国', DE: '德国',
  FR: '法国', NL: '荷兰', CA: '加拿大', AU: '澳大利亚', RU: '俄罗斯', IN: '印度', TR: '土耳其', MY: '马来西亚', TH: '泰国',
  VN: '越南', PH: '菲律宾', ID: '印尼', AR: '阿根廷', BR: '巴西', IE: '爱尔兰', SE: '瑞典', FI: '芬兰', CH: '瑞士',
  IT: '意大利', ES: '西班牙', PL: '波兰', IL: '以色列', AE: '阿联酋', ZA: '南非', MX: '墨西哥', NZ: '新西兰', BE: '比利时',
  AT: '奥地利', NO: '挪威', DK: '丹麦', LOCAL: '本地直连', '?': '未知',
};

export function flagOf(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return code === 'LOCAL' ? '🏠' : '🏳️';
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/**
 * Emoji flag, except where the system font may not draw one: on Macs set to the China region the
 * Taiwan flag renders as a missing-glyph box, so it gets a small text code instead.
 */
export function Flag({ code, size = 14 }: { code: string; size?: number }) {
  if (code === 'TW') {
    return (
      <span aria-hidden className="inline-flex items-center justify-center rounded-[3px] bg-field px-0.5 font-mono font-medium text-ink-2" style={{ fontSize: size * 0.6, height: size * 0.95, minWidth: size * 1.2 }}>
        TW
      </span>
    );
  }
  return (
    <span aria-hidden style={{ fontSize: size }} className="leading-none">
      {flagOf(code || '?')}
    </span>
  );
}

export function Country({ code }: { code: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Flag code={code || '?'} />
      <span>{COUNTRY[code || '?'] ?? code}</span>
    </span>
  );
}

/** One bar, split by policy group in metro colors. */
export function SplitBar({ parts, total, max, height = 6 }: { parts: { group: string; bytes: number }[]; total: number; max: number; height?: number }) {
  const w = max ? Math.max(2, (total / max) * 100) : 0;
  return (
    <span className="flex w-full overflow-hidden rounded-full bg-field" style={{ height }}>
      <span className="flex h-full transition-[width] duration-700 ease-(--ease-out)" style={{ width: `${w}%` }}>
        {parts.map((p) => (
          <span key={p.group} title={`${p.group} ${fmtBytes(p.bytes)}`} style={{ flexGrow: p.bytes || 0.0001, background: groupColor(p.group) }} />
        ))}
      </span>
    </span>
  );
}

export function RangeSwitch({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <Segmented
      label="时间范围"
      value={value}
      onChange={onChange}
      options={[
        ['1h', '1 小时'],
        ['24h', '24 小时'],
        ['7d', '7 天'],
        ['30d', '30 天'],
      ]}
    />
  );
}

/* ---------- row actions ---------- */

export function RowMenu({ host, expect, from }: { host: string; expect?: string; from: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const toast = useToast();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  const item = 'tap flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left text-[12.5px] hover:bg-hover';
  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button aria-label={`${host} 的操作`} aria-expanded={open} onClick={() => setOpen(!open)} className="tap rounded-[7px] p-1 text-ink-3 hover:bg-hover hover:text-ink">
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div role="menu" className="menu-in absolute top-full right-0 z-40 mt-1 w-48 rounded-control bg-page p-1 shadow-overlay">
          <button
            role="menuitem"
            className={item}
            onClick={() => {
              void navigator.clipboard?.writeText(host);
              toast(`已复制 ${host}`);
              setOpen(false);
            }}
          >
            <Copy className="h-3.5 w-3.5 text-ink-3" /> 复制
          </button>
          <button role="menuitem" className={item} onClick={() => navigate('analyze', host)}>
            <FlaskConical className="h-3.5 w-3.5 text-ink-3" /> 分流测试
          </button>
          <button
            role="menuitem"
            className={item}
            onClick={() => {
              const n = basket.add([targetOf(host, from, expect)]);
              toast(n ? `已加入测试清单${expect ? `（期望「${expect}」）` : ''}` : '已在测试清单里');
              setOpen(false);
            }}
          >
            <Plus className="h-3.5 w-3.5 text-ink-3" /> 加入测试清单
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------- trend chart ---------- */

export function seriesColor(name: string): string {
  if (name === '直连') return 'var(--go)';
  if (name === '代理') return 'var(--accent)';
  if (name === '其他组') return 'var(--ink-3)';
  return groupColor(name);
}

/** Stacked area of average rate per bucket, with a hover crosshair. */
export function TrendChart({ start, bucketMs, series, height = 220 }: { start: number; bucketMs: number; series: { name: string; values: number[] }[]; height?: number }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const n = series[0]?.values.length ?? 0;
  const pad = { l: 52, r: 8, t: 10, b: 22 };
  const iw = Math.max(10, w - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const rates = series.map((s) => s.values.map((v) => v / (bucketMs / 1000)));
  const stacked = useMemo(() => {
    const acc = new Array(n).fill(0);
    return rates.map((r) => r.map((v, i) => (acc[i] += v)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, bucketMs]);
  const max = Math.max(1, ...(stacked[stacked.length - 1] ?? [1]));
  const x = (i: number) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const ticks = [0, 0.5, 1].map((f) => max * f);
  const fmtT = (t: number) => {
    const d = new Date(t);
    return bucketMs >= 6 * 3_600_000 ? `${d.getMonth() + 1}/${d.getDate()}` : d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  };
  if (!n) return <div className="flex items-center justify-center text-[13px] text-ink-3" style={{ height }}>这段时间还没有数据。历史从网站启动后开始记录。</div>;
  return (
    <div ref={wrap} className="relative w-full select-none" style={{ height }}>
      <svg width={w} height={height} className="block overflow-visible">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeDasharray={t ? '3 4' : undefined} />
            <text x={pad.l - 8} y={y(t) + 3.5} textAnchor="end" className="fill-[var(--ink-3)] font-mono text-[10px]">
              {fmtBytes(t)}/s
            </text>
          </g>
        ))}
        <g className="trend-reveal">
          {stacked
            .map((top, si) => {
              const bottom = si ? stacked[si - 1] : new Array(n).fill(0);
              const d = `M${top.map((v, i) => `${x(i)},${y(v)}`).join('L')}L${bottom.map((v, i) => `${x(n - 1 - i)},${y(bottom[n - 1 - i])}`).join('L')}Z`;
              return { d, line: `M${top.map((v, i) => `${x(i)},${y(v)}`).join('L')}`, color: seriesColor(series[si].name), name: series[si].name };
            })
            .reverse()
            .map((p) => (
              <g key={p.name}>
                <path d={p.d} fill={p.color} opacity={0.18} />
                <path d={p.line} fill="none" stroke={p.color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              </g>
            ))}
        </g>
        {[0, Math.floor(n / 2), n - 1].map((i) => (
          <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="fill-[var(--ink-3)] font-mono text-[10px]">
            {fmtT(start + i * bucketMs)}
          </text>
        ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="var(--ink-2)" strokeDasharray="2 3" />}
        <rect
          x={pad.l}
          y={pad.t}
          width={iw}
          height={ih}
          fill="transparent"
          onMouseMove={(e) => {
            const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
            setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
          }}
          onMouseLeave={() => setHover(null)}
        />
      </svg>
      {hover !== null && (
        <div
          className="menu-in pointer-events-none absolute top-2 z-10 min-w-40 rounded-control bg-page px-3 py-2 text-[12px] shadow-overlay"
          style={{ left: Math.min(Math.max(x(hover) + 12, 0), w - 180) }}
        >
          <p className="mb-1 font-mono text-[11px] text-ink-3">{new Date(start + hover * bucketMs).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
          {series.map((s, si) => (
            <p key={s.name} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-[3px] rounded-full" style={{ background: seriesColor(s.name) }} />
                {s.name}
              </span>
              <span className="num font-mono">{fmtBytes(rates[si][hover])}/s</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- history ranking table ---------- */

type Dim = 'service' | 'host' | 'device' | 'group' | 'node' | 'country' | 'rule';

interface TopRow {
  key: string;
  label: string;
  up: number;
  down: number;
  bytes: number;
  conns: number;
  last: number;
  devices: number;
  fallback: number;
  provider: string;
  scope: string;
  country: string;
  sample: string;
  groups: { group: string; bytes: number }[];
}

const DIM_LABEL: Record<Dim, string> = { service: '服务', host: '域名 / IP', device: '设备', group: '策略组', node: '出口节点', country: '目标国家', rule: '命中规则' };

export function HistoryRank({
  range,
  dim,
  devices,
  src,
  pageSize = 15,
  title,
  compact,
  onPick,
}: {
  range: Range;
  dim: Dim;
  devices?: Map<string, Device>;
  src?: string;
  pageSize?: number;
  title?: ReactNode;
  compact?: boolean;
  onPick?: (row: TopRow) => void;
}) {
  const [sort, setSort] = useState<'bytes' | 'conns' | 'last' | 'devices'>('bytes');
  const [order, setOrder] = useState<'desc' | 'asc'>('desc');
  const [page, setPage] = useState(0);
  const [q, setQ] = useState('');
  useEffect(() => setPage(0), [range, dim, sort, order, q]);
  const qs = new URLSearchParams({ range, dim, sort, order, limit: String(pageSize), offset: String(page * pageSize), ...(src ? { src } : {}), ...(q ? { q } : {}) });
  const { data, loading } = useData<{ total: number; rows: TopRow[] }>(`/api/history/top?${qs}`, 60_000);
  const rows = data?.rows ?? [];
  const max = Math.max(1, ...rows.map((r) => r.bytes));
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize));

  const label = (r: TopRow) => {
    if (dim === 'device') {
      const d = devices?.get(r.key);
      return (
        <span className="min-w-0">
          <span className="block truncate">{d?.label ?? r.key}</span>
          <span className="block truncate font-mono text-[11px] text-ink-3">{r.key}</span>
        </span>
      );
    }
    if (dim === 'group') return <GroupChip name={r.key} />;
    if (dim === 'country') return <Country code={r.key} />;
    if (dim === 'rule') {
      const [t, p] = r.key.split('|');
      return <span className="truncate font-mono text-[12px]">{t ? `${t}${p ? `(${p})` : ''}` : '（内核自身连接）'}</span>;
    }
    const host = dim === 'host' ? r.key : r.key.startsWith('site:') ? r.key.slice(5) : (r.label ?? r.key);
    return (
      <span className="flex min-w-0 items-center gap-2">
        {dim !== 'node' && <Favicon host={dim === 'host' ? r.key : r.sample || host} />}
        <span className="min-w-0">
          <span className="block truncate">{dim === 'host' ? r.key : r.label}</span>
          {dim === 'service' && <span className="block truncate font-mono text-[11px] text-ink-3">{r.key.replace(/^site:/, '')}</span>}
          {dim === 'node' && r.provider && <span className="block truncate text-[11px] text-ink-3">订阅 {r.provider}</span>}
        </span>
      </span>
    );
  };

  const head = (key: typeof sort, text: string, cls = '') => (
    <button
      onClick={() => (sort === key ? setOrder(order === 'desc' ? 'asc' : 'desc') : (setSort(key), setOrder('desc')))}
      className={`inline-flex items-center gap-0.5 hover:text-ink ${sort === key ? 'text-ink' : ''} ${cls}`}
    >
      {text}
      {sort === key && (order === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
    </button>
  );

  const GRID = compact
    ? 'grid grid-cols-[minmax(0,1fr)_90px] items-center gap-3'
    : 'grid grid-cols-[minmax(0,1fr)_96px] items-center gap-3 md:grid-cols-[minmax(160px,1.3fr)_minmax(140px,1.4fr)_88px_64px_56px_76px_30px] md:gap-4';

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed border-line-strong px-4 py-2.5">
        <p className="eyebrow">{title ?? DIM_LABEL[dim]}</p>
        <span className="flex items-center gap-2">
          {!compact && (
            <label className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="筛选" className="h-7 w-36 rounded-[8px] bg-field pr-2 pl-7 text-[12px] outline-none focus:shadow-[0_0_0_1.5px_var(--accent)]" />
            </label>
          )}
          <button
            className="tap inline-flex items-center gap-1 rounded-chip px-2 py-1 text-[12px] text-ink-2 hover:bg-hover hover:text-ink"
            onClick={() =>
              downloadCsv(`${DIM_LABEL[dim]}-${range}`, ['名称', '键', '下载', '上传', '总流量', '连接', '设备数', '兜底连接', '最后出现', '策略组分布'], rows.map((r) => [r.label, r.key, r.down, r.up, r.bytes, r.conns, r.devices, r.fallback, new Date(r.last).toISOString(), r.groups.map((g) => `${g.group}:${g.bytes}`).join(' ')]))
            }
          >
            <Download className="h-3.5 w-3.5" /> CSV
          </button>
        </span>
      </div>
      {!compact && (
        <div className={`eyebrow hidden border-b border-line px-4 py-2 md:grid ${GRID}`}>
          <span>{DIM_LABEL[dim]}</span>
          <span>流量 · 按策略组</span>
          {head('bytes', '总量', 'justify-end')}
          {head('conns', '连接', 'justify-end')}
          {head('devices', '设备', 'justify-end')}
          {head('last', '最后', 'justify-end')}
          <span />
        </div>
      )}
      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-[13px] text-ink-3">{loading ? '读取中…' : '这段时间没有记录。'}</p>
      ) : (
        <ul className={`divide-y divide-line transition-opacity ${loading ? 'opacity-60' : ''}`}>
          {rows.map((r, i) => (
            <li key={r.key} className={`rise px-4 py-2 ${onPick ? 'cursor-pointer hover:bg-hover' : ''}`} style={{ '--d': `${i * 18}ms` } as CSSProperties} onClick={() => onPick?.(r)}>
              <div className={GRID}>
                <span className="flex min-w-0 items-center gap-2 text-[13px]">
                  <span className="num w-5 flex-none text-right font-mono text-[11px] text-ink-3">{page * pageSize + i + 1}</span>
                  {label(r)}
                  {r.fallback > 0 && <span className="flex-none rounded-chip bg-signal-bg px-1 font-pixel text-[10px] text-signal">兜底 {r.fallback}</span>}
                </span>
                {compact ? (
                  <span className="text-right">
                    <span className="num block font-mono text-[12px]">{fmtBytes(r.bytes)}</span>
                    <SplitBar parts={r.groups} total={r.bytes} max={max} height={4} />
                  </span>
                ) : (
                  <>
                    <span className="hidden md:block">
                      <SplitBar parts={r.groups} total={r.bytes} max={max} />
                      <span className="mt-1 flex gap-2 truncate text-[11px] text-ink-3">
                        {r.groups.slice(0, 3).map((g) => (
                          <span key={g.group}>
                            {g.group} {Math.round((g.bytes / Math.max(1, r.bytes)) * 100)}%
                          </span>
                        ))}
                      </span>
                    </span>
                    <span className="num text-right font-mono text-[12px]">
                      {fmtBytes(r.bytes)}
                      <span className="block text-[10.5px] text-ink-3">
                        ↓{fmtBytes(r.down)} ↑{fmtBytes(r.up)}
                      </span>
                    </span>
                    <span className="num hidden text-right font-mono text-[12px] md:block">{r.conns.toLocaleString()}</span>
                    <span className="num hidden text-right font-mono text-[12px] md:block">{r.devices}</span>
                    <span className="hidden text-right text-[11.5px] text-ink-3 md:block">{fmtAgo(r.last)}</span>
                    <span className="hidden justify-end md:flex">{(dim === 'host' || dim === 'service') && <RowMenu host={dim === 'host' ? r.key : r.key.replace(/^site:/, '')} from={`历史 · ${DIM_LABEL[dim]}`} />}</span>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!compact && pages > 1 && (
        <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[12px] text-ink-2">
          <span className="num font-mono">
            {page * pageSize + 1}–{Math.min((page + 1) * pageSize, data?.total ?? 0)} / {data?.total ?? 0}
          </span>
          <span className="flex items-center gap-1">
            <button disabled={page === 0} onClick={() => setPage(page - 1)} className="tap rounded-chip px-2 py-1 hover:bg-hover disabled:opacity-35">
              上一页
            </button>
            <span className="num font-mono">
              {page + 1}/{pages}
            </span>
            <button disabled={page >= pages - 1} onClick={() => setPage(page + 1)} className="tap rounded-chip px-2 py-1 hover:bg-hover disabled:opacity-35">
              下一页
            </button>
          </span>
        </div>
      )}
    </Card>
  );
}
