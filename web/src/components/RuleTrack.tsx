import { groupColor } from '../lib/format.ts';

interface Station {
  index: number;
  type: string;
  payload: string;
  target: string;
}

/**
 * The rule list drawn as one track: mihomo walks it left to right and stops at the first hit.
 * Bars rise from the stations that caught something; the UDP catch-all is marked so it is clear why
 * unmatched UDP never reaches MATCH. Labels live in their own rows so nothing overlaps the track.
 */
export function RuleTrack({ rules, hits, udpIndex, barHeight = 44 }: { rules: Station[]; hits: Map<number, number>; udpIndex?: number; barHeight?: number }) {
  if (!rules.length) return null;
  const n = rules.length;
  const max = Math.max(1, ...hits.values());
  const pct = (i: number) => ((i + 0.5) / n) * 100;
  // scale bars by sqrt so one huge station does not flatten the rest
  const h = (c: number) => 4 + (barHeight - 6) * Math.sqrt(c / max);
  const peaks = [...hits].filter(([i, c]) => [...hits].every(([j, d]) => j === i || Math.abs(j - i) > 3 || d < c || (d === c && j > i)));
  const top = [...hits].sort((a, b) => b[1] - a[1]).slice(0, 3);

  return (
    <div className="w-full select-none">
      {/* count labels */}
      <div className="relative h-4 font-mono text-[10px] text-ink-2">
        {peaks.map(([i, c]) => (
          <span key={i} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${pct(i)}%` }} title={`#${i} ${rules[i]?.type}(${rules[i]?.payload}) → ${rules[i]?.target}`}>
            {c >= 10000 ? `${Math.round(c / 1000)}k` : c}
          </span>
        ))}
      </div>
      {/* bars + track */}
      <svg className="block w-full overflow-visible" height={barHeight + 10} aria-hidden>
        {udpIndex !== undefined && (
          <line x1={`${pct(udpIndex)}%`} x2={`${pct(udpIndex)}%`} y1={2} y2={barHeight + 8} stroke="var(--signal)" strokeDasharray="2 3" strokeWidth="1.2" />
        )}
        {[...hits].map(([i, c]) => {
          const r = rules[i];
          if (!r) return null;
          return (
            <line key={i} x1={`${pct(i)}%`} x2={`${pct(i)}%`} y1={barHeight} y2={barHeight - h(c)} stroke={groupColor(r.target)} strokeWidth="3.5" strokeLinecap="round">
              <title>{`#${i} ${r.type}(${r.payload}) → ${r.target}：${c}`}</title>
            </line>
          );
        })}
        <line x1="0" x2="100%" y1={barHeight + 4} y2={barHeight + 4} stroke="var(--line-strong)" strokeWidth="2" strokeLinecap="round" />
        {rules.map((r) => (
          <circle key={r.index} cx={`${pct(r.index)}%`} cy={barHeight + 4} r={hits.has(r.index) ? 3.2 : 1.3} fill={hits.has(r.index) ? groupColor(r.target) : 'var(--ink-3)'} />
        ))}
      </svg>
      {/* legend row */}
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 font-mono text-[10.5px] text-ink-3">
        <span>#0 第一条</span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {top.map(([i, c]) => (
            <span key={i} className="inline-flex items-center gap-1 text-ink-2">
              <span className="h-2 w-[3px] rounded-full" style={{ background: groupColor(rules[i]?.target) }} />#{i} {rules[i]?.payload || rules[i]?.type} · {c}
            </span>
          ))}
          {udpIndex !== undefined && (
            <span className="inline-flex items-center gap-1 text-signal">
              <span className="inline-block w-3 border-t border-dashed border-signal" />#{udpIndex} UDP 兜底
            </span>
          )}
        </span>
        <span>#{n - 1} MATCH</span>
      </div>
    </div>
  );
}
