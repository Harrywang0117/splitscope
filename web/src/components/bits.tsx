import {
  Camera,
  Cpu,
  Gamepad2,
  HelpCircle,
  Laptop,
  Router,
  Server,
  Smartphone,
  Tablet,
  Tv,
  X,
  type LucideIcon,
} from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ProviderInfo, ServiceInfo } from '../../../shared/types.ts';
import { groupColor, sourceLabel } from '../lib/format.ts';

/** stagger helper for the rise-in entrance */
export const rise = (i: number): CSSProperties => ({ '--d': `${Math.min(i, 24) * 26}ms` }) as CSSProperties;

/** A number that glides to its new value instead of jumping (instant under reduced motion). */
export function AnimatedNumber({ value, format = (n: number) => String(Math.round(n)), className = '' }: { value: number; format?: (n: number) => string; className?: string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = from.current;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / 520);
      const eased = 1 - Math.pow(1 - k, 4);
      const v = start + (value - start) * eased;
      from.current = v;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span className={`num ${className}`}>{format(shown)}</span>;
}

/* ---------- brand ---------- */

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** A dithered junction: one line in, two lines out — the whole product in 18×18 pixels. */
export function Logo({ size = 56 }: { size?: number }) {
  const n = 18;
  const segs = [
    [1, 9, 7.5, 9],
    [7.5, 9, 16.5, 2.5],
    [7.5, 9, 16.5, 15.5],
  ];
  const cells: ReactNode[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.min(...segs.map((s) => distToSeg(x + 0.5, y + 0.5, s[0], s[1], s[2], s[3])));
      const glow = Math.max(0, 1 - d / 3.2);
      const core = d < 1.05;
      if (!core && glow * 16 <= BAYER[y % 4][x % 4] + 1) continue;
      const t = x / n;
      cells.push(
        <rect
          key={`${x}-${y}`}
          x={x}
          y={y}
          width={0.86}
          height={0.86}
          rx={0.12}
          fill={core ? `color-mix(in oklab, #00bbff ${100 - t * 55}%, #3b4fd8)` : `color-mix(in oklab, #00bbff ${80 - t * 40}%, #7c8cff)`}
          opacity={core ? 1 : 0.35 + glow * 0.4}
        />,
      );
    }
  }
  return (
    <svg viewBox={`0 0 ${n} ${n}`} width={size} height={size} aria-hidden className="block">
      {cells}
    </svg>
  );
}

/* ---------- surfaces ---------- */

export function Card({ children, className = '', style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <section className={`rounded-card bg-page shadow-card ${className}`} style={style}>
      {children}
    </section>
  );
}

