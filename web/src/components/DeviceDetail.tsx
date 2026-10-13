import { ArrowUpRight } from 'lucide-react';
import type { Device } from '../../../shared/types.ts';
import { useData, type Range } from '../api.ts';
import { navigate } from '../App.tsx';
import { fmtAgo, fmtBytes, groupColor, KIND_LABEL } from '../lib/format.ts';
import { Drawer, GroupChip, KindIcon, RuleBadge } from './bits.tsx';
import { Favicon, RowMenu, SplitBar } from './data.tsx';

interface Row {
  key: string;
  label: string;
  bytes: number;
  conns: number;
  fallback: number;
  sample: string;
  groups: { group: string; bytes: number }[];
}

interface Resp {
  services: Row[];
  groups: Row[];
  fallbacks: { host: string; svc: string; grp: string; rule: string; fallback: string; conns: number; bytes: number; last: number }[];
  series: { stepMs: number; points: { t: number; bytes: number; proxied: number }[] };
}

const RANGE_TEXT: Record<Range, string> = { '1h': '最近 1 小时', '24h': '最近 24 小时', '7d': '最近 7 天', '30d': '最近 30 天' };

export function DeviceDetail({ ip, device, range, onClose }: { ip: string; device?: Device; range: Range; onClose: () => void }) {
  const { data, loading } = useData<Resp>(`/api/history/device/${encodeURIComponent(ip)}?range=${range}`, 60_000);
  const total = (data?.groups ?? []).reduce((s, g) => s + g.bytes, 0);
  const pts = data?.series.points ?? [];
  const maxP = Math.max(1, ...pts.map((p) => p.bytes));
  const maxS = Math.max(1, ...(data?.services ?? []).map((s) => s.bytes));

  return (
    <Drawer
      eyebrow="Device"
      onClose={onClose}
      title={
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 flex-none items-center justify-center rounded-control bg-field text-ink-2 shadow-plate">
            <KindIcon kind={device?.kind ?? ''} className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-display text-[17px] font-semibold">{device?.label ?? ip}</span>
            <span className="block truncate font-mono text-[11.5px] text-ink-2">
              {[ip, device?.mac, device?.model, KIND_LABEL[device?.kind ?? '']].filter(Boolean).join(' · ')}
            </span>
          </span>
        </div>
      }
    >
      <div className="space-y-6">
        <section>
          <p className="eyebrow mb-1.5">{RANGE_TEXT[range]} · {fmtBytes(total)}</p>
          {/* proxied (accent) on top of direct (green), one bar per step */}
          <div className="flex h-20 items-end gap-[2px]">
            {pts.length === 0 && <p className="text-[12px] text-ink-3">{loading ? '读取中…' : '这段时间没有流量。'}</p>}
            {pts.map((p) => (
              <span key={p.t} className="flex flex-1 flex-col justify-end overflow-hidden rounded-t-[2px]" style={{ height: `${Math.max(2, (p.bytes / maxP) * 100)}%` }} title={`${new Date(p.t).toLocaleString('zh-CN', { hour12: false })}：${fmtBytes(p.bytes)}，代理 ${fmtBytes(p.proxied)}`}>
                <span className="bg-accent" style={{ flexGrow: p.proxied || 0.0001 }} />
                <span className="bg-go" style={{ flexGrow: p.bytes - p.proxied || 0.0001 }} />
              </span>
            ))}
          </div>
          <p className="mt-1 flex gap-3 text-[11px] text-ink-3">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-[2px] bg-accent" /> 代理
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-[2px] bg-go" /> 直连
            </span>
          </p>
        </section>

        <section>
          <p className="eyebrow mb-2">策略组</p>
          <SplitBar parts={(data?.groups ?? []).map((g) => ({ group: g.key, bytes: g.bytes }))} total={total} max={total} height={8} />
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-2">
            {(data?.groups ?? []).slice(0, 8).map((g) => (
              <span key={g.key} className="inline-flex items-center gap-1">
                <span className="h-2 w-[3px] rounded-full" style={{ background: groupColor(g.key) }} />
                {g.key} {Math.round((g.bytes / Math.max(1, total)) * 100)}%
              </span>
            ))}
          </div>
        </section>

        <section>
          <p className="eyebrow mb-1">常用服务</p>
          <ul className="divide-y divide-line">
            {(data?.services ?? []).map((s) => (
              <li key={s.key} className="flex items-center gap-2.5 py-2">
                <Favicon host={s.sample || s.key.replace(/^site:/, '')} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2 text-[13px]">
                    <span className="truncate">{s.label}</span>
                    <span className="num flex-none font-mono text-[11.5px] text-ink-2">{fmtBytes(s.bytes)}</span>
                  </span>
                  <SplitBar parts={s.groups} total={s.bytes} max={maxS} height={4} />
                </span>
              </li>
            ))}
          </ul>
        </section>

        {(data?.fallbacks.length ?? 0) > 0 && (
          <section>
            <p className="eyebrow mb-1">落到兜底的</p>
            <ul className="divide-y divide-line">
              {data!.fallbacks.map((f) => (
                <li key={f.host + f.grp} className="flex items-center gap-2 py-2 text-[12.5px]">
                  <Favicon host={f.host} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono">{f.host}</span>
                    <span className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
                      <RuleBadge type={f.rule.split('|')[0]} payload={f.rule.split('|')[1]} /> · {f.conns} 次 · {fmtAgo(f.last)}
                    </span>
                  </span>
                  <GroupChip name={f.grp} dim />
                  <RowMenu host={f.host} from={`设备 ${device?.label ?? ip}`} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="flex flex-wrap gap-2">
          <button onClick={() => navigate('live', undefined, { device: ip })} className="tap inline-flex items-center gap-1.5 rounded-control bg-ink px-3.5 py-2 text-[13px] font-medium text-page hover:bg-ink/85">
            看它的实时连接 <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </Drawer>
  );
}
