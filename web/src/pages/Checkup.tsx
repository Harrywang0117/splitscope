import { ArrowRight, ChevronDown, Download, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useData, type LiveData, type Range } from '../api.ts';
import { navigate } from '../App.tsx';
import { Button, Card, GroupChip, RuleBadge, rise, SectionHead, Segmented, useToast } from '../components/bits.tsx';
import { Country, Favicon, RowMenu } from '../components/data.tsx';
import { basket, targetOf } from '../lib/basket.ts';
import { downloadCsv } from '../lib/csv.ts';
import { fmtAgo, fmtBytes } from '../lib/format.ts';

interface Item {
  host: string;
  service: string;
  group: string;
  rule: string;
  scope: string;
  country: string;
  network: string;
  conns: number;
  bytes: number;
  devices: number;
  srcs: string[];
  last: number;
  intentional: boolean;
  expect: string;
}

type Kind = 'cn_proxy' | 'intl_direct' | 'fallback' | 'udp_fallback';
type Resp = Record<Kind, Item[]> & { domestic: string; foreign: string };

const KINDS: { id: Kind; label: string; explain: string }[] = [
  { id: 'cn_proxy', label: '国内走代理', explain: '目标是国内服务（GeoSite 归为 cn，或 IP 在中国），却从代理出去了。浪费代理流量，也可能被国内服务的风控当成境外访问。' },
  { id: 'intl_direct', label: '境外走直连', explain: '目标是境外服务，却直连出去了。如果是被墙的服务，连接会失败或很慢。' },
  { id: 'fallback', label: '落到兜底', explain: '没有被任何具体规则命中，最后由 MATCH 兜底。兜底组是什么出口，这些连接就走什么出口。' },
  { id: 'udp_fallback', label: 'UDP 兜底', explain: '没被具体规则命中的 UDP（多是 QUIC、NTP、游戏），停在 NETWORK,UDP 那一条。' },
];

const SCOPE: Record<string, string> = { cn: '国内', intl: '境外' };