/** "01  Title  muted description" — the index is only used where the order means something */
export function SectionHead({
  index,
  title,
  desc,
  aside,
  className = '',
  style,
}: {
  index?: string;
  title: ReactNode;
  desc?: ReactNode;
  aside?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 ${className}`} style={style}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
        {index && <span className="font-pixel text-[12px] text-ink-3">{index}</span>}
        <h2 className="font-display text-[17px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
        {desc && <span className="text-[13px] text-ink-2">{desc}</span>}
      </div>
      {aside}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-chip bg-field px-1.5 font-mono text-[11px] text-ink-2 shadow-plate">
      {children}
    </kbd>
  );
}

export function Button({
  children,
  onClick,
  kind = 'ghost',
  disabled,
  type = 'button',
  title,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'ghost' | 'quiet';
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  className?: string;
}) {
  const look =
    kind === 'primary'
      ? 'bg-ink text-page hover:bg-ink/85'
      : kind === 'quiet'
        ? 'text-ink-2 hover:bg-hover hover:text-ink'
        : 'bg-page text-ink shadow-card hover:bg-hover';
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`tap inline-flex h-9 items-center justify-center gap-1.5 rounded-control px-3.5 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-45 ${look} ${className}`}
    >
      {children}
    </button>
  );
}

/** segmented control with a sliding pill */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  label: string;
}) {
  const i = Math.max(0, options.findIndex(([v]) => v === value));
  // the outer box scrolls on narrow screens; the inner grid keeps its own width so the pill math holds
  return (
    <div className="max-w-full overflow-x-auto rounded-control scroll-thin">
    <div role="tablist" aria-label={label} className="relative inline-grid rounded-control bg-field p-0.5 text-[13px]" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      <span
        aria-hidden
        className="absolute top-0.5 bottom-0.5 rounded-[8px] bg-page shadow-card transition-transform duration-300 ease-(--ease-out)"
        style={{ width: `calc((100% - 4px) / ${options.length})`, left: 2, transform: `translateX(${i * 100}%)` }}
      />
      {options.map(([v, l]) => (
        <button
          key={v}
          role="tab"
          aria-selected={v === value}
          onClick={() => onChange(v)}
          className={`relative z-10 rounded-[8px] px-3 py-1.5 whitespace-nowrap transition-colors ${v === value ? 'font-medium text-ink' : 'text-ink-2 hover:text-ink'}`}
        >
          {l}
        </button>
      ))}
    </div>
    </div>
  );
}

export function Toggle({ on, set, children, tone }: { on: boolean; set: (v: boolean) => void; children: ReactNode; tone?: 'signal' }) {
  const active = tone === 'signal' ? 'bg-signal-bg text-signal shadow-[0_0_0_1px_color-mix(in_srgb,var(--signal)_35%,transparent)]' : 'bg-accent-soft text-accent-ink shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent)_35%,transparent)]';
  return (
    <button onClick={() => set(!on)} aria-pressed={on} className={`tap inline-flex h-9 items-center gap-1.5 rounded-control px-3 text-[13px] ${on ? active : 'bg-page text-ink-2 shadow-card hover:text-ink'}`}>
      {children}
    </button>
  );
}

/* ---------- data atoms ---------- */

export function GroupChip({ name, dim }: { name?: string; dim?: boolean }) {
  if (!name) return <span className="text-ink-3">—</span>;
  const color = groupColor(name);
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-chip py-0.5 pr-2 pl-1.5 text-[12.5px] font-medium whitespace-nowrap text-ink"
      style={{ background: `color-mix(in srgb, ${color} ${dim ? 7 : 11}%, transparent)` }}
      title={name}
    >
      <span className="h-2.5 w-[3px] flex-none rounded-full" style={{ background: color }} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** group ━━ node: where a connection actually went */
export function RouteStrip({ chain, node, nodeProvider }: { chain: string[]; node?: string; nodeProvider?: string }) {
  const group = chain[0];
  const last = node ?? (chain.length > 1 ? chain[chain.length - 1] : '');
  const hops = Math.max(0, chain.length - 2);
  return (
    <span className="flex min-w-0 max-w-full items-center gap-1.5">
      <GroupChip name={group} />
      {last && last !== group && (
        <>
          <span className="relative h-[2px] w-4 flex-none rounded" style={{ background: groupColor(group) }}>
            {hops > 0 && <span className="absolute -top-[3px] left-1/2 h-2 w-2 -translate-x-1/2 rounded-full border-2 bg-page" style={{ borderColor: groupColor(group) }} title={chain.slice(1, -1).join(' › ')} />}
          </span>
          <span className="min-w-0 truncate text-[12.5px] text-ink-2" title={[...chain.slice(1), nodeProvider ? `订阅 ${nodeProvider}` : ''].filter(Boolean).join(' › ')}>
            {last}
          </span>
        </>
      )}
    </span>
  );
}

export function RuleBadge({ type, payload, index }: { type?: string; payload?: string; index?: number }) {
  if (!type) return <span className="text-ink-3">—</span>;
  const fallback = type === 'Match' || type === 'Network';
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5 font-mono text-[12px]" title={`#${index ?? '?'} ${type}${payload ? `(${payload})` : ''}`}>
      {index !== undefined && index >= 0 && <span className="num text-ink-3">#{index}</span>}
      <span className={fallback ? 'font-medium text-signal' : 'text-ink'}>{type}</span>
      {payload && <span className="min-w-0 truncate text-ink-2">{payload}</span>}
    </span>
  );
}

export function FallbackTag({ kind }: { kind: string }) {
  if (!kind) return null;
  return <span className="shrink-0 whitespace-nowrap rounded-chip bg-signal-bg px-1.5 py-px font-pixel text-[10.5px] text-signal">{kind === 'udp' ? 'UDP 兜底' : '兜底'}</span>;
}

export function ServiceName({ service }: { service: ServiceInfo | null | undefined }) {
  if (!service) return <span className="text-ink-3">未识别</span>;
  return (
    <span className="min-w-0 truncate" title={[sourceLabel(service.id), ...service.also.map(sourceLabel)].join('\n')}>
      {service.name}
      {service.category && <span className="text-ink-3"> · {service.category}</span>}
    </span>
  );
}

export function ProviderLine({ p, approx }: { p: ProviderInfo | null | undefined; approx?: boolean }) {
  if (!p) return <span className="text-ink-3">—</span>;
  const name = p.brand ?? p.org ?? (p.asn ? `AS${p.asn}` : '');
  return (
    <span
      className="flex min-w-0 max-w-full items-baseline gap-1.5"
      title={`${p.ip}${p.asn ? ` · AS${p.asn} ${p.org ?? ''}` : ''}${approx ? '\n参考解析：取自 DoH，可能与节点实际连接的地址不同' : ''}`}
    >
      {p.country && <span className="font-mono text-[10.5px] text-ink-3">{p.country}</span>}
      <span className="min-w-0 truncate">{name || p.ip}</span>
      {approx && <span className="font-pixel text-[10px] text-ink-3">≈</span>}
    </span>
  );
}

export function Lamp({ on, warn, live, children }: { on: boolean; warn?: boolean; live?: boolean; children: ReactNode }) {
  const color = warn ? 'var(--signal)' : on ? 'var(--go)' : 'var(--stop)';
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span className={`lamp ${live && on && !warn ? 'lamp-live' : ''}`} style={{ color }} />
      {children}
    </span>
  );
}

