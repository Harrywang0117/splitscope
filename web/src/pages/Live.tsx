import { ArrowDown, ArrowUp, ArrowUpRight, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Device, LiveConn } from '../../../shared/types.ts';
import type { LiveData } from '../api.ts';
import { navigate } from '../App.tsx';
import {
  AnimatedNumber,
  Card,
  Drawer,
  FallbackTag,
  GroupChip,
  Kbd,
  KindIcon,
  ProviderLine,
  RouteStrip,
  RuleBadge,
  rise,
  Segmented,
  ServiceName,
  Toggle,
} from '../components/bits.tsx';
import { fmtBytes, fmtDuration, fmtSpeed, fmtTime, groupColor, sourceLabel } from '../lib/format.ts';
import { Favicon, RowMenu } from '../components/data.tsx';
import { ConnLog } from '../components/ConnLog.tsx';
import { useData } from '../api.ts';

type View = 'list' | 'device' | 'service' | 'group';
type Sort = 'time' | 'speed' | 'traffic' | 'device' | 'target' | 'rule' | 'group';

const ROW_LIMIT = 400;

function deviceOf(devices: Map<string, Device>, ip: string) {
  return devices.get(ip);
}

function matches(c: LiveConn, q: string, dev: string) {
  if (!q) return true;
  const hay = [c.host, c.dstIp, c.srcIp, dev, c.service?.name, c.service?.id, c.group, c.node, c.rulePayload, c.target?.org, c.target?.brand, c.target?.ip]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((t) => hay.includes(t));
}

