import { Activity, Database, FileWarning, Globe2, HeartPulse, LayoutDashboard, ListTree, Moon, MonitorSmartphone, Server, Split, Stethoscope, Sun, Waypoints } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Junction } from './components/Junction.tsx';
import { useLive, useStatus, type Range } from './api.ts';
import { RangeSwitch } from './components/data.tsx';
import { Cases } from './pages/Cases.tsx';
import { Checkup } from './pages/Checkup.tsx';
import { Flow } from './pages/Flow.tsx';
import { Health } from './pages/Health.tsx';
import { Nodes } from './pages/Nodes.tsx';
import { Overview } from './pages/Overview.tsx';
import { Regions } from './pages/Regions.tsx';
import { AnimatedNumber, Lamp, ToastHost } from './components/bits.tsx';
import { Dock, Palette, type Density } from './components/Dock.tsx';
import { fmtAgo, fmtBytes, fmtSpeed } from './lib/format.ts';
import { Analyze } from './pages/Analyze.tsx';
import { DataSources } from './pages/DataSources.tsx';
import { Devices } from './pages/Devices.tsx';
import { Live } from './pages/Live.tsx';
import { Rules } from './pages/Rules.tsx';

const TABS = [
  { id: 'overview', label: '概览', desc: '这段时间的流量、走向和排行', icon: LayoutDashboard, section: 'see', ranged: true },
  { id: 'live', label: '实时连接', desc: '每条连接从哪台设备来、属于什么服务、走了哪条线', icon: Activity, section: 'see', ranged: false },
  { id: 'flow', label: '流向', desc: '设备或服务 → 策略组 → 出口节点，线越粗流量越大', icon: Waypoints, section: 'see', ranged: true },
  { id: 'devices', label: '设备', desc: '家里每台设备是谁，起个名字就记住了', icon: MonitorSmartphone, section: 'see', ranged: true },
  { id: 'nodes', label: '出口节点', desc: '每个节点承载了多少流量、被哪些策略组选中、延迟多少', icon: Server, section: 'see', ranged: true },
  { id: 'regions', label: '地区', desc: '流量去了哪些国家，又从哪里出去', icon: Globe2, section: 'see', ranged: true },
  { id: 'checkup', label: '分流体检', desc: '自动找出国内走代理、境外走直连、落到兜底的流量', icon: Stethoscope, section: 'check', ranged: true },
  { id: 'cases', label: '异常案例', desc: '走了和预期不符的策略组的连接，合并成案例，改规则时当参考', icon: FileWarning, section: 'check', ranged: false },
  { id: 'analyze', label: '分流测试', desc: '输入域名、IP 或 App 名，看内核把它分到哪个策略组', icon: Split, section: 'check', ranged: false },
  { id: 'rules', label: '规则', desc: '正在运行的规则顺序、命中计数和策略组选择', icon: ListTree, section: 'check', ranged: false },
  { id: 'health', label: '健康', desc: '内核、DNS、直连和代理线路每分钟的状态', icon: HeartPulse, section: 'system', ranged: true },
  { id: 'data', label: '数据源', desc: 'OpenClash 配置快照和服务识别库的更新情况', icon: Database, section: 'system', ranged: false },
] as const;
type TabId = (typeof TABS)[number]['id'];
const SECTIONS = [
  { id: 'see', label: 'Observe' },
  { id: 'check', label: 'Diagnose' },
  { id: 'system', label: 'System' },
] as const;

function parseHash(): { tab: TabId; q: string; params: URLSearchParams } {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, query] = h.split('?');
  const tab = (TABS.find((t) => t.id === path)?.id ?? 'overview') as TabId;
  const params = new URLSearchParams(query ?? '');
  return { tab, q: params.get('q') ?? '', params };
}

export function navigate(tab: TabId, q?: string, params?: Record<string, string>) {
  const p = new URLSearchParams(params ?? {});
  if (q) p.set('q', q);
  const qs = p.toString();
  location.hash = `/${tab}${qs ? `?${qs}` : ''}`;
}

