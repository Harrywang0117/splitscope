import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useData, type LiveData, type Range } from '../api.ts';
import { navigate } from '../App.tsx';
import { Card, rise, SectionHead, Segmented } from '../components/bits.tsx';
import { fmtBytes, groupColor } from '../lib/format.ts';

interface FlowResp {
  left: { key: string; label: string }[];
  links1: { from: string; to: string; bytes: number }[];
  links2: { from: string; to: string; bytes: number }[];
  directNodes: string[];
}

interface N {
  id: string;
  col: 0 | 1 | 2;
  key: string;
  label: string;
  value: number;
  y: number;
  h: number;
}

interface L {
  id: string;
  from: N;
  to: N;
  value: number;
  sy: number;
  ty: number;
  h: number;
  color: string;
}

const PAD_X = 170;
const NODE_W = 10;
const GAP = 10;

export function Flow({ range, live }: { range: Range; live: LiveData }) {
  const [left, setLeft] = useState<'device' | 'service'>('device');
  const [hover, setHover] = useState<string | null>(null);
  const { data, loading } = useData<FlowResp>(`/api/history/flow?range=${range}&left=${left}`, 60_000);
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(900);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(720, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (!data || !data.links1.length) return null;
    const direct = new Set(data.directNodes);
    const labelOf = (k: string) => {
      if (left === 'device') {
        if (k === '__other') return '其他设备';
        return live.devices.get(k)?.label ?? k;
      }
      return data.left.find((x) => x.key === k)?.label ?? k;
    };
    const cols: Map<string, N>[] = [new Map(), new Map(), new Map()];
    const ensure = (col: 0 | 1 | 2, key: string, label: string) => {
      let n = cols[col].get(key);
      if (!n) cols[col].set(key, (n = { id: `${col}:${key}`, col, key, label, value: 0, y: 0, h: 0 }));
      return n;
    };
    for (const l of data.links1) {
      ensure(0, l.from, labelOf(l.from)).value += l.bytes;
      ensure(1, l.to, l.to);
    }
    for (const l of data.links2) {
      ensure(1, l.from, l.from).value += l.bytes;
      ensure(2, l.to, l.to).value += l.bytes;
    }
    const maxCount = Math.max(...cols.map((c) => c.size));
    const H = Math.max(380, maxCount * 30);
    const total = Math.max(...cols.map((c) => [...c.values()].reduce((s, n) => s + n.value, 0)));
    const k = (H - GAP * (maxCount - 1)) / Math.max(1, total);
    const colX = [PAD_X, w / 2 - NODE_W / 2, w - PAD_X - NODE_W];
    for (const col of cols) {
      const nodes = [...col.values()].sort((a, b) => b.value - a.value);
      const used = nodes.reduce((s, n) => s + Math.max(3, n.value * k), 0) + GAP * (nodes.length - 1);
      let y = (H - used) / 2;
      for (const n of nodes) {
        n.h = Math.max(3, n.value * k);
        n.y = y;
        y += n.h + GAP;
      }
    }
    const out = new Map<string, number>();
    const inn = new Map<string, number>();
    const mk = (from: N, to: N, value: number, color: string): L => {
      const h = Math.max(1, value * k);
      const sy = from.y + (out.get(from.id) ?? 0);
      const ty = to.y + (inn.get(to.id) ?? 0);
      out.set(from.id, (out.get(from.id) ?? 0) + h);
      inn.set(to.id, (inn.get(to.id) ?? 0) + h);
      return { id: `${from.id}>${to.id}`, from, to, value, sy, ty, h, color };
    };
    const sortBy = (a: { from: string; to: string; bytes: number }, b: { from: string; to: string; bytes: number }) => b.bytes - a.bytes;
    const links: L[] = [];
    for (const l of [...data.links1].sort(sortBy)) links.push(mk(cols[0].get(l.from)!, cols[1].get(l.to)!, l.bytes, groupColor(l.to)));
    for (const l of [...data.links2].sort(sortBy)) links.push(mk(cols[1].get(l.from)!, cols[2].get(l.to)!, l.bytes, groupColor(l.from)));
    return { H, colX, nodes: cols.flatMap((c) => [...c.values()]), links, direct, total };
  }, [data, w, left, live.devices]);

  const related = (l: L) => !hover || l.from.id === hover || l.to.id === hover;
  const nodeOn = (n: N) => !hover || n.id === hover || layout?.links.some((l) => related(l) && (l.from.id === n.id || l.to.id === n.id));

  const band = (l: L, x0: number, x1: number) => {
    const xm = (x0 + x1) / 2;
    return `M${x0},${l.sy}C${xm},${l.sy} ${xm},${l.ty} ${x1},${l.ty}L${x1},${l.ty + l.h}C${xm},${l.ty + l.h} ${xm},${l.sy + l.h} ${x0},${l.sy + l.h}Z`;
  };
  const center = (l: L, x0: number, x1: number) => {
    const xm = (x0 + x1) / 2;
    return `M${x0},${l.sy + l.h / 2}C${xm},${l.sy + l.h / 2} ${xm},${l.ty + l.h / 2} ${x1},${l.ty + l.h / 2}`;
  };

  const click = (n: N) => {
    if (n.col === 0 && left === 'device' && n.key !== '__other') navigate('live', undefined, { device: n.key });
    else if (n.col === 0 && left === 'service') navigate('live', n.label);
    else if (n.col === 1) navigate('live', undefined, { group: n.key });
    else if (n.col === 2) navigate('nodes', n.key);
  };

  return (
    <div className="space-y-4">
      <SectionHead
        className="rise"
        style={rise(0)}
        title={left === 'device' ? '设备 → 策略组 → 出口节点' : '服务 → 策略组 → 出口节点'}
        desc="线越粗流量越大；悬停一个节点只看它的流向，点击跳到对应的连接"
        aside={
          <Segmented
            label="左侧"
            value={left}
            onChange={setLeft}
            options={[
              ['device', '按设备'],
              ['service', '按服务'],
            ]}
          />
        }
      />
      <Card className="rise overflow-x-auto p-4 scroll-thin" style={rise(1)}>
        <div ref={wrap} className="min-w-[720px]">
          {!layout ? (
            <p className="py-16 text-center text-[13px] text-ink-3">{loading ? '读取中…' : '这段时间还没有流量记录。'}</p>
          ) : (
            <svg width={w} height={layout.H + 24} className="block">
              {['', '策略组', '出口节点'].map((t, i) =>
                t ? (
                  <text key={t} x={layout.colX[i] + NODE_W / 2} y={layout.H + 18} textAnchor="middle" className="fill-[var(--ink-3)] font-mono text-[10.5px]">
                    {t}
                  </text>
                ) : null,
              )}
              {layout.links.map((l) => {
                const x0 = layout.colX[l.from.col] + NODE_W;
                const x1 = layout.colX[l.to.col];
                const on = related(l);
                return (
                  <g key={l.id} style={{ opacity: on ? 1 : 0.12, transition: 'opacity .2s' }}>
                    <path d={band(l, x0, x1)} fill={l.color} opacity={0.22}>
                      <title>{`${l.from.label} → ${l.to.label}：${fmtBytes(l.value)}`}</title>
                    </path>
                    {l.h > 2.5 && <path d={center(l, x0, x1)} fill="none" stroke={l.color} strokeWidth={Math.min(2.2, l.h / 3)} strokeDasharray="1 19" strokeLinecap="round" className="flow-dash" opacity={0.85} />}
                  </g>
                );
              })}
              {layout.nodes.map((n) => {
                const x = layout.colX[n.col];
                const color = n.col === 1 ? groupColor(n.key) : n.col === 2 ? (layout.direct.has(n.key) ? 'var(--go)' : 'var(--accent)') : 'var(--ink-2)';
                const labelLeft = n.col === 0;
                return (
                  <g
                    key={n.id}
                    onMouseEnter={() => setHover(n.id)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => click(n)}
                    className="cursor-pointer"
                    style={{ opacity: nodeOn(n) ? 1 : 0.3, transition: 'opacity .2s' }}
                  >
                    <rect x={x} y={n.y} width={NODE_W} height={n.h} rx={3} fill={color} />
                    <text
                      x={labelLeft ? x - 8 : x + NODE_W + 8}
                      y={n.y + n.h / 2 + 4}
                      textAnchor={labelLeft ? 'end' : 'start'}
                      className="fill-[var(--ink)] text-[12px]"
                    >
                      {n.label.length > 18 ? `${n.label.slice(0, 17)}…` : n.label}
                      <tspan className="fill-[var(--ink-3)] font-mono text-[10.5px]"> {fmtBytes(n.value)}</tspan>
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      </Card>
    </div>
  );
}
