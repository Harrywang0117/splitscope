import { ArrowUpRight } from 'lucide-react';
import { useState } from 'react';
import { useData, type LiveData, type Range } from '../api.ts';
import { navigate } from '../App.tsx';
import { AnimatedNumber, Card, rise, SectionHead, Segmented } from '../components/bits.tsx';
import { HistoryRank, seriesColor, TrendChart } from '../components/data.tsx';
import { fmtBytes } from '../lib/format.ts';

interface Summary {
  up: number;
  down: number;
  conns: number;
  proxyShare: number;
  devices: number;
  services: number;
  hosts: number;
  fallbackConns: number;
}

interface Trend {
  bucketMs: number;
  start: number;
  points: number;
  series: { name: string; values: number[] }[];
}

interface CheckItem {
  intentional: boolean;
  conns: number;
}

const RANGE_TEXT: Record<Range, string> = { '1h': '最近 1 小时', '24h': '最近 24 小时', '7d': '最近 7 天', '30d': '最近 30 天' };
const CHECKS = [
  ['cn_proxy', '国内走代理', '国内服务绕了一圈出境'],
  ['intl_direct', '境外走直连', '可能被墙或很慢'],
  ['fallback', '落到兜底', '没被任何具体规则命中'],
  ['udp_fallback', 'UDP 兜底', 'QUIC 等 UDP 流量的兜底'],
] as const;

type RankDim = 'service' | 'host' | 'device' | 'group' | 'node' | 'country' | 'rule';