export function Checkup({ range, live, params }: { range: Range; live: LiveData; params: URLSearchParams }) {
  const initial = (params.get('tab') as Kind) || 'cn_proxy';
  const [kind, setKind] = useState<Kind>(KINDS.some((k) => k.id === initial) ? initial : 'cn_proxy');
  const [showIntentional, setShowIntentional] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expect, setExpect] = useState<Map<string, string>>(new Map());
  const toast = useToast();
  const { data, loading } = useData<Resp>(`/api/checkup?range=${range}`, 60_000);

  useEffect(() => {
    setPicked(new Set());
  }, [kind, range]);

  const items = data?.[kind] ?? [];
  const suspicious = items.filter((i) => !i.intentional);
  const intentional = items.filter((i) => i.intentional);
  const shown = showIntentional ? items : suspicious;
  const keyOf = (i: Item) => `${i.host}|${i.group}|${i.rule}`;
  const counts = useMemo(() => Object.fromEntries(KINDS.map((k) => [k.id, (data?.[k.id] ?? []).filter((i) => !i.intentional).length])) as Record<Kind, number>, [data]);
  const groups = useMemo(() => {
    const set = new Set<string>([data?.domestic ?? '', data?.foreign ?? '', 'DIRECT', 'REJECT']);
    for (const k of KINDS) for (const i of data?.[k.id] ?? []) set.add(i.group);
    return [...set].filter(Boolean);
  }, [data]);

  const expectOf = (i: Item) => expect.get(keyOf(i)) ?? i.expect;
  const toBasket = (list: Item[], go: boolean) => {
    const n = basket.add(list.map((i) => targetOf(i.host, `体检 · ${KINDS.find((k) => k.id === kind)?.label}`, expectOf(i) || undefined, i.service || undefined)));
    if (go) navigate('analyze', '@basket');
    else toast(`已加入测试清单 ${n} 条（重复的会合并）`);
  };
  const deviceName = (ip: string) => live.devices.get(ip)?.label ?? ip;
  const selected = shown.filter((i) => picked.has(keyOf(i)));

  return (
    <div className="space-y-5">
      <SectionHead
        className="rise"
        style={rise(0)}
        title="分流体检"
        desc="从历史连接里挑出分得可疑的，确认后一键带去分流测试，生成调整规则"
        aside={
          <Segmented
            label="体检项目"
            value={kind}
            onChange={setKind}
            options={KINDS.map((k) => [k.id, `${k.label} ${counts[k.id] ?? 0}`] as [Kind, string])}
          />
        }
      />
      <Card className="rise px-4 py-3 text-[13px] leading-relaxed text-ink-2" style={rise(1)}>
        {KINDS.find((k) => k.id === kind)?.explain}
        {data && (
          <span className="mt-1 block text-[12px] text-ink-3">
            建议的期望策略组：国内 → <span className="text-ink">{data.domestic}</span>，境外 → <span className="text-ink">{data.foreign}</span>（按正在运行的 China / Proxy 类规则集推断，每行都能改）。
          </span>
        )}
      </Card>

      <Card className="rise overflow-hidden" style={rise(2)}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed border-line-strong px-4 py-2.5">
          <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
            <input
              type="checkbox"
              className="accent-[var(--accent)]"
              checked={shown.length > 0 && shown.every((i) => picked.has(keyOf(i)))}
              onChange={(e) => setPicked(e.target.checked ? new Set(shown.map(keyOf)) : new Set())}
            />
            全选 {shown.length} 条 · 已选 {selected.length}
          </label>
          <span className="flex flex-wrap items-center gap-1.5">
            <button
              className="tap inline-flex items-center gap-1 rounded-chip px-2 py-1 text-[12px] text-ink-2 hover:bg-hover hover:text-ink"
              onClick={() =>
                downloadCsv(`体检-${kind}-${range}`, ['域名/IP', '服务', '归属', '国家', '命中规则', '策略组', '连接', '流量', '设备', '最后出现', '期望策略组'], shown.map((i) => [i.host, i.service, SCOPE[i.scope] ?? '', i.country, i.rule.replace('|', ' '), i.group, i.conns, i.bytes, i.srcs.map(deviceName).join(' / '), new Date(i.last).toISOString(), expectOf(i)]))
              }
            >
              <Download className="h-3.5 w-3.5" /> CSV
            </button>
            <Button kind="ghost" className="h-8 px-3" disabled={!selected.length} onClick={() => toBasket(selected, false)}>
              <Plus className="h-3.5 w-3.5" /> 加入测试清单
            </Button>
            <Button kind="primary" className="h-8 px-3" disabled={!selected.length} onClick={() => toBasket(selected, true)}>
              带去分流测试 <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </span>
        </div>
        <div className="eyebrow hidden border-b border-line px-4 py-2 lg:grid lg:grid-cols-[18px_minmax(200px,1.6fr)_minmax(170px,1.2fr)_minmax(120px,0.8fr)_88px_150px_28px] lg:gap-4">
          <span />
          <span>域名 / IP · 服务</span>
          <span>命中规则 · 策略组</span>
          <span>设备</span>
          <span className="text-right">连接 · 流量</span>
          <span>期望策略组</span>
          <span />
        </div>
        {shown.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] text-ink-3">{loading ? '读取中…' : '这段时间没有发现这类问题。'}</p>
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((i, n) => {
              const k = keyOf(i);
              return (
                <li key={k} className={`rise px-4 py-2.5 lg:grid lg:grid-cols-[18px_minmax(200px,1.6fr)_minmax(170px,1.2fr)_minmax(120px,0.8fr)_88px_150px_28px] lg:items-center lg:gap-4 ${i.intentional ? 'opacity-60' : ''}`} style={rise(Math.min(n, 20))}>
                  <input
                    type="checkbox"
                    aria-label={`选中 ${i.host}`}
                    className="accent-[var(--accent)]"
                    checked={picked.has(k)}
                    onChange={(e) =>
                      setPicked((s) => {
                        const next = new Set(s);
                        if (e.target.checked) next.add(k);
                        else next.delete(k);
                        return next;
                      })
                    }
                  />
                  <span className="flex min-w-0 items-center gap-2">
                    <Favicon host={i.host} />
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[13px]">{i.host}</span>
                      <span className="flex items-center gap-1.5 truncate text-[11.5px] text-ink-3">
                        {i.service && <span className="truncate">{i.service}</span>}
                        {i.scope && <span className="rounded-chip bg-field px-1 font-pixel text-[10px]">{SCOPE[i.scope]}</span>}
                        {i.country && <Country code={i.country} />}
                        {i.network === 'udp' && <span className="font-pixel text-[10px]">UDP</span>}
                        <span>· {fmtAgo(i.last)}</span>
                      </span>
                    </span>
                  </span>
                  <span className="mt-1 flex min-w-0 flex-col gap-1 lg:mt-0">
                    <RuleBadge type={i.rule.split('|')[0]} payload={i.rule.split('|')[1]} />
                    <span>
                      <GroupChip name={i.group} />
                    </span>
                  </span>
                  <span className="mt-1 block min-w-0 truncate text-[12px] text-ink-2 lg:mt-0" title={i.srcs.map(deviceName).join('\n')}>
                    {i.srcs.slice(0, 2).map(deviceName).join('、')}
                    {i.srcs.length > 2 ? ` 等 ${i.srcs.length} 台` : ''}
                  </span>
                  <span className="num mt-1 block font-mono text-[12px] lg:mt-0 lg:text-right">
                    {i.conns.toLocaleString()} 次<span className="block text-[11px] text-ink-3">{fmtBytes(i.bytes)}</span>
                  </span>
                  <select
                    value={expectOf(i)}
                    onChange={(e) => setExpect((m) => new Map(m).set(k, e.target.value))}
                    className="mt-1.5 h-8 w-full rounded-control bg-page px-2 text-[12.5px] shadow-card outline-none focus:shadow-[0_0_0_1.5px_var(--accent)] lg:mt-0"
                    aria-label={`${i.host} 的期望策略组`}
                  >
                    <option value="">不指定</option>
                    {groups.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                  <span className="hidden justify-end lg:flex">
                    <RowMenu host={i.host} expect={expectOf(i) || undefined} from="体检" />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {intentional.length > 0 && (
          <button onClick={() => setShowIntentional(!showIntentional)} className="tap flex w-full items-center justify-center gap-1.5 border-t border-dashed border-line-strong px-4 py-2.5 text-[12.5px] text-ink-2 hover:bg-hover hover:text-ink">
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showIntentional ? 'rotate-180' : ''}`} />
            {showIntentional ? '收起' : `另有 ${intentional.length} 条走的是服务专属策略组（如 Apple、Microsoft）或手写规则，看起来是有意设置的`}
          </button>
        )}
      </Card>
    </div>
  );
}