function useRange(): [Range, (r: Range) => void] {
  const [range, setRange] = useState<Range>(() => {
    try {
      const v = localStorage.getItem('splitscope-range');
      return v === '1h' || v === '7d' || v === '30d' ? v : '24h';
    } catch {
      return '24h';
    }
  });
  return [
    range,
    (r) => {
      setRange(r);
      try {
        localStorage.setItem('splitscope-range', r);
      } catch {
        /* private mode */
      }
    },
  ];
}

function useDensity(): [Density, (d: Density) => void] {
  const [density, set] = useState<Density>(() => {
    try {
      return localStorage.getItem('splitscope-density') === 'compact' ? 'compact' : 'comfy';
    } catch {
      return 'comfy';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);
  return [
    density,
    (d) => {
      set(d);
      try {
        localStorage.setItem('splitscope-density', d);
      } catch {
        /* private mode */
      }
    },
  ];
}

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('splitscope-theme') ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [theme]);
  const dark = theme ? theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const toggle = () => {
    const next = dark ? 'light' : 'dark';
    setTheme(next);
    try {
      localStorage.setItem('splitscope-theme', next);
    } catch {
      /* private mode */
    }
  };
  return [dark ? 'dark' : 'light', toggle];
}

export function App() {
  const [route, setRoute] = useState(parseHash);
  const parseHashTab = useRef(route.tab);
  const live = useLive();
  const { status, reload } = useStatus(live.metaVersion);
  useEffect(() => {
    window.addEventListener('splitscope:drafts', reload);
    return () => window.removeEventListener('splitscope:drafts', reload);
  }, [reload]);
  const [theme, toggleTheme] = useTheme();
  const [range, setRange] = useRange();
  const [density, setDensity] = useDensity();
  const [palette, setPalette] = useState(false);
  const openPalette = useCallback(() => setPalette(true), []);
  const closePalette = useCallback(() => setPalette(false), []);
  const go = useCallback((t: string, q?: string, p?: Record<string, string>) => navigate(t as TabId, q, p), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (e.key === '/' && !typing) {
        // a page with its own search box (实时连接, 分流测试) takes "/" first
        setTimeout(() => !e.defaultPrevented && setPalette(true));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const on = () => {
      const next = parseHash();
      const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
      // only animate real page switches, not query changes on the same page
      if (doc.startViewTransition && next.tab !== parseHashTab.current) {
        doc.startViewTransition(() => flushSync(() => setRoute(next)));
      } else setRoute(next);
      parseHashTab.current = next.tab;
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  // live split for the brand mark: bytes/s that went through a proxy vs straight out
  const flow = useMemo(() => {
    let proxyBps = 0;
    let directBps = 0;
    for (const c of live.active.values()) {
      if (c.probe || c.self) continue;
      const v = c.upSpeed + c.downSpeed;
      if (c.direct) directBps += v;
      else proxyBps += v;
    }
    return { proxyBps, directBps };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.version]);

  const snap = status?.snapshot;
  const intelInfo = status?.intel;
  const tab = TABS.find((t) => t.id === route.tab)!;

  const counts: Partial<Record<TabId, ReactNode>> = useMemo(
    () => ({
      live: live.active.size,
      devices: [...live.devices.values()].filter((d) => !d.special).length,
      rules: snap?.rules ?? null,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live.version, snap?.rules],
  );

  const lamps = (
    <>
      <Lamp on={live.connected} live>
        {live.connected ? '内核在线' : '内核断开'}
      </Lamp>
      {status?.access && !status.access.canEdit && (
        <span title={`只有 ${status.access.editNets.join('、')} 里的设备能修改`}>
          <Lamp on warn>
            只读（{status.access.ip}）
          </Lamp>
        </span>
      )}
      <a href="#/data" className="hover:text-ink">
        <Lamp on={!!snap} warn={!!snap?.drift}>
          配置 {snap ? fmtAgo(snap.takenAt) : '未读取'}
        </Lamp>
      </a>
      <a href="#/data" className="hover:text-ink">
        <Lamp on={!!intelInfo?.lastRunAt} warn={intelInfo?.running}>
          {intelInfo?.running ? `识别库更新中 ${intelInfo.bm7.progress ?? ''}` : `识别库 ${fmtAgo(intelInfo?.lastRunAt ?? 0)}`}
        </Lamp>
      </a>
    </>
  );

  return (
    <ToastHost>
      <div>
      {/* full-bleed: the page spans the whole window, only the sidebar divides it */}
      <div className="min-h-dvh bg-page lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
        {/* sidebar */}
        <aside className="sidebar-hatch hidden flex-col border-r border-dashed border-line-strong px-5 pt-7 pb-5 lg:sticky lg:top-0 lg:flex lg:h-dvh">
          <a href="#/overview" className="rise tap block w-fit rounded-control" style={{ '--d': '0ms' } as CSSProperties}>
            <Junction size={64} proxyBps={flow.proxyBps} directBps={flow.directBps} />
          </a>
          <p className="rise mt-5 font-pixel text-[17px] leading-none" style={{ '--d': '30ms' } as CSSProperties}>
            split<span className="text-accent-ink">/</span>scope
          </p>
          <p className="rise mt-1.5 font-display text-[19px] font-semibold" style={{ '--d': '50ms' } as CSSProperties}>
            分流镜
          </p>
          <p className="rise mt-2 text-[13px] leading-relaxed text-ink-2" style={{ '--d': '70ms' } as CSSProperties}>
            OpenClash / mihomo 的每条连接、每台设备、每条规则，一页看清楚。
          </p>

          <nav className="rise mt-6 border-t border-dashed border-line-strong pt-4" style={{ '--d': '100ms' } as CSSProperties} aria-label="页面">
            {SECTIONS.map((sec) => (
              <div key={sec.id} className="mb-3">
                <p className="eyebrow mb-1.5 px-2">{sec.label}</p>
                <ul className="space-y-0.5">
                  {TABS.filter((t) => t.section === sec.id).map((t) => {
                    const active = route.tab === t.id;
                    return (
                      <li key={t.id}>
                        <a
                          href={`#/${t.id}`}
                          aria-current={active ? 'page' : undefined}
                          className={`tap flex items-center gap-2.5 rounded-control px-2 py-[6px] text-[14px] ${active ? 'bg-field font-medium text-ink shadow-card' : 'text-ink-2 hover:bg-hover hover:text-ink'}`}
                        >
                          <t.icon className="h-4 w-4 flex-none" strokeWidth={1.7} />
                          <span className="flex-1">{t.label}</span>
                          {t.id === 'cases' && (status?.drafts?.pending ?? 0) > 0 && (
                            <span
                              className="rounded-chip bg-accent-soft px-1.5 font-mono text-[11px] text-accent-ink"
                              title="规则草稿里待改的条数"
                              onClick={(e) => {
                                e.preventDefault();
                                navigate('cases', undefined, { view: 'drafts' });
                              }}
                            >
                              草稿 {status!.drafts!.pending}
                            </span>
                          )}
                          {counts[t.id] != null && <AnimatedNumber value={Number(counts[t.id])} className="font-mono text-[11.5px] text-ink-3" />}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>

          <div className="flex-1" />

          <div className="rise space-y-2 border-t border-dashed border-line-strong pt-4 text-[12.5px] text-ink-2" style={{ '--d': '140ms' } as CSSProperties}>
            <p className="eyebrow mb-1">Status</p>
            <div className="flex flex-col gap-1.5">{lamps}</div>
            <p className="num pt-1 font-mono text-[11.5px] text-ink-3">
              ↓ {fmtSpeed(live.totals.downSpeed) || '0 B/s'} · ↑ {fmtSpeed(live.totals.upSpeed) || '0 B/s'}
              <br />
              累计 {fmtBytes(live.totals.down)}
            </p>
            <button onClick={toggleTheme} className="tap mt-1 inline-flex items-center gap-1.5 rounded-control px-1.5 py-1 text-[12px] text-ink-2 hover:bg-hover hover:text-ink">
              {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
              {theme === 'dark' ? '浅色' : '深色'}
            </button>
          </div>
        </aside>

        {/* main column */}
        <div className="min-w-0">
          <header className="sticky top-0 z-30 border-b border-dashed border-line-strong bg-page/85 backdrop-blur-md">
            <div className="flex items-center justify-between gap-3 px-4 sm:px-6 2xl:px-8 py-2.5">
              <div className="flex min-w-0 items-center gap-3">
                <span className="lg:hidden">
                  <Junction size={30} proxyBps={flow.proxyBps} directBps={flow.directBps} />
                </span>
                <div className="min-w-0">
                  <p className="truncate font-display text-[15px] font-semibold">{tab.label}</p>
                  <p className="hidden truncate text-[12px] text-ink-2 sm:block">{tab.desc}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 text-[12px] text-ink-2">
                {tab.ranged && (
                  <span className="hidden sm:block">
                    <RangeSwitch value={range} onChange={setRange} />
                  </span>
                )}
                <span className="hidden items-center gap-4 md:flex lg:hidden">{lamps}</span>
                <span className="md:hidden">
                  <Lamp on={live.connected} live>
                    {live.active.size}
                  </Lamp>
                </span>
                <button onClick={toggleTheme} className="tap rounded-control p-1.5 hover:bg-hover hover:text-ink lg:hidden" aria-label="切换深浅色">
                  {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </header>

          {tab.ranged && (
            <div className="border-b border-dashed border-line-strong px-4 sm:px-6 2xl:px-8 py-2 sm:hidden">
              <RangeSwitch value={range} onChange={setRange} />
            </div>
          )}

          {snap?.drift && (
            <div className="border-b border-dashed border-line-strong bg-signal-bg px-4 sm:px-6 2xl:px-8 py-2.5 text-[13px]">
              <span className="font-medium text-signal">磁盘上的 yaml 与内核正在运行的配置不一致</span>
              ：内核多 {snap.drift.onlyRunning.length} 条、yaml 多 {snap.drift.onlyDisk.length} 条。可能刚上传了新配置还没重载；测试结果以内核正在运行的配置为准。
              <a href="#/data" className="link ml-1.5">
                查看差异
              </a>
            </div>
          )}

          <main key={route.tab} className="px-4 sm:px-6 2xl:px-8 pt-6 pb-28" style={{ viewTransitionName: 'page' } as CSSProperties}>
            {route.tab === 'overview' && <Overview range={range} live={live} />}
            {route.tab === 'live' && <Live live={live} params={route.params} />}
            {route.tab === 'flow' && <Flow range={range} live={live} />}
            {route.tab === 'nodes' && <Nodes range={range} />}
            {route.tab === 'regions' && <Regions range={range} />}
            {route.tab === 'checkup' && <Checkup range={range} live={live} params={route.params} />}
            {route.tab === 'health' && <Health range={range} />}
            {route.tab === 'cases' && <Cases live={live} />}
            {route.tab === 'analyze' && <Analyze initialQuery={route.q} snapshotName={snap?.configName} />}
            {route.tab === 'devices' && <Devices live={live} range={range} />}
            {route.tab === 'rules' && <Rules metaVersion={live.metaVersion} />}
            {route.tab === 'data' && <DataSources status={status} reload={reload} />}
          </main>
        </div>
      </div>
      </div>
      <Dock
        tabs={TABS}
        sections={SECTIONS}
        current={route.tab}
        drafts={status?.drafts?.pending ?? 0}
        density={density}
        setDensity={setDensity}
        dark={theme === 'dark'}
        toggleTheme={toggleTheme}
        openPalette={openPalette}
      />
      {palette && <Palette tabs={TABS} devices={live.devices} onClose={closePalette} navigate={go} />}
    </ToastHost>
  );
}
