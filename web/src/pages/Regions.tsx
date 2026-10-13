import { useMemo } from 'react';
import { useData, type Range } from '../api.ts';
import { navigate } from '../App.tsx';
import { Card, rise, SectionHead } from '../components/bits.tsx';
import { Country, Flag } from '../components/data.tsx';
import { fmtBytes } from '../lib/format.ts';

interface Resp {
  destinations: { country: string; bytes: number; conns: number; direct: number; proxied: number }[];
  exits: { region: string; bytes: number; conns: number; nodes: string[] }[];
  matrix: { country: string; region: string; bytes: number }[];
}

export function Regions({ range }: { range: Range }) {
  const { data, loading } = useData<Resp>(`/api/regions?range=${range}`, 120_000);
  const dest = data?.destinations ?? [];
  const exits = data?.exits ?? [];
  const maxD = Math.max(1, ...dest.map((d) => d.bytes));
  const maxE = Math.max(1, ...exits.map((e) => e.bytes));

  const grid = useMemo(() => {
    const rows = dest.slice(0, 10).map((d) => d.country);
    const cols = exits.slice(0, 8).map((e) => e.region);
    const m = new Map((data?.matrix ?? []).map((x) => [`${x.country}|${x.region}`, x.bytes]));
    const max = Math.max(1, ...[...m.values()]);
    return { rows, cols, m, max };
  }, [data, dest, exits]);

  // the two combinations the checkup cares about
  const odd = (country: string, region: string) => (country === 'CN' && region !== 'LOCAL' ? 'cn_proxy' : country !== 'CN' && country !== '' && country !== '?' && region === 'LOCAL' ? 'intl_direct' : '');

  return (
    <div className="space-y-8">
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3">
          <SectionHead className="rise" style={rise(0)} title="目标在哪" desc="按目标 IP 所在国家；经代理的连接用参考解析，仅供参考" />
          <Card className="rise overflow-hidden" style={rise(1)}>
            {dest.length === 0 ? (
              <p className="px-4 py-10 text-center text-[13px] text-ink-3">{loading ? '读取中…' : '这段时间没有记录。'}</p>
            ) : (
              <ul className="divide-y divide-line">
                {dest.slice(0, 15).map((d, i) => (
                  <li key={d.country || '?'} className="rise grid grid-cols-[minmax(0,1fr)_minmax(120px,1.3fr)_76px] items-center gap-3 px-4 py-2" style={rise(i)}>
                    <span className="truncate text-[13px]">
                      <Country code={d.country || '?'} />
                    </span>
                    <span>
                      <span className="flex h-1.5 overflow-hidden rounded-full bg-field" style={{ width: `${Math.max(3, (d.bytes / maxD) * 100)}%` }}>
                        <span className="bg-go" style={{ flexGrow: d.direct || 0.0001 }} title={`直连 ${fmtBytes(d.direct)}`} />
                        <span className="bg-accent" style={{ flexGrow: d.proxied || 0.0001 }} title={`代理 ${fmtBytes(d.proxied)}`} />
                      </span>
                      <span className="mt-0.5 block text-[11px] text-ink-3">
                        直连 {Math.round((d.direct / Math.max(1, d.bytes)) * 100)}% · {d.conns.toLocaleString()} 次
                      </span>
                    </span>
                    <span className="num text-right font-mono text-[12px]">{fmtBytes(d.bytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        <section className="space-y-3">
          <SectionHead className="rise" style={rise(0)} title="从哪出去" desc="按出口节点名里的地区推断；本地直连单独列出" />
          <Card className="rise overflow-hidden" style={rise(1)}>
            {exits.length === 0 ? (
              <p className="px-4 py-10 text-center text-[13px] text-ink-3">{loading ? '读取中…' : '这段时间没有记录。'}</p>
            ) : (
              <ul className="divide-y divide-line">
                {exits.map((e, i) => (
                  <li key={e.region} className="rise grid grid-cols-[minmax(0,1fr)_minmax(120px,1.3fr)_76px] items-center gap-3 px-4 py-2" style={rise(i)}>
                    <span className="min-w-0 text-[13px]">
                      <Country code={e.region} />
                      <span className="block truncate text-[11px] text-ink-3" title={e.nodes.join('\n')}>
                        {e.nodes.slice(0, 2).join('、')}
                        {e.nodes.length > 2 ? ` 等 ${e.nodes.length} 个` : ''}
                      </span>
                    </span>
                    <span className="h-1.5 overflow-hidden rounded-full bg-field">
                      <span className="block h-full rounded-full" style={{ width: `${(e.bytes / maxE) * 100}%`, background: e.region === 'LOCAL' ? 'var(--go)' : 'var(--accent)' }} />
                    </span>
                    <span className="num text-right font-mono text-[12px]">{fmtBytes(e.bytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      </div>

      {grid.rows.length > 0 && grid.cols.length > 0 && (
        <section className="space-y-3">
          <SectionHead className="rise" style={rise(2)} title="目标 × 出口" desc="格子越深流量越大；琥珀色的是国内目标走了境外出口、或境外目标走了本地直连，点击去体检" />
          <Card className="rise overflow-x-auto p-4 scroll-thin" style={rise(3)}>
            <table className="w-full min-w-[560px] border-separate border-spacing-1 text-[12px]">
              <thead>
                <tr>
                  <th className="eyebrow w-28 text-left font-normal">目标 \ 出口</th>
                  {grid.cols.map((c) => (
                    <th key={c} className="text-center font-normal text-ink-2" title={c}>
                      <span className="flex justify-center">
                        <Flag code={c} size={16} />
                      </span>
                      <span className="block font-mono text-[10px] text-ink-3">{c === 'LOCAL' ? '直连' : c}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.rows.map((r) => (
                  <tr key={r}>
                    <td className="truncate pr-2 text-ink">
                      <Country code={r || '?'} />
                    </td>
                    {grid.cols.map((c) => {
                      const v = grid.m.get(`${r}|${c}`) ?? 0;
                      const kind = v ? odd(r, c) : '';
                      const a = v ? 0.1 + 0.8 * Math.sqrt(v / grid.max) : 0;
                      return (
                        <td key={c} className="p-0">
                          <button
                            disabled={!kind}
                            onClick={() => kind && navigate('checkup', undefined, { tab: kind })}
                            title={v ? `${fmtBytes(v)}${kind ? '（点击去体检）' : ''}` : ''}
                            className={`tap flex h-9 w-full items-center justify-center rounded-[6px] font-mono text-[10.5px] ${kind ? 'cursor-pointer ring-1 ring-signal' : 'cursor-default'}`}
                            style={{ background: v ? `color-mix(in srgb, ${kind ? 'var(--signal)' : 'var(--accent)'} ${Math.round(a * 100)}%, transparent)` : 'var(--field)', color: a > 0.55 ? 'white' : 'var(--ink-2)' }}
                          >
                            {v ? fmtBytes(v) : ''}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      )}
    </div>
  );
}