/** last 60 seconds of total download speed, for the sparkline */
function useSpeedHistory(speed: number, version: number) {
  const hist = useRef<number[]>([]);
  useEffect(() => {
    hist.current = [...hist.current.slice(-59), speed];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);
  return hist.current;
}

function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return <div className="h-9" />;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 100},${36 - (v / max) * 32}`).join(' ');
  return (
    <svg viewBox="0 0 100 38" preserveAspectRatio="none" className="h-9 w-full" aria-hidden>
      <defs>
        <linearGradient id="spark" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.28" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,38 ${pts} 100,38`} fill="url(#spark)" />
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function Live({ live, params }: { live: LiveData; params: URLSearchParams }) {
  const [q, setQ] = useState(params.get('q') ?? '');
  const [device, setDevice] = useState(params.get('device') ?? '');
  const [group, setGroup] = useState(params.get('group') ?? '');
  const [desc, setDesc] = useState(true);
  // other pages deep-link here with ?device= / ?group= / ?q=
  const paramKey = params.toString();
  useEffect(() => {
    setQ(params.get('q') ?? '');
    setDevice(params.get('device') ?? '');
    setGroup(params.get('group') ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramKey]);
  const [onlyFallback, setOnlyFallback] = useState(false);
  const [withClosed, setWithClosed] = useState(false);
  const [showProbe, setShowProbe] = useState(false);
  const [view, setView] = useState<View>('list');
  const [sort, setSort] = useState<Sort>('time');
  const [picked, setPicked] = useState<LiveConn | null>(null);
  const [mode, setMode] = useState<'live' | 'log'>(params.get('mode') === 'log' ? 'log' : 'live');
  const { data: settings } = useData<{ settings: { connlogDays: number } }>('/api/settings', 0);
  const searchRef = useRef<HTMLInputElement>(null);
  const speedHist = useSpeedHistory(live.totals.downSpeed, live.version);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const all = useMemo(() => {
    const list = [...live.active.values()];
    if (withClosed) list.push(...live.closed.slice().reverse());
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.version, withClosed]);

  const filtered = useMemo(
    () =>
      all.filter(
        (c) =>
          (showProbe || !(c.probe || c.self)) &&
          (!device || c.srcIp === device) &&
          (!group || c.group === group) &&
          (!onlyFallback || c.fallback) &&
          matches(c, q, deviceOf(live.devices, c.srcIp)?.label ?? ''),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, q, device, group, onlyFallback, showProbe, live.version],
  );

  const sorted = useMemo(() => {
    const s = [...filtered];
    const dir = desc ? 1 : -1;
    const label = (c: LiveConn) => deviceOf(live.devices, c.srcIp)?.label ?? c.srcIp;
    if (sort === 'time') s.sort((a, b) => dir * ((b.closedAt ? 0 : 1) - (a.closedAt ? 0 : 1) || b.start - a.start));
    if (sort === 'speed') s.sort((a, b) => dir * (b.downSpeed + b.upSpeed - (a.downSpeed + a.upSpeed)));
    if (sort === 'traffic') s.sort((a, b) => dir * (b.down + b.up - (a.down + a.up)));
    if (sort === 'device') s.sort((a, b) => -dir * label(a).localeCompare(label(b), 'zh'));
    if (sort === 'target') s.sort((a, b) => -dir * (a.host || a.dstIp).localeCompare(b.host || b.dstIp));
    if (sort === 'rule') s.sort((a, b) => -dir * (a.ruleIndex - b.ruleIndex));
    if (sort === 'group') s.sort((a, b) => -dir * a.group.localeCompare(b.group, 'zh'));
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sort, desc, live.version]);
  const sortBy = (k: Sort) => {
    if (sort === k) setDesc(!desc);
    else {
      setSort(k);
      setDesc(true);
    }
  };

  const activeList = useMemo(() => [...live.active.values()].filter((c) => !c.probe && !c.self), [live.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const deviceCount = new Set(activeList.map((c) => c.srcIp)).size;
  const fallbackCount = activeList.filter((c) => c.fallback).length;

  const deviceOptions = useMemo(() => {
    const ips = new Set(all.map((c) => c.srcIp));
    return [...ips].map((ip) => ({ ip, label: deviceOf(live.devices, ip)?.label ?? ip })).sort((a, b) => a.label.localeCompare(b.label, 'zh'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, live.version]);
  const groupOptions = useMemo(() => [...new Set(all.map((c) => c.group))].filter(Boolean).sort(), [all]);

  const modeSwitch = (
    <div className="rise flex flex-wrap items-center justify-between gap-2" style={rise(0)}>
      <Segmented
        label="模式"
        value={mode}
        onChange={setMode}
        options={[
          ['live', '实时'],
          ['log', `记录 · ${settings?.settings.connlogDays ?? 7} 天`],
        ]}
      />
      <span className="text-[12px] text-ink-3">{mode === 'live' ? '内核当前的连接，每秒刷新' : '每条连接都存了下来，可以按时间回看、筛选和导出'}</span>
    </div>
  );

  if (mode === 'log') {
    return (
      <div className="space-y-4">
        {modeSwitch}
        <ConnLog devices={live.devices} keepDays={settings?.settings.connlogDays ?? 7} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {modeSwitch}
      {/* summary tiles */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card className="rise px-4 py-3.5" style={rise(0)}>
          <p className="eyebrow">Active</p>
          <p className="mt-1 flex items-baseline gap-2">
            <AnimatedNumber value={activeList.length} className="font-display text-[30px] leading-none font-semibold" />
            <span className="text-[13px] text-ink-2">条连接<span className="hidden sm:inline"> · 来自 {deviceCount} 台设备</span></span>
          </p>
        </Card>
        <button onClick={() => setOnlyFallback(!onlyFallback)} className="rise tap text-left" style={rise(1)}>
          <Card className={`h-full px-4 py-3.5 ${onlyFallback ? 'shadow-[0_0_0_1.5px_var(--signal)]' : ''}`}>
            <p className="eyebrow">Fallback</p>
            <p className="mt-1 flex items-baseline gap-2">
              <AnimatedNumber value={fallbackCount} className={`font-display text-[30px] leading-none font-semibold ${fallbackCount ? 'text-signal' : ''}`} />
              <span className="text-[13px] text-ink-2">
                条兜底<span className="hidden sm:inline">{onlyFallback ? '（已筛选）' : '，点我只看这些'}</span>
              </span>
            </p>
          </Card>
        </button>
        <Card className="rise col-span-2 overflow-hidden px-4 pt-3.5 sm:col-span-1" style={rise(2)}>
          <div className="flex items-baseline justify-between">
            <p className="eyebrow">Throughput</p>
            <p className="num font-mono text-[12px] text-ink-2">↑ {fmtSpeed(live.totals.upSpeed) || '0 B/s'}</p>
          </div>
          <p className="mt-1 font-display text-[22px] leading-none font-semibold">
            ↓ <AnimatedNumber value={live.totals.downSpeed} format={(n) => fmtSpeed(n) || '0 B/s'} />
          </p>
          <div className="-mx-4 mt-1">
            <Sparkline data={speedHist} />
          </div>
        </Card>
      </div>

      {/* filters */}
      <div className="rise flex flex-wrap items-center gap-2" style={rise(3)}>
        <label className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-ink-3" />
          <input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索域名、IP、服务、设备、策略组"
            className="h-9 w-full rounded-control bg-page pr-10 pl-9 text-[14px] shadow-card outline-none transition-shadow placeholder:text-ink-3 focus:shadow-[0_0_0_1.5px_var(--accent)]"
            aria-label="搜索连接"
          />
          <span className="absolute top-1/2 right-2.5 -translate-y-1/2">
            <Kbd>/</Kbd>
          </span>
        </label>
        <select value={device} onChange={(e) => setDevice(e.target.value)} className="h-9 max-w-[220px] rounded-control bg-page px-2.5 text-[13px] shadow-card" aria-label="设备">
          <option value="">全部设备</option>
          {deviceOptions.map((d) => (
            <option key={d.ip} value={d.ip}>
              {d.label} · {d.ip}
            </option>
          ))}
        </select>
        <select value={group} onChange={(e) => setGroup(e.target.value)} className="h-9 max-w-[180px] rounded-control bg-page px-2.5 text-[13px] shadow-card" aria-label="策略组">
          <option value="">全部策略组</option>
          {groupOptions.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <Toggle on={withClosed} set={setWithClosed}>
          含已关闭
        </Toggle>
        <Toggle on={showProbe} set={setShowProbe}>
          显示本站流量
        </Toggle>
      </div>

      <div className="rise flex flex-wrap items-center justify-between gap-2" style={rise(4)}>
        <Segmented
          label="视图"
          value={view}
          onChange={setView}
          options={[
            ['list', '明细'],
            ['device', '按设备'],
            ['service', '按服务'],
            ['group', '按策略组'],
          ]}
        />
        <div className="flex items-center gap-3 text-[12.5px] text-ink-2">
          <span className="num font-mono">
            {filtered.length} 条{filtered.length > ROW_LIMIT && view === 'list' ? ` · 显示前 ${ROW_LIMIT}` : ''}
          </span>
          {view === 'list' && (
            <Segmented
              label="排序"
              value={sort === 'speed' || sort === 'traffic' ? sort : 'time'}
              onChange={(v) => {
                setSort(v);
                setDesc(true);
              }}
              options={[
                ['time', '最新'],
                ['speed', '最快'],
                ['traffic', '最多'],
              ]}
            />
          )}
        </div>
      </div>

      <div className="rise" style={rise(5)}>
        {view === 'list' ? (
          <ConnTable rows={sorted.slice(0, ROW_LIMIT)} devices={live.devices} onPick={setPicked} sort={sort} desc={desc} onSort={sortBy} />
        ) : (
          <GroupedView
            view={view}
            rows={filtered}
            devices={live.devices}
            onPick={(key) => {
              if (view === 'device') setDevice(key);
              else if (view === 'group') setGroup(key);
              else setQ(key);
              setView('list');
            }}
          />
        )}
      </div>

      {picked && <ConnDrawer conn={picked} devices={live.devices} onClose={() => setPicked(null)} />}
    </div>
  );
}

/*
 * One grid template shared by the header and every row so columns always line up.
 * md–xl: device | target (+provider) | rule over route | traffic.  xl: every field in its own column.
 */
const GRID =
  'md:grid md:items-center md:gap-x-4 md:grid-cols-[minmax(130px,0.9fr)_minmax(200px,1.7fr)_minmax(210px,1.5fr)_84px_24px] xl:grid-cols-[62px_minmax(130px,0.95fr)_minmax(200px,1.7fr)_minmax(100px,0.9fr)_minmax(140px,1.1fr)_minmax(180px,1.5fr)_84px_24px]';

function DeviceCell({ d, ip }: { d?: Device; ip: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="dense-tile flex h-7 w-7 flex-none items-center justify-center rounded-[8px] bg-field text-ink-2">
        <KindIcon kind={d?.kind ?? ''} className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0">
        <span className={`block truncate text-[13px] ${d?.labelSource === 'unknown' ? 'text-ink-2' : ''}`} title={ip}>
          {d?.label ?? ip}
        </span>
        <span className="sub block truncate font-mono text-[11px] text-ink-3">{ip}</span>
      </span>
    </span>
  );
}

function SortHead({ k, sort, desc, onSort, children, className = '' }: { k: Sort; sort: Sort; desc: boolean; onSort: (k: Sort) => void; children: React.ReactNode; className?: string }) {
  return (
    <button onClick={() => onSort(k)} className={`inline-flex items-center gap-0.5 text-left hover:text-ink ${sort === k ? 'text-ink' : ''} ${className}`}>
      {children}
      {sort === k && (desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
    </button>
  );
}

function ConnTable({
  rows,
  devices,
  onPick,
  sort,
  desc,
  onSort,
}: {
  rows: LiveConn[];
  devices: Map<string, Device>;
  onPick: (c: LiveConn) => void;
  sort: Sort;
  desc: boolean;
  onSort: (k: Sort) => void;
}) {
  const h = (k: Sort, text: string, cls = '') => (
    <SortHead k={k} sort={sort} desc={desc} onSort={onSort} className={cls}>
      {text}
    </SortHead>
  );
  if (!rows.length) {
    return (
      <Card className="px-4 py-14 text-center text-[13px] text-ink-2">
        没有符合条件的连接。换个筛选条件，或打开「含已关闭」看最近 30 分钟的记录。
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden">
      <div className={`eyebrow hidden border-b border-dashed border-line-strong px-4 py-2.5 ${GRID}`}>
        <span className="hidden xl:block">{h('time', 'Time')}</span>
        <span>{h('device', '设备')}</span>
        <span>{h('target', '目标 · 服务')}</span>
        <span className="hidden xl:block">供应商</span>
        <span className="xl:hidden">{h('rule', '规则 · 线路')}</span>
        <span className="hidden xl:block">{h('rule', '命中规则')}</span>
        <span className="hidden xl:block">{h('group', '线路')}</span>
        <span className="flex justify-end">{h('traffic', '流量', 'justify-end')}</span>
        <span />
      </div>
      <ul className="divide-y divide-line">
        {rows.map((c) => (
          <li key={c.id}>
            <div
              role="button"
              tabIndex={0}
              onClick={() => onPick(c)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(c))}
              className={`dense-row tap w-full cursor-pointer px-4 py-2.5 text-left hover:bg-hover active:scale-[0.995] ${GRID} ${c.fallback ? 'fallback-row' : ''} ${(c as LiveConn & { _new?: boolean })._new ? 'row-new' : ''} ${c.closedAt ? 'opacity-55' : ''}`}
            >
              <span className="num hidden font-mono text-[11.5px] text-ink-3 xl:block">{fmtTime(c.start)}</span>
              <DeviceCell d={devices.get(c.srcIp)} ip={c.srcIp} />
              <span className="mt-2 block min-w-0 md:mt-0">
                <span className="flex min-w-0 items-center gap-1.5 truncate font-mono text-[13px]" title={`${c.host || c.dstIp}:${c.dstPort}`}>
                  <Favicon host={c.host || c.dstIp} size={14} />
                  <span className="truncate">{c.host || c.dstIp}</span>
                  <span className="text-ink-3">:{c.dstPort}</span>
                  {c.network === 'udp' && <span className="ml-1.5 font-pixel text-[10px] text-ink-3">UDP</span>}
                </span>
                <span className="sub flex min-w-0 items-center gap-1.5 text-[12px] text-ink-2">
                  <ServiceName service={c.service} />
                  {c.target && (
                    <span className="flex min-w-0 items-center gap-1.5 xl:hidden">
                      <span className="text-ink-3">·</span>
                      <ProviderLine p={c.target} approx={c.targetApprox} />
                    </span>
                  )}
                  {c.probe && <span className="rounded-chip bg-field px-1 font-pixel text-[10px]">probe</span>}
                  {c.self && <span className="rounded-chip bg-field px-1 font-pixel text-[10px]" title="本站自己的健康检测、图标、规则库下载">本站</span>}
                </span>
              </span>
              <span className="hidden min-w-0 text-[12.5px] text-ink-2 xl:block">
                <ProviderLine p={c.target} approx={c.targetApprox} />
              </span>
              <span className="mt-1.5 flex min-w-0 flex-col gap-1 md:mt-0 xl:contents">
                <span className="flex min-w-0 items-center gap-1.5">
                  <RuleBadge type={c.rule} payload={c.rulePayload} index={c.ruleIndex} />
                  <FallbackTag kind={c.fallback} />
                </span>
                <span className="block min-w-0">
                  <RouteStrip chain={c.chain} node={c.node} nodeProvider={c.nodeProvider} />
                </span>
              </span>
              <span className="num mt-1.5 flex gap-3 font-mono text-[11.5px] md:mt-0 md:block md:text-right">
                <span className="block">↓ {fmtSpeed(c.downSpeed) || fmtBytes(c.down)}</span>
                <span className="sub block text-ink-3">↑ {fmtSpeed(c.upSpeed) || fmtBytes(c.up)}</span>
              </span>
              <span className="hidden md:flex md:justify-end">
                <RowMenu host={c.host || c.dstIp} from="实时连接" />
              </span>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function GroupedView({ view, rows, devices, onPick }: { view: Exclude<View, 'list'>; rows: LiveConn[]; devices: Map<string, Device>; onPick: (key: string) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; label: string; sub: string; kind: string; count: number; bytes: number; speed: number; fallback: number; groups: Map<string, number> }>();
    for (const c of rows) {
      const key = view === 'device' ? c.srcIp : view === 'group' ? c.group : (c.service?.name ?? c.host ?? c.dstIp);
      const d = devices.get(c.srcIp);
      const label = view === 'device' ? (d?.label ?? c.srcIp) : key || '未识别';
      const sub = view === 'device' ? [c.srcIp, d?.model].filter(Boolean).join(' · ') : view === 'service' ? (c.service ? sourceLabel(c.service.id) : '') : '';
      let g = map.get(key);
      if (!g) map.set(key, (g = { key, label, sub, kind: d?.kind ?? '', count: 0, bytes: 0, speed: 0, fallback: 0, groups: new Map() }));
      g.count++;
      g.bytes += c.up + c.down;
      g.speed += c.upSpeed + c.downSpeed;
      if (c.fallback) g.fallback++;
      g.groups.set(c.group, (g.groups.get(c.group) ?? 0) + 1);
    }
    return [...map.values()].sort((a, b) => b.speed - a.speed || b.bytes - a.bytes);
  }, [rows, view, devices]);

  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-line">
        {groups.map((g, i) => (
          <li key={g.key} className="rise" style={rise(i)}>
            <button onClick={() => onPick(g.key)} className="tap grid w-full grid-cols-1 items-center gap-2 px-4 py-3 text-left hover:bg-hover md:grid-cols-[minmax(180px,1fr)_70px_minmax(220px,2fr)_110px] md:gap-4">
              <span className="flex min-w-0 items-center gap-2.5">
                {view === 'device' && (
                  <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[8px] bg-field text-ink-2">
                    <KindIcon kind={g.kind} className="h-3.5 w-3.5" />
                  </span>
                )}
                <span className="min-w-0">
                  {view === 'group' ? <GroupChip name={g.label} /> : <span className="block truncate font-medium">{g.label}</span>}
                  {g.sub && <span className="block truncate font-mono text-[11px] text-ink-3">{g.sub}</span>}
                </span>
              </span>
              <span className="num font-mono text-[12px] text-ink-2">{g.count} 条</span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="flex h-1.5 w-full max-w-[280px] overflow-hidden rounded-full bg-field">
                  {[...g.groups]
                    .sort((a, b) => b[1] - a[1])
                    .map(([name, n]) => (
                      <span key={name} title={`${name} ${n}`} style={{ width: `${(n / g.count) * 100}%`, background: groupColor(name) }} />
                    ))}
                </span>
                {view !== 'group' &&
                  [...g.groups]
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 3)
                    .map(([name, n]) => (
                      <span key={name} className="inline-flex items-center gap-1 text-[12px] text-ink-2">
                        <span className="h-2 w-[3px] rounded-full" style={{ background: groupColor(name) }} />
                        {name} {n}
                      </span>
                    ))}
                {g.fallback > 0 && <span className="text-[12px] text-signal">兜底 {g.fallback}</span>}
              </span>
              <span className="num font-mono text-[12px] text-ink-2 md:text-right">{fmtSpeed(g.speed) || fmtBytes(g.bytes)}</span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Field({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[76px_1fr] gap-3 py-2.5">
      <dt className="eyebrow pt-0.5">{k}</dt>
      <dd className="min-w-0 text-[13px] break-all">{children}</dd>
    </div>
  );
}

function ConnDrawer({ conn: c, devices, onClose }: { conn: LiveConn; devices: Map<string, Device>; onClose: () => void }) {
  const d = devices.get(c.srcIp);
  const test = c.host || c.dstIp;
  return (
    <Drawer
      eyebrow="Connection"
      onClose={onClose}
      title={
        <h3 className="font-mono text-[15px] font-medium break-all">
          {test}
          <span className="text-ink-3">:{c.dstPort}</span>
        </h3>
      }
    >
      <dl className="divide-y divide-dashed divide-line-strong">
        <Field k="设备">
          <span className="flex items-center gap-2">
            <KindIcon kind={d?.kind ?? ''} />
            <span className="font-medium">{d?.label ?? c.srcIp}</span>
          </span>
          <span className="mt-1 block font-mono text-[11.5px] text-ink-2">
            {c.srcIp}:{c.srcPort}
            {d?.mac ? ` · ${d.mac}` : ''}
          </span>
          {(d?.model || d?.vendor || d?.hint) && (
            <span className="block text-[12px] text-ink-2">{[d?.model, d?.vendor, d?.hint ? `流量特征：${d.hint}` : ''].filter(Boolean).join(' · ')}</span>
          )}
        </Field>
        <Field k="服务">
          <ServiceName service={c.service} />
          {c.service && (
            <span className="mt-1 block text-[12px] text-ink-2">
              {sourceLabel(c.service.id)}
              {c.service.matched ? ` · 匹配 ${c.service.matched}` : ''}
              {c.service.also.length > 0 && <span className="block">也在：{c.service.also.slice(0, 6).map(sourceLabel).join('、')}</span>}
            </span>
          )}
        </Field>
        <Field k="目标">
          {c.target ? (
            <>
              <span className="font-mono">{c.target.ip}</span>
              {c.targetApprox && <span className="ml-1.5 text-[12px] text-ink-2">参考解析</span>}
              <span className="block text-[12px] text-ink-2">
                {[c.target.country, c.target.asn ? `AS${c.target.asn}` : '', c.target.org, c.target.brand && c.target.brand !== c.target.org ? `（${c.target.brand}）` : '']
                  .filter(Boolean)
                  .join(' ')}
              </span>
              {c.target.tags.length > 0 && <span className="block text-[12px] text-ink-2">GeoIP：{c.target.tags.join('、')}</span>}
            </>
          ) : (
            <span className="text-ink-2">未知（经代理连接，本地没有解析）</span>
          )}
        </Field>
        <Field k="规则">
          <span className="flex flex-wrap items-center gap-1.5">
            <RuleBadge type={c.rule} payload={c.rulePayload} index={c.ruleIndex} /> <FallbackTag kind={c.fallback} />
          </span>
        </Field>
        <Field k="线路">
          <ol className="relative space-y-2 pl-4">
            <span className="absolute top-1.5 bottom-1.5 left-[3px] w-[2px] rounded" style={{ background: groupColor(c.chain[0]) }} />
            {c.chain.map((n, i) => (
              <li key={i} className="relative flex items-center gap-2">
                <span className="absolute -left-4 h-2 w-2 rounded-full border-2 bg-page" style={{ borderColor: groupColor(c.chain[0]) }} />
                {i === 0 ? <GroupChip name={n} /> : <span>{n}</span>}
                {i === c.chain.length - 1 && c.nodeProvider && <span className="text-[12px] text-ink-2">订阅 {c.nodeProvider}</span>}
              </li>
            ))}
          </ol>
        </Field>
        <Field k="入站">
          {c.inbound} · {c.network.toUpperCase()}
        </Field>
        <Field k="流量">
          <span className="num font-mono">
            ↓ {fmtBytes(c.down)} · ↑ {fmtBytes(c.up)}
          </span>
        </Field>
        <Field k="时间">
          {fmtTime(c.start)} 开始 · {c.closedAt ? `已关闭，持续 ${fmtDuration(c.closedAt - (c.seenAt ?? c.start))}` : `已持续 ${fmtDuration(Date.now() - (c.seenAt ?? c.start))}`}
        </Field>
      </dl>
      <div className="mt-5 flex flex-wrap gap-2">
        <button onClick={() => navigate('analyze', test)} className="tap inline-flex items-center gap-1.5 rounded-control bg-ink px-3.5 py-2 text-[13px] font-medium text-page hover:bg-ink/85">
          分流测试这个地址 <ArrowUpRight className="h-3.5 w-3.5" />
        </button>
        {c.service && (c.service.source === 'geosite' || c.service.source === 'bm7') && !c.service.category && (
          <button onClick={() => navigate('analyze', c.service!.id)} className="tap inline-flex items-center gap-1.5 rounded-control px-3.5 py-2 text-[13px] shadow-card hover:bg-hover">
            测试整个「{c.service.name}」
          </button>
        )}
      </div>
    </Drawer>
  );
}
