import { CornerDownLeft, Grip, LayoutList, Moon, Rows3, Search, Split, Sun, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Device } from '../../../shared/types.ts';
import { KindIcon } from './bits.tsx';

export interface DockTab {
  id: string;
  label: string;
  desc: string;
  icon: LucideIcon;
  section: string;
}

export type Density = 'comfy' | 'compact';

/** pages that are long lists, where the density switch does something */
const DENSE_PAGES = new Set(['live', 'cases']);
/** what a phone gets one tap away (with short labels); the rest is under 更多 */
const PHONE_TABS = ['overview', 'live', 'cases', 'analyze'];
const SHORT: Record<string, string> = { overview: '概览', live: '实时', cases: '异常', analyze: '测试' };

/**
 * Floating pill at the bottom. Phones: the main pages plus 更多 (the header has no room for
 * twelve tabs). Wider screens, where the sidebar already navigates: search and row density.
 */
export function Dock({
  tabs,
  sections,
  current,
  drafts,
  density,
  setDensity,
  dark,
  toggleTheme,
  openPalette,
}: {
  tabs: readonly DockTab[];
  sections: readonly { id: string; label: string }[];
  current: string;
  drafts: number;
  density: Density;
  setDensity: (d: Density) => void;
  dark: boolean;
  toggleTheme: () => void;
  openPalette: () => void;
}) {
  const [more, setMore] = useState(false);
  const phoneTabs = PHONE_TABS.map((id) => tabs.find((t) => t.id === id)!).filter(Boolean);
  const inMore = !PHONE_TABS.includes(current);
  const densityToggle = DENSE_PAGES.has(current) && (
    <span className="flex items-center gap-0.5" role="group" aria-label="行密度">
      {(
        [
          ['comfy', LayoutList, '舒适'],
          ['compact', Rows3, '紧凑'],
        ] as const
      ).map(([d, Icon, label]) => (
        <button
          key={d}
          onClick={() => setDensity(d)}
          aria-pressed={density === d}
          title={`${label}：${d === 'compact' ? '每条一行，一屏看更多' : '显示每条的第二行信息'}`}
          className={`tap rounded-full p-1.5 ${density === d ? 'bg-field text-ink shadow-card' : 'text-ink-3 hover:text-ink'}`}
        >
          <Icon className="h-4 w-4" strokeWidth={1.8} />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </span>
  );

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-3 z-40 flex justify-center px-3 lg:bottom-5 lg:pl-[248px]">
        <nav className="dock-in pointer-events-auto flex items-center gap-1 rounded-full bg-page/80 p-1 shadow-overlay ring-1 ring-line backdrop-blur-xl" aria-label="快捷操作">
          {/* phones: main pages */}
          <span className="flex items-center gap-0.5 lg:hidden">
            {phoneTabs.map((t) => {
              const on = current === t.id;
              return (
                <a
                  key={t.id}
                  href={`#/${t.id}`}
                  aria-current={on ? 'page' : undefined}
                  className={`tap relative flex flex-col items-center gap-0.5 rounded-full px-3 py-1.5 text-[10.5px] ${on ? 'bg-field text-ink shadow-card' : 'text-ink-2'}`}
                >
                  <t.icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
                  {SHORT[t.id] ?? t.label}
                  {t.id === 'cases' && drafts > 0 && <span className="absolute top-1 right-2 h-1.5 w-1.5 rounded-full bg-accent" aria-label={`规则草稿 ${drafts} 条`} />}
                </a>
              );
            })}
            <button
              onClick={() => setMore(true)}
              aria-expanded={more}
              className={`tap flex flex-col items-center gap-0.5 rounded-full px-3 py-1.5 text-[10.5px] ${inMore ? 'bg-field text-ink shadow-card' : 'text-ink-2'}`}
            >
              <Grip className="h-[18px] w-[18px]" strokeWidth={1.8} />
              {inMore ? (tabs.find((t) => t.id === current)?.label.slice(0, 4) ?? '更多') : '更多'}
            </button>
          </span>

          {/* wider screens: search + density */}
          <button onClick={openPalette} className="tap hidden items-center gap-2 rounded-full px-3 py-1.5 text-[13px] text-ink-2 hover:bg-hover hover:text-ink lg:flex">
            <Search className="h-4 w-4" strokeWidth={1.8} />
            搜索、跳转、测试
            <kbd className="rounded-chip bg-field px-1.5 font-mono text-[11px] text-ink-3 shadow-plate">/</kbd>
          </button>
          {densityToggle && (
            <>
              <span className="mx-0.5 hidden h-5 w-px bg-line-strong lg:block" />
              <span className="hidden lg:flex">{densityToggle}</span>
            </>
          )}
        </nav>
      </div>

      {more && (
        <MoreSheet
          tabs={tabs}
          sections={sections}
          current={current}
          drafts={drafts}
          dark={dark}
          toggleTheme={toggleTheme}
          densityToggle={densityToggle}
          onSearch={() => {
            setMore(false);
            openPalette();
          }}
          onClose={() => setMore(false)}
        />
      )}
    </>
  );
}

function MoreSheet({
  tabs,
  sections,
  current,
  drafts,
  dark,
  toggleTheme,
  densityToggle,
  onSearch,
  onClose,
}: {
  tabs: readonly DockTab[];
  sections: readonly { id: string; label: string }[];
  current: string;
  drafts: number;
  dark: boolean;
  toggleTheme: () => void;
  densityToggle: React.ReactNode;
  onSearch: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onHash = () => onClose();
    window.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onHash);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onHash);
    };
  }, [onClose]);
  return (
    <div className="overlay-in fixed inset-0 z-50 flex items-end bg-black/25 backdrop-blur-[2px]" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="全部页面" className="sheet-in w-full rounded-t-[22px] bg-page px-4 pt-3 pb-6 shadow-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-line-strong" />
        <button onClick={onSearch} className="tap mb-4 flex h-10 w-full items-center gap-2 rounded-control bg-field px-3 text-[14px] text-ink-3 shadow-plate">
          <Search className="h-4 w-4" /> 搜索页面、设备，或输入域名去测试
        </button>
        {sections.map((s) => (
          <div key={s.id} className="mb-3">
            <p className="eyebrow mb-1.5">{s.label}</p>
            <div className="grid grid-cols-3 gap-1.5">
              {tabs
                .filter((t) => t.section === s.id)
                .map((t) => (
                  <a
                    key={t.id}
                    href={`#/${t.id}`}
                    aria-current={current === t.id ? 'page' : undefined}
                    className={`tap relative flex flex-col items-center gap-1 rounded-control px-1 py-2.5 text-[12.5px] ${current === t.id ? 'bg-field font-medium text-ink shadow-card' : 'text-ink-2 hover:bg-hover'}`}
                  >
                    <t.icon className="h-5 w-5" strokeWidth={1.7} />
                    {t.label}
                    {t.id === 'cases' && drafts > 0 && <span className="absolute top-1.5 right-2 rounded-chip bg-accent-soft px-1 font-mono text-[10px] text-accent-ink">草稿 {drafts}</span>}
                  </a>
                ))}
            </div>
          </div>
        ))}
        <div className="mt-4 flex items-center justify-between border-t border-dashed border-line-strong pt-3 text-[13px] text-ink-2">
          <button onClick={toggleTheme} className="tap inline-flex items-center gap-1.5 rounded-control px-2 py-1.5 hover:bg-hover">
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            {dark ? '浅色' : '深色'}
          </button>
          {densityToggle}
          <button onClick={onClose} className="tap rounded-control p-1.5 hover:bg-hover" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- quick jump ---------- */

type Item = { key: string; icon: React.ReactNode; title: string; hint: string; go: () => void };

const looksLikeTarget = (s: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(s) || /^https?:\/\//i.test(s);

/** "/" or ⌘K: jump to a page or a device, or take what was typed to the test / the live list. */
export function Palette({
  tabs,
  devices,
  onClose,
  navigate,
}: {
  tabs: readonly DockTab[];
  devices: Map<string, Device>;
  onClose: () => void;
  navigate: (tab: string, q?: string, params?: Record<string, string>) => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const items = useMemo<Item[]>(() => {
    const s = q.trim().toLowerCase();
    const out: Item[] = [];
    const go = (fn: () => void) => () => {
      fn();
      onClose();
    };
    const actions: Item[] = s
      ? [
          { key: 'test', icon: <Split className="h-4 w-4" />, title: `分流测试「${q.trim()}」`, hint: '用内核真实判定它走哪条规则', go: go(() => navigate('analyze', q.trim())) },
          { key: 'live', icon: <Search className="h-4 w-4" />, title: `在实时连接里找「${q.trim()}」`, hint: '筛选正在进行的连接', go: go(() => navigate('live', undefined, { q: q.trim() })) },
        ]
      : [];
    // a domain or URL is most likely meant for the test; anything else looks for a page or device first
    if (looksLikeTarget(s)) out.push(...actions);
    for (const t of tabs) {
      if (s && !`${t.label} ${t.desc} ${t.id}`.toLowerCase().includes(s)) continue;
      out.push({ key: `tab:${t.id}`, icon: <t.icon className="h-4 w-4" />, title: t.label, hint: t.desc, go: go(() => navigate(t.id)) });
    }
    if (s) {
      for (const d of devices.values()) {
        if (d.special && d.special !== 'docker') continue;
        if (!`${d.label} ${d.ip} ${d.mac} ${d.model ?? ''}`.toLowerCase().includes(s)) continue;
        out.push({ key: `dev:${d.ip}`, icon: <KindIcon kind={d.kind} className="h-4 w-4" />, title: d.label, hint: `设备 · ${d.ip}`, go: go(() => navigate('devices', undefined, { ip: d.ip })) });
        if (out.length > 30) break;
      }
    }
    if (!looksLikeTarget(s)) out.push(...actions);
    return out;
  }, [q, tabs, devices, navigate, onClose]);

  useEffect(() => setSel(0), [q]);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  return (
    <div className="overlay-in fixed inset-0 z-[55] flex items-start justify-center bg-black/25 px-3 pt-[12vh] backdrop-blur-[2px]" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="搜索和跳转" className="dialog-in w-full max-w-[560px] overflow-hidden rounded-card bg-page shadow-overlay ring-1 ring-line" onClick={(e) => e.stopPropagation()}>
        <label className="flex items-center gap-2.5 border-b border-dashed border-line-strong px-4">
          <Search className="h-4 w-4 flex-none text-ink-3" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                items[sel]?.go();
              } else if (e.key === 'Escape') onClose();
            }}
            placeholder="页面、设备，或输入域名 / IP / App 名去测试"
            className="palette-input h-12 min-w-0 flex-1 bg-transparent text-[15px] placeholder:text-ink-3"
            aria-label="搜索"
          />
          <kbd className="rounded-chip bg-field px-1.5 font-mono text-[11px] text-ink-3 shadow-plate">esc</kbd>
        </label>
        <ul ref={list} className="max-h-[52vh] overflow-y-auto p-1.5 scroll-thin" role="listbox">
          {items.length === 0 && <li className="px-3 py-8 text-center text-[13px] text-ink-3">没有匹配的页面或设备</li>}
          {items.map((it, i) => (
            <li key={it.key} data-i={i} role="option" aria-selected={i === sel}>
              <button
                onMouseMove={() => setSel(i)}
                onClick={it.go}
                className={`flex w-full items-center gap-3 rounded-control px-3 py-2 text-left ${i === sel ? 'bg-field shadow-card' : ''}`}
              >
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[8px] bg-page text-ink-2 shadow-plate">{it.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px]">{it.title}</span>
                  <span className="block truncate text-[12px] text-ink-3">{it.hint}</span>
                </span>
                {i === sel && <CornerDownLeft className="h-3.5 w-3.5 flex-none text-ink-3" />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