export function Overview({ range, live }: { range: Range; live: LiveData }) {
  const [by, setBy] = useState<'direct' | 'group'>('direct');
  const [dim, setDim] = useState<RankDim>('service');
  const { data: sum } = useData<Summary>(`/api/history/summary?range=${range}`, 30_000);
  const { data: tr } = useData<Trend>(`/api/history/trend?range=${range}&by=${by}`, 30_000);
  const { data: chk } = useData<Record<string, CheckItem[] | string>>(`/api/checkup?range=${range}`, 60_000);

  const total = (sum?.up ?? 0) + (sum?.down ?? 0);
  const checkCount = (k: string) => ((chk?.[k] as CheckItem[] | undefined) ?? []).filter((i) => !i.intentional).length;

  return (
    <div className="space-y-8">
      {/* KPIs */}
      <section className="space-y-3">
        <SectionHead className="rise" style={rise(0)} title={RANGE_TEXT[range]} desc="历史从网站启动后开始记录，排行按整点汇总" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card className="rise px-4 py-3.5" style={rise(1)}>
            <p className="eyebrow">Traffic</p>
            <p className="mt-1 font-display text-[26px] leading-none font-semibold">
              <AnimatedNumber value={total} format={fmtBytes} />
            </p>
            <p className="num mt-1.5 font-mono text-[11.5px] text-ink-3">
              ↓ {fmtBytes(sum?.down ?? 0)} · ↑ {fmtBytes(sum?.up ?? 0)}
            </p>
          </Card>
          <Card className="rise px-4 py-3.5" style={rise(2)}>
            <p className="eyebrow">Via proxy</p>
            <p className="mt-1 font-display text-[26px] leading-none font-semibold">
              <AnimatedNumber value={(sum?.proxyShare ?? 0) * 100} format={(n) => `${Math.round(n)}%`} />
            </p>
            <span className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-field">
              <span className="bg-accent transition-[width] duration-700 ease-(--ease-out)" style={{ width: `${(sum?.proxyShare ?? 0) * 100}%` }} />
              <span className="flex-1 bg-go" />
            </span>
            <p className="mt-1 text-[11.5px] text-ink-3">代理 · 直连</p>
          </Card>
          <Card className="rise px-4 py-3.5" style={rise(3)}>
            <p className="eyebrow">Connections</p>
            <p className="mt-1 font-display text-[26px] leading-none font-semibold">
              <AnimatedNumber value={sum?.conns ?? 0} format={(n) => Math.round(n).toLocaleString()} />
            </p>
            <p className="mt-1.5 text-[11.5px] text-ink-3">
              {sum?.devices ?? 0} 台设备 · {sum?.services ?? 0} 个服务 · {sum?.hosts ?? 0} 个域名/IP
            </p>
          </Card>
          <button className="rise tap text-left" style={rise(4)} onClick={() => navigate('checkup', undefined, { tab: 'fallback' })}>
            <Card className="h-full px-4 py-3.5 hover:shadow-raised">
              <p className="eyebrow">Fallback</p>
              <p className={`mt-1 font-display text-[26px] leading-none font-semibold ${sum?.fallbackConns ? 'text-signal' : ''}`}>
                <AnimatedNumber value={sum?.fallbackConns ?? 0} format={(n) => Math.round(n).toLocaleString()} />
              </p>
              <p className="mt-1.5 text-[11.5px] text-ink-3">条连接落到兜底规则</p>
            </Card>
          </button>
        </div>
      </section>

      {/* trend */}
      <section className="space-y-3">
        <SectionHead
          className="rise"
          style={rise(5)}
          title="流量趋势"
          desc="每段时间的平均速率"
          aside={
            <Segmented
              label="趋势分组"
              value={by}
              onChange={setBy}
              options={[
                ['direct', '直连 / 代理'],
                ['group', '按策略组'],
              ]}
            />
          }
        />
        <Card className="rise px-3 pt-4 pb-2" style={rise(6)}>
          {tr ? <TrendChart key={`${range}-${by}`} start={tr.start} bucketMs={tr.bucketMs} series={tr.series} /> : <div className="h-[220px]" />}
          {tr && tr.series.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 px-2 pt-2 text-[12px] text-ink-2">
              {tr.series.map((s) => (
                <span key={s.name} className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-[3px] rounded-full" style={{ background: seriesColor(s.name) }} />
                  {s.name} <span className="num font-mono text-ink-3">{fmtBytes(s.values.reduce((a, b) => a + b, 0))}</span>
                </span>
              ))}
            </div>
          )}
        </Card>
      </section>

      {/* checkup summary */}
      <section className="space-y-3">
        <SectionHead
          className="rise"
          style={rise(7)}
          title="分流体检"
          desc="排除了你有意设置的服务专属策略组"
          aside={
            <a href="#/checkup" className="link inline-flex items-center gap-1 text-[12.5px]">
              去体检 <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
          }
        />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {CHECKS.map(([k, title, desc], i) => {
            const n = checkCount(k);
            return (
              <button key={k} className="rise tap text-left" style={rise(8 + i)} onClick={() => navigate('checkup', undefined, { tab: k })}>
                <Card className={`h-full px-4 py-3 hover:shadow-raised ${n ? 'shadow-[0_0_0_1px_color-mix(in_srgb,var(--signal)_45%,transparent)]' : ''}`}>
                  <p className="flex items-baseline justify-between gap-2">
                    <span className="text-[13.5px] font-medium">{title}</span>
                    <span className={`num font-display text-[22px] font-semibold ${n ? 'text-signal' : 'text-ink-3'}`}>{n}</span>
                  </p>
                  <p className="text-[12px] text-ink-3">{desc}</p>
                </Card>
              </button>
            );
          })}
        </div>
      </section>

      {/* rankings */}
      <section className="space-y-3">
        <SectionHead
          className="rise"
          style={rise(12)}
          title="排行"
          desc="点列名排序，每页 15 条，可导出 CSV"
          aside={
            <Segmented
              label="排行维度"
              value={dim}
              onChange={setDim}
              options={[
                ['service', '服务'],
                ['host', '域名'],
                ['device', '设备'],
                ['group', '策略组'],
                ['node', '节点'],
                ['country', '国家'],
                ['rule', '规则'],
              ]}
            />
          }
        />
        <div className="rise" style={rise(13)}>
          <HistoryRank
            key={dim}
            range={range}
            dim={dim}
            devices={live.devices}
            onPick={dim === 'device' ? (r) => navigate('devices', undefined, { ip: r.key }) : dim === 'group' ? (r) => navigate('live', undefined, { group: r.key }) : undefined}
          />
        </div>
      </section>
    </div>
  );
}