const KIND_ICON: Record<string, LucideIcon> = {
  phone: Smartphone,
  computer: Laptop,
  tablet: Tablet,
  tv: Tv,
  console: Gamepad2,
  iot: Cpu,
  camera: Camera,
  router: Router,
  server: Server,
};

export function KindIcon({ kind, className = 'h-4 w-4' }: { kind: string; className?: string }) {
  const I = KIND_ICON[kind] ?? HelpCircle;
  return <I className={`${className} flex-none`} strokeWidth={1.6} aria-hidden />;
}

/* ---------- overlay ---------- */

export function Drawer({ title, eyebrow, onClose, children }: { title: ReactNode; eyebrow?: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay-in fixed inset-0 z-50 flex justify-end bg-black/25 backdrop-blur-[2px]" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        className="dialog-in m-2 flex h-[calc(100%-1rem)] w-full max-w-[460px] flex-col overflow-hidden rounded-card bg-page shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-dashed border-line px-5 py-4">
          <div className="min-w-0">
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            <div className="mt-1">{title}</div>
          </div>
          <button onClick={onClose} className="tap rounded-control p-1.5 text-ink-2 hover:bg-hover hover:text-ink" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4 scroll-thin">{children}</div>
      </aside>
    </div>
  );
}

/* ---------- toast ---------- */

type ToastAction = { label: string; run: () => void };
type ToastItem = { id: number; text: string; tone?: 'error'; action?: ToastAction };
type Toast = (text: string, tone?: 'error', action?: ToastAction) => void;
const ToastCtx = createContext<Toast>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback<Toast>((text, tone, action) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-2), { id, text, tone, action }]);
    // a toast with a button stays long enough to reach for it
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), action ? 6000 : 2600);
  }, []);
  useEffect(() => {
    let last = 0;
    const onReadonly = (e: Event) => {
      // several writes can fail at once (bulk actions); say it once
      if (Date.now() - last < 3000) return;
      last = Date.now();
      push(String((e as CustomEvent).detail ?? '这台设备只能查看'), 'error');
    };
    window.addEventListener('splitscope:readonly', onReadonly);
    return () => window.removeEventListener('splitscope:readonly', onReadonly);
  }, [push]);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast-in pointer-events-auto flex items-center gap-2.5 rounded-control bg-page px-4 py-2.5 text-[13px] shadow-overlay ${t.tone === 'error' ? 'text-stop' : 'text-ink'}`}>
            <span className="lamp" style={{ color: t.tone === 'error' ? 'var(--stop)' : 'var(--accent)' }} />
            {t.text}
            {t.action && (
              <button
                className="tap ml-1 shrink-0 rounded-chip bg-accent-soft px-2 py-0.5 text-[12.5px] font-medium text-accent-ink hover:brightness-95"
                onClick={() => {
                  t.action!.run();
                  setItems((xs) => xs.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
