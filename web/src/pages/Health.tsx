import { useLayoutEffect, useRef, useState } from 'react';
import { useData, type Range } from '../api.ts';
import { AnimatedNumber, Card, Lamp, rise, SectionHead } from '../components/bits.tsx';
import { fmtAgo, fmtDateTime } from '../lib/format.ts';

interface Stat {
  uptime: number;
  avg: number | null;
  p95: number | null;
  last: number | null;
  failures: number;
}

interface Point {
  ts: number;
  api_ms: number;
  dns_ms: number;
  direct_ms: number;
  proxy_ms: number;
  live: number;
  conns: number;
}

interface Resp {
  samples: number;
  gaps: number;
  points: Point[];
  api: Stat;
  dns: Stat;
  direct: Stat;
  proxy: Stat;
  targets: { direct: string; proxy: string };
  jobs: { snapshot: { at: number; trigger: string; drift: boolean }; intel: { at: number; running: boolean; errors: number }; history: number };
}

const METRICS = [
  { key: 'api_ms', stat: 'api', title: '内核 API', desc: 'OpenClash 控制接口的响应时间', color: 'var(--accent)' },
  { key: 'dns_ms', stat: 'dns', title: 'DNS', desc: '内核解析 www.baidu.com', color: '#8b5cf6' },
  { key: 'direct_ms', stat: 'direct', title: '国内直连', desc: '经内核访问国内的 generate_204', color: 'var(--go)' },
  { key: 'proxy_ms', stat: 'proxy', title: '代理线路', desc: '经内核访问 gstatic 的 generate_204', color: '#e0457b' },
] as const;

/** Latency line with failures as red ticks along the bottom. */
function Spark({ points, k, color }: { points: Point[]; k: 'api_ms' | 'dns_ms' | 'direct_ms' | 'proxy_ms'; color: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(300);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 64;
  const ok = points.filter((p) => p[k] >= 0).map((p) => p[k]);
  const max = Math.max(1, ...ok) * 1.1;
  const n = points.length;
  const x = (i: number) => (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  let d = '';
  points.forEach((p, i) => {
    if (p[k] < 0) return;
    d += `${d && points[i - 1]?.[k] >= 0 ? 'L' : 'M'}${x(i)},${H - 6 - (p[k] / max) * (H - 12)}`;
  });
  return (
    <div ref={ref} className="w-full">
      <svg width={w} height={H} className="trend-reveal block">
        <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
        {points.map((p, i) => (p[k] < 0 ? <rect key={i} x={x(i) - 1} y={H - 4} width={2} height={4} fill="var(--stop)" /> : null))}
      </svg>
    </div>
  );
}

export function Health({ range }: { range: Range }) {
  const { data } = useData<Resp>(`/api/health?range=${range}`, 60_000);
  const pts = data?.points ?? [];
  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SectionHead className="rise" style={rise(0)} title="线路状态" desc={`每分钟检查一次${range === '30d' ? '（只保留 8 天）' : ''}；红色短线是失败的那几分钟`} />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {METRICS.map((m, i) => {
            const s = data?.[m.stat];
            return (
              <Card key={m.key} className="rise overflow-hidden px-4 pt-3.5 pb-2" style={rise(i + 1)}>
                <div className="flex items-baseline justify-between">
                  <p className="text-[13.5px] font-medium">{m.title}</p>
                  <span className={`num font-mono text-[11.5px] ${s && s.uptime < 0.99 ? 'text-signal' : 'text-ink-3'}`}>可用 {s ? (s.uptime * 100).toFixed(1) : '—'}%</span>
                </div>
                <p className="mt-1 flex items-baseline gap-1.5">
                  <span className="font-display text-[26px] leading-none font-semibold">{s?.avg != null ? <AnimatedNumber value={s.avg} /> : '—'}</span>
                  <span className="text-[12px] text-ink-3">ms 平均 · p95 {s?.p95 ?? '—'}</span>
                </p>
                <p className="mt-0.5 text-[11.5px] text-ink-3">{m.desc}</p>
                <div className="-mx-1 mt-2">
                  <Spark points={pts} k={m.key} color={m.color} />
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <SectionHead className="rise" style={rise(5)} title="网站自身" desc="后台任务和数据采集" />
        <Card className="rise divide-y divide-line" style={rise(6)}>
          {[
            {
              ok: !!data && data.gaps === 0,
              warn: !!data && data.gaps > 0,
              title: '采集连续性',
              text: data ? (data.gaps ? `${data.samples} 个样本，其中 ${data.gaps} 处中断（网站停过）` : `${data.samples} 个样本，没有中断`) : '—',
            },
            {
              ok: !!data?.jobs.history,
              title: '历史写入',
              text: data?.jobs.history ? `上次写入 ${fmtAgo(data.jobs.history)}（每分钟一次）` : '还没有写入',
            },
            {
              ok: !!data?.jobs.snapshot.at,
              warn: data?.jobs.snapshot.drift,
              title: '配置快照',
              text: data?.jobs.snapshot.at ? `${fmtDateTime(data.jobs.snapshot.at)} 读取${data.jobs.snapshot.drift ? '；yaml 与内核运行的不一致' : ''}` : '还没有读取',
            },
            {
              ok: !!data?.jobs.intel.at && !data.jobs.intel.errors,
              warn: data?.jobs.intel.running || !!data?.jobs.intel.errors,
              title: '识别库',
              text: data?.jobs.intel.running ? '正在更新' : data?.jobs.intel.at ? `${fmtDateTime(data.jobs.intel.at)} 更新${data.jobs.intel.errors ? `，${data.jobs.intel.errors} 项失败` : ''}` : '还没有更新',
            },
          ].map((r) => (
            <div key={r.title} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px]">
              <Lamp on={r.ok} warn={r.warn}>
                <span className="font-medium">{r.title}</span>
              </Lamp>
              <span className="text-ink-2">{r.text}</span>
            </div>
          ))}
        </Card>
        {data && (
          <p className="text-[12px] text-ink-3">
            检测地址：直连 <span className="font-mono">{data.targets.direct}</span>，代理 <span className="font-mono">{data.targets.proxy}</span>。它们按你的规则分流，所以测的就是家里设备实际会走的那条线。
          </p>
        )}
      </section>
    </div>
  );
}
