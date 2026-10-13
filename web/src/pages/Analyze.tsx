import { ArrowRight, Check, Copy, Download, FilePlus2, ListChecks, Search, Target, Wand2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnalysisSummary, Candidate, ProbeResult, ProbeTarget, ProviderInfo, ServiceInfo } from '../../../shared/types.ts';
import { draftsChanged, getJson, sendJson, useData } from '../api.ts';
import { navigate } from '../App.tsx';
import { Button, Card, ProviderLine, RouteStrip, RuleBadge, rise, SectionHead, ServiceName, useToast } from '../components/bits.tsx';
import { RuleTrack } from '../components/RuleTrack.tsx';
import { fmtDateTime, groupColor, sourceLabel, TARGET_KIND_LABEL } from '../lib/format.ts';
import { buildRules, inCidr, yamlItem, type Adjustment } from '../lib/rules.ts';
import { basket, keyOf, useBasket } from '../lib/basket.ts';
import { downloadCsv } from '../lib/csv.ts';

interface SearchResp {
  input: { kind: 'domain' | 'ip' | 'cidr' | 'name'; value: string } | null;
  target?: ProbeTarget;
  info?: { service: ServiceInfo | null; provider?: ProviderInfo | null };
  candidates: Candidate[];
  reverse: Candidate[];
}

interface SnapshotRules {
  snapshot: {
    running: { rules: { index: number; type: string; payload: string; target: string }[] };
    groups: { name: string; type: string }[];
  } | null;
}

interface RunState {
  query: string;
  targets: ProbeTarget[];
  results: (ProbeResult | null)[];
  summary?: AnalysisSummary;
  done: boolean;
  savedId?: number;
  configPath?: string;
}

const EXAMPLES = ['支付宝', '小红书', 'www.google.com', 'claude.ai', '91.108.56.132', 'Netflix'];
const SOURCE_TAG: Record<string, string> = { geosite: 'GeoSite', bm7: 'blackmatrix7', curated: '整理清单' };

export function Analyze({ initialQuery, snapshotName }: { initialQuery: string; snapshotName?: string }) {
  const [q, setQ] = useState(initialQuery);
  const [port, setPort] = useState(443);
  const { data: ready } = useData<{ ok: boolean; problem?: string }>('/api/probe/ready', 30_000);
  const [search, setSearch] = useState<SearchResp | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shakeKey, setShakeKey] = useState(0);
  const [run, setRun] = useState<RunState | null>(null);
  const [prefill, setPrefill] = useState<Map<string, string>>(new Map());
  const basketItems = useBasket();
  const [rules, setRules] = useState<SnapshotRules['snapshot']>(null);
  const [history, setHistory] = useState<{ id: number; createdAt: number; query: string; summary: AnalysisSummary }[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const fail = (msg: string) => {
    setError(msg);
    setShakeKey((k) => k + 1);
  };

  const loadHistory = useCallback(() => {
    getJson<typeof history>('/api/analyses').then(setHistory).catch(() => undefined);
  }, []);

  useEffect(() => {
    getJson<SnapshotRules>('/api/snapshot').then((s) => setRules(s.snapshot)).catch(() => undefined);
    loadHistory();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      esRef.current?.close();
      window.removeEventListener('keydown', onKey);
    };
  }, [loadHistory]);

  const startRun = useCallback(
    async (query: string, body: { targets?: ProbeTarget[]; lines?: string[] }) => {
      esRef.current?.close();
      setError('');
      setBusy(true);
      try {
        const { jobId } = await sendJson<{ jobId: string }>('/api/analyze', 'POST', { query, port, ...body });
        const es = new EventSource(`/api/analyze/${jobId}/stream`);
        esRef.current = es;
        es.addEventListener('init', (e) => {
          const d = JSON.parse((e as MessageEvent).data);
          setRun({ query: d.query, targets: d.targets, results: d.results, done: false, configPath: d.configPath });
          setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
        });
        es.addEventListener('result', (e) => {
          const { i, result } = JSON.parse((e as MessageEvent).data) as { i: number; result: ProbeResult };
          setRun((r) => {
            if (!r) return r;
            const results = r.results.slice();
            results[i] = result;
            return { ...r, results };
          });
        });
        es.addEventListener('done', (e) => {
          const d = JSON.parse((e as MessageEvent).data);
          setRun((r) => (r ? { ...r, summary: d.summary, savedId: d.savedId, done: true } : r));
          setBusy(false);
          es.close();
          loadHistory();
        });
        es.onerror = () => {
          setBusy(false);
          es.close();
        };
      } catch (e) {
        fail((e as Error).message);
        setBusy(false);
      }
    },
    [port, loadHistory],
  );

  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return fail('先输入一个域名、IP 或服务名。');
      setError('');
      const lines = text.split(/[\n,，\s]+/).filter(Boolean);
      // several domains / IPs pasted at once: test them directly
      if (lines.length > 1 && lines.every((l) => /[.:]/.test(l))) {
        setSearch(null);
        void startRun(`${lines.length} 个目标`, { lines });
        return;
      }
      try {
        const r = await getJson<SearchResp>(`/api/search?q=${encodeURIComponent(text)}`);
        setSearch(r);
        if (r.input?.kind === 'name') {
          // the same service often exists in several sources: pick every candidate with the top name
          const top = r.candidates[0];
          setSelected(new Set(r.candidates.filter((c) => (c.source === 'curated' ? c.id === top?.id : c.name === top?.name)).map((c) => c.id)));
          if (!r.candidates.length) fail(`没找到叫「${text}」的服务。试试英文名，或者直接输入它的域名。`);
        } else if (r.target) {
          setSelected(new Set());
          void startRun(r.input!.value, { targets: [r.target] });
        }
      } catch (e) {
        fail((e as Error).message);
      }
    },
    [startRun],
  );

  const runBasket = () => {
    const items = basket.get();
    if (!items.length) return;
    setSearch(null);
    setPrefill(new Map(items.filter((i) => i.expect).map((i) => [keyOf(i), i.expect!])));
    void startRun(`测试清单 ${items.length} 条`, { targets: items.map(({ expect: _e, ...t }) => t) });
    basket.clear();
  };

  useEffect(() => {
    if (initialQuery === '@basket') {
      runBasket();
      return;
    }
    if (initialQuery) {
      setQ(initialQuery);
      void submit(initialQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  const candidateList = search?.input?.kind === 'name' ? search.candidates : (search?.reverse ?? []);
  const selectedCount = candidateList.filter((c) => selected.has(c.id)).reduce((n, c) => n + c.count, 0);

  const runSelected = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    setBusy(true);
    try {
      const { targets } = await sendJson<{ targets: ProbeTarget[] }>('/api/expand', 'POST', { ids });
      const names = candidateList.filter((c) => selected.has(c.id)).map((c) => c.name);
      await startRun([...new Set(names)].join(' + ') || q, { targets });
    } catch (e) {
      fail((e as Error).message);
      setBusy(false);
    }
  };

  const openHistory = async (id: number) => {
    esRef.current?.close();
    const a = await getJson<{ query: string; summary: AnalysisSummary; results: ProbeResult[] }>(`/api/analyses/${id}`);
    setRun({ query: a.query, targets: a.results.map((r) => r.target), results: a.results, summary: a.summary, done: true, savedId: id });
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-8">
        {/* 01 input */}
        <section className="space-y-3">
          <SectionHead className="rise" style={rise(0)} index="01" title="输入" desc="域名、网址、IP，或 App / 服务名；多行粘贴可批量测" />
          <form
            key={shakeKey}
            className={`rise ${shakeKey ? 'shake' : ''}`}
            style={rise(1)}
            onSubmit={(e) => {
              e.preventDefault();
              void submit(q);
            }}
          >
            {ready && !ready.ok && <p className="mb-2 rounded-control bg-signal-bg px-3 py-2 text-[13px] text-signal">{ready.problem}</p>}
            <Card className="p-2">
              <div className="flex flex-wrap items-start gap-2">
                <div className="relative min-w-[240px] flex-1">
                  <Search className="pointer-events-none absolute top-3.5 left-3 h-4 w-4 text-ink-3" />
                  <textarea
                    ref={inputRef}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void submit(q);
                      }
                    }}
                    rows={q.includes('\n') ? 4 : 1}
                    placeholder="支付宝 · youtube.com · https://claude.ai/new · 8.8.8.8"
                    className="block min-h-[72px] w-full resize-y rounded-control bg-transparent py-3 pr-3 pl-9 font-mono text-[15px] outline-none placeholder:text-ink-3 sm:min-h-11"
                    aria-label="要测试的目标"
                  />
                </div>
                <label className="flex h-11 items-center gap-2 rounded-control bg-field px-3 text-[12px] text-ink-2 shadow-plate">
                  端口
                  <input type="number" value={port} min={1} max={65535} onChange={(e) => setPort(Number(e.target.value) || 443)} className="w-14 bg-transparent font-mono text-[13px] text-ink outline-none" />
                </label>
                <Button type="submit" kind="primary" disabled={busy} className="h-11 px-5">
                  {busy ? '测试中…' : '查询'}
                  {!busy && <ArrowRight className="h-4 w-4" />}
                </Button>
              </div>
            </Card>
          </form>
          <div className="rise flex flex-wrap items-center gap-1.5 text-[12px] text-ink-2" style={rise(2)}>
            <span className="eyebrow mr-1">Try</span>
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                className="tap rounded-chip bg-field px-2 py-1 hover:bg-hover hover:text-ink"
                onClick={() => {
                  setQ(ex);
                  void submit(ex);
                }}
              >
                {ex}
              </button>
            ))}
          </div>
          {error && <p className="text-[13px] text-stop">{error}</p>}
          {search?.input && search.input.kind !== 'name' && search.info && (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2">
              <span className="eyebrow">Identified</span>
              <span className="text-ink">
                <ServiceName service={search.info.service} />
              </span>
              {search.info.provider && <ProviderLine p={search.info.provider} />}
            </p>
          )}
        </section>

        {basketItems.length > 0 && (
          <Card className="dialog-in p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-[13.5px] font-medium">
                <ListChecks className="h-4 w-4 text-accent-ink" /> 测试清单 · {basketItems.length} 条
                <span className="text-[12px] font-normal text-ink-3">从体检、实时连接、历史排行里加进来的</span>
              </p>
              <span className="flex gap-1.5">
                <Button kind="quiet" className="h-8 px-2.5" onClick={() => basket.clear()}>
                  清空
                </Button>
                <Button kind="primary" className="h-8 px-3" disabled={busy} onClick={runBasket}>
                  测试这 {basketItems.length} 条 <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </span>
            </div>
            <ul className="mt-2.5 flex flex-wrap gap-1.5">
              {basketItems.slice(0, 40).map((i) => (
                <li key={keyOf(i)} className="inline-flex items-center gap-1.5 rounded-chip bg-field py-0.5 pr-1 pl-2 text-[12px]">
                  <span className="max-w-[220px] truncate font-mono">{i.value}</span>
                  {i.expect && (
                    <span className="text-ink-3">
                      → <span style={{ color: groupColor(i.expect) }}>{i.expect}</span>
                    </span>
                  )}
                  <button aria-label={`移除 ${i.value}`} onClick={() => basket.remove(keyOf(i))} className="rounded p-0.5 text-ink-3 hover:bg-hover hover:text-ink">
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
              {basketItems.length > 40 && <li className="px-2 py-0.5 text-[12px] text-ink-3">等 {basketItems.length} 条</li>}
            </ul>
          </Card>
        )}

        {/* 02 sources */}
        {candidateList.length > 0 && (
          <section className="space-y-3">
            <SectionHead
              className="rise"
              style={rise(0)}
              index="02"
              title={search?.input?.kind === 'name' ? '选择来源' : '它属于这些服务'}
              desc={search?.input?.kind === 'name' ? '同一个服务在不同规则库里列的域名不同，可以多选合并' : '想看整个服务的分流，勾选后一起测'}
            />
            <ul className="grid gap-2 sm:grid-cols-2">
              {candidateList.map((c, i) => {
                const on = selected.has(c.id);
                return (
                  <li key={c.id} className="rise" style={rise(i + 1)}>
                    <label className={`tap flex cursor-pointer items-start gap-3 rounded-card px-3.5 py-3 ${on ? 'bg-page shadow-[0_0_0_1.5px_var(--accent),0_2px_8px_-2px_rgb(0_0_0/0.08)]' : 'bg-page shadow-card hover:shadow-raised'}`}>
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={on}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(c.id);
                          else next.delete(c.id);
                          setSelected(next);
                        }}
                      />
                      <span className={`mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-[5px] transition-colors ${on ? 'bg-accent text-white' : 'bg-field shadow-plate'}`}>
                        {on && <Check className="h-3 w-3" strokeWidth={3} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate font-medium">{c.name}</span>
                          <span className="num flex-none font-mono text-[11.5px] text-ink-3">{c.count} 条</span>
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-2">
                          <span className="font-pixel text-[10.5px] text-ink-3">{SOURCE_TAG[c.source] ?? c.source}</span>
                          <span>{c.key}</span>
                          {c.category && <span>· {c.category}</span>}
                          <span>· {c.reason}</span>
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <Button kind="primary" onClick={() => void runSelected()} disabled={busy || !selected.size}>
              测试所选 · {selectedCount} 条规则 <ArrowRight className="h-4 w-4" />
            </Button>
          </section>
        )}

        {/* 03 results */}
        {run && (
          <div ref={resultRef} className="scroll-mt-24">
            <RunView run={run} rules={rules?.running.rules ?? []} groups={rules?.groups ?? []} snapshotName={snapshotName} prefill={prefill} />
          </div>
        )}
      </div>

      <aside className="space-y-3">
        <SectionHead className="rise" style={rise(2)} title="测试记录" desc={history.length ? `${history.length} 次` : undefined} />
        <Card className="rise overflow-hidden" style={rise(3)}>
          {history.length === 0 ? (
            <p className="px-4 py-6 text-[13px] text-ink-2">还没有测试记录。测过的结果会留在这里。</p>
          ) : (
            <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto scroll-thin">
              {history.map((h) => (
                <li key={h.id}>
                  <button onClick={() => void openHistory(h.id)} className={`tap w-full px-4 py-2.5 text-left hover:bg-hover ${run?.savedId === h.id ? 'bg-field' : ''}`}>
                    <span className="block truncate text-[13.5px] font-medium">{h.query || '(未命名)'}</span>
                    <span className="mt-1 flex items-center gap-2 text-[11.5px] text-ink-2">
                      <span className="num font-mono">{fmtDateTime(h.createdAt)}</span>
                      <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-field">
                        {h.summary.byGroup.map((g) => (
                          <span key={g.group} style={{ width: `${(g.count / Math.max(1, h.summary.tested)) * 100}%`, background: groupColor(g.group) }} />
                        ))}
                      </span>
                      {h.summary.fallback > 0 && <span className="text-signal">兜底 {h.summary.fallback}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </aside>
    </div>
  );
}

type Rule = { index: number; type: string; payload: string; target: string };
type Group = { name: string; type: string };

const isFallbackResult = (r: ProbeResult | null) => r?.rule?.type === 'Match' || r?.rule?.type === 'Network';

function RunView({ run, rules, groups, snapshotName, prefill }: { run: RunState; rules: Rule[]; groups: Group[]; snapshotName?: string; prefill: Map<string, string> }) {
  const [groupFilter, setGroupFilter] = useState<Set<string>>(new Set());
  const [onlyFallback, setOnlyFallback] = useState(false);
  const [onlyAdjusted, setOnlyAdjusted] = useState(false);
  const [hideSkipped, setHideSkipped] = useState(true);
  const [expected, setExpected] = useState<Map<number, string>>(new Map());
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [bulkGroup, setBulkGroup] = useState('');
  const [domainAsSuffix, setDomainAsSuffix] = useState(false);
  const toast = useToast();

  // a new run (or a history entry) starts with a clean plan
  // a new run (or a history entry) brings a new target list; finishing a run keeps the same list
  useEffect(() => {
    setExpected(new Map());
    setPicked(new Set());
    setGroupFilter(new Set());
  }, [run.targets]);

  const results = run.results;
  const finished = results.filter(Boolean) as ProbeResult[];
  const routed = finished.filter((r) => r.status === 'ok' || r.status === 'dial-error');

  // targets that came from the basket with an expected group fill the plan as their results arrive
  const prefilled = useRef(new Set<number>());
  useEffect(() => {
    prefilled.current = new Set();
  }, [run.targets]);
  useEffect(() => {
    if (!prefill.size) return;
    const add: [number, string][] = [];
    results.forEach((r, i) => {
      if (!r || prefilled.current.has(i) || (r.status !== 'ok' && r.status !== 'dial-error')) return;
      const want = prefill.get(keyOf(run.targets[i]));
      prefilled.current.add(i);
      if (want && want !== r.group) add.push([i, want]);
    });
    if (add.length) setExpected((m) => new Map([...m, ...add]));
  }, [results, prefill, run.targets]);

  const byGroup = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of routed) m.set(r.group ?? '?', (m.get(r.group ?? '?') ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [routed]);

  const hits = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of routed) if (r.rule && r.rule.index >= 0) m.set(r.rule.index, (m.get(r.rule.index) ?? 0) + 1);
    return m;
  }, [routed]);
  const udpIndex = rules.find((r) => r.type === 'Network' && r.payload.toLowerCase() === 'udp')?.index;

  // every group a rule can send traffic to: groups referenced by rules first, then the rest
  const groupOptions = useMemo(() => {
    const used = [...new Set(rules.map((r) => r.target))];
    const rest = groups.map((g) => g.name).filter((n) => !used.includes(n));
    return { used: [...new Set([...used, 'DIRECT', 'REJECT'])], rest };
  }, [rules, groups]);

  const isAdjusted = (i: number) => {
    const to = expected.get(i);
    return !!to && to !== results[i]?.group;
  };
  const adjustedCount = [...expected.keys()].filter(isAdjusted).length;
  const fallbackCount = routed.filter((r) => isFallbackResult(r)).length;

  const rows = results
    .map((r, i) => ({ r, t: run.targets[i], i }))
    .filter(({ r }) => !groupFilter.size || (r?.group && groupFilter.has(r.group)))
    .filter(({ r }) => !onlyFallback || isFallbackResult(r))
    .filter(({ i }) => !onlyAdjusted || isAdjusted(i))
    .filter(({ r }) => !hideSkipped || r?.status !== 'skipped');
  const skipped = finished.filter((r) => r.status === 'skipped').length;
  const failed = finished.filter((r) => r.status === 'timeout' || r.status === 'error').length;
  const selectable = rows.filter(({ r }) => r && (r.status === 'ok' || r.status === 'dial-error')).map(({ i }) => i);
  const allPicked = selectable.length > 0 && selectable.every((i) => picked.has(i));

  const setOne = (i: number, g: string) =>
    setExpected((m) => {
      const next = new Map(m);
      if (g) next.set(i, g);
      else next.delete(i);
      return next;
    });

  const toggleGroup = (g: string) =>
    setGroupFilter((s) => {
      const next = new Set(s);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  const applyBulk = () => {
    if (!bulkGroup || !picked.size) return;
    setExpected((m) => {
      const next = new Map(m);
      for (const i of picked) next.set(i, bulkGroup);
      return next;
    });
    toast(`已把 ${picked.size} 条的期望策略组设为「${bulkGroup}」`);
    setPicked(new Set());
  };

  // each fallback target takes its own suggested group; single IPs inside a suggested CIDR take the CIDR's
  const suggested = run.summary?.suggested;
  const adoptSuggestion = () => {
    if (!suggested) return;
    const own = new Map(suggested.filter((s) => s.group).map((s) => [keyOf(s), s.group]));
    const nets = suggested.filter((s) => s.group && s.kind === 'cidr');
    let n = 0;
    setExpected((m) => {
      const next = new Map(m);
      results.forEach((r, i) => {
        if (!r || !isFallbackResult(r)) return;
        const g = own.get(keyOf(r.target)) ?? (r.target.kind === 'ip' ? nets.find((c) => inCidr(r.target.value, c.value))?.group : undefined);
        if (!g) return;
        next.set(i, g);
        n++;
      });
      return next;
    });
    setOnlyAdjusted(true);
    const left = fallbackCount - n;
    toast(`已按建议填好 ${n} 条${left > 0 ? `，${left} 条没把握，留给你选` : ''}，可以在下面逐条修改`);
  };

  const adjustments: Adjustment[] = useMemo(
    () =>
      [...expected]
        .filter(([i]) => isAdjusted(i))
        .map(([i, to]) => ({ target: run.targets[i], from: results[i]?.group ?? '?', to, hitIndex: results[i]?.rule?.index ?? -1 })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expected, results, run.targets],
  );
  const plan = useMemo(() => buildRules(adjustments, domainAsSuffix), [adjustments, domainAsSuffix]);
  const before = adjustments.filter((a) => a.hitIndex >= 0).reduce((m, a) => Math.min(m, a.hitIndex), Infinity);
  const beforeRule = Number.isFinite(before) ? rules.find((r) => r.index === before) : undefined;
  const yaml = plan.lines.map(yamlItem).join('\n');

  const groupSelect = (value: string, onChange: (v: string) => void, placeholder: string, className = '') => (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`h-8 min-w-0 rounded-control bg-page px-2 text-[12.5px] shadow-card outline-none focus:shadow-[0_0_0_1.5px_var(--accent)] ${className}`}>
      <option value="">{placeholder}</option>
      <optgroup label="规则里用到的策略组">
        {groupOptions.used.map((g) => (
          <option key={g} value={g}>
            {g}
          </option>
        ))}
      </optgroup>
      {groupOptions.rest.length > 0 && (
        <optgroup label="其他策略组">
          {groupOptions.rest.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );

  // md–2xl: check | target | rule over route | expected.  2xl: rule, route and service get their own columns
  const ROW =
    'md:grid md:items-center md:gap-x-4 md:grid-cols-[18px_minmax(160px,1.2fr)_minmax(200px,1.5fr)_150px] 2xl:grid-cols-[18px_minmax(170px,1.3fr)_minmax(150px,1fr)_minmax(180px,1.3fr)_minmax(130px,0.9fr)_150px]';

  return (
    <section className="space-y-4">
      <SectionHead
        className="rise"
        style={rise(0)}
        index="03"
        title={`结果 · ${run.query}`}
        desc={
          <span>
            {run.done ? '完成' : `进行中 ${finished.length}/${results.length}`} · 按 <span className="font-mono">{run.configPath?.split('/').pop() ?? snapshotName ?? '当前配置'}</span>
          </span>
        }
      />

      <Card className="rise space-y-5 p-5" style={rise(1)}>
        <div className="h-1 overflow-hidden rounded-full bg-field" role="progressbar" aria-valuenow={finished.length} aria-valuemax={results.length}>
          <div className={`h-full rounded-full transition-[width] duration-500 ease-(--ease-out) ${run.done ? 'bg-ink-3/40' : 'bg-accent'}`} style={{ width: `${(finished.length / Math.max(1, results.length)) * 100}%` }}>
            {!run.done && <div className="shimmer h-full w-full" />}
          </div>
        </div>

        <div>
          <p className="font-display text-[26px] leading-tight font-semibold tracking-[-0.01em]">
            {routed.length} 个目标 →{' '}
            {byGroup.slice(0, 4).map(([g, n], i) => (
              <span key={g}>
                {i > 0 && <span className="text-ink-3">、</span>}
                <span style={{ color: groupColor(g) }}>{g}</span> <span className="num">{n}</span>
              </span>
            ))}
            {byGroup.length > 4 && <span className="text-ink-3"> 等 {byGroup.length} 组</span>}
          </p>
          <div className="mt-3 flex h-2.5 gap-[2px] overflow-hidden rounded-full">
            {byGroup.map(([g, n]) => (
              <button
                key={g}
                title={`${g} ${n}（点击筛选）`}
                onClick={() => toggleGroup(g)}
                className="transition-opacity duration-200"
                style={{ flexGrow: n, background: groupColor(g), opacity: groupFilter.size && !groupFilter.has(g) ? 0.25 : 1 }}
              />
            ))}
          </div>
        </div>

        {rules.length > 0 && hits.size > 0 && (
          <div>
            <p className="eyebrow mb-1">Where it stopped · 规则从左往右匹配，第一条命中即停</p>
            <RuleTrack rules={rules} hits={hits} udpIndex={udpIndex} />
          </div>
        )}

        {run.summary && run.summary.warnings.length > 0 && (
          <ul className="space-y-1.5 rounded-control bg-signal-bg px-3.5 py-2.5 text-[13px]">
            {run.summary.warnings.map((w) => (
              <li key={w} className="flex gap-2">
                <span className="text-signal">▲</span>
                {w}
              </li>
            ))}
          </ul>
        )}

        {run.summary && (run.summary.suggestions.length > 0 || (suggested?.length ?? 0) > 0) && (
          <div>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <p className="eyebrow">
                {suggested ? 'Suggested rules · 每个兜底目标单独判断：你的预期 → 同服务的其他目标 → 目标在国内；判断不了的不猜' : 'Suggested rules · 旧记录，按多数策略组生成，可能不准'}
              </p>
              <span className="flex items-center gap-1">
                {suggested && suggested.some((s) => s.group) && (
                  <button className="tap inline-flex items-center gap-1 rounded-chip px-2 py-1 text-[12px] text-accent-ink hover:bg-accent-soft" onClick={adoptSuggestion}>
                    <Wand2 className="h-3.5 w-3.5" /> 填入调整方案
                  </button>
                )}
                <button
                  className="tap inline-flex items-center gap-1 rounded-chip px-2 py-1 text-[12px] text-accent-ink hover:bg-accent-soft"
                  onClick={() => {
                    void navigator.clipboard?.writeText(run.summary!.suggestions.map(yamlItem).join('\n'));
                    toast('已复制建议规则');
                  }}
                >
                  <Copy className="h-3.5 w-3.5" /> 复制
                </button>
              </span>
            </div>
            {suggested ? (
              <ul className="max-h-56 space-y-1.5 overflow-auto rounded-control bg-field px-3.5 py-2.5 text-[12px] shadow-plate scroll-thin">
                {suggested.map((s) => (
                  <li key={`${s.kind}|${s.value}`} className="min-w-0">
                    <span className={`block truncate font-mono ${s.line ? '' : 'text-ink-3'}`}>{s.line ? `- ${s.line}` : `? ${s.value}`}</span>
                    <span className={`block pl-3 text-[11.5px] ${s.basis === 'none' ? 'text-signal' : 'text-ink-3'}`}>{s.why}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <pre className="max-h-40 overflow-auto rounded-control bg-field px-3.5 py-2.5 font-mono text-[12px] shadow-plate scroll-thin">
                {run.summary.suggestions.map((s) => `- ${s}`).join('\n')}
              </pre>
            )}
          </div>
        )}
      </Card>

      {/* adjustment plan */}
      {adjustments.length > 0 && (
        <Card className="dialog-in space-y-3 p-5 shadow-[0_0_0_1.5px_var(--accent),0_6px_20px_-8px_rgb(0_0_0/0.18)]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-baseline gap-x-2.5">
              <h3 className="font-display text-[16px] font-semibold">调整方案</h3>
              <span className="text-[12.5px] text-ink-2">
                {adjustments.length} 个目标改道 → 生成 {plan.lines.length} 条规则{plan.skipped ? `（${plan.skipped} 条被同组的后缀 / 网段覆盖，已省略）` : ''}
              </span>
            </div>
            <span className="flex flex-wrap items-center gap-1.5">
              <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
                <input type="checkbox" checked={domainAsSuffix} onChange={(e) => setDomainAsSuffix(e.target.checked)} className="accent-[var(--accent)]" />
                完整域名写成 DOMAIN-SUFFIX
              </label>
              <Button kind="quiet" onClick={() => setExpected(new Map())} className="h-8 px-2.5">
                清空
              </Button>
              <Button
                kind="ghost"
                className="h-8 px-3"
                title="记下这些目标应该走的策略组；之后真实连接没走对，会出现在「异常案例」里"
                onClick={async () => {
                  const items = adjustments
                    .filter((a) => ['domain', 'suffix', 'keyword', 'ip', 'cidr'].includes(a.target.kind))
                    .map((a) => ({ kind: a.target.kind === 'domain' && domainAsSuffix ? 'suffix' : a.target.kind, value: a.target.value, grp: a.to, source: `分流测试 · ${run.query}` }));
                  const { added } = await sendJson<{ added: number }>('/api/expectations', 'POST', { items });
                  toast(`已保存 ${added} 条预期，违反时会记进「异常案例」`);
                }}
              >
                <Target className="h-3.5 w-3.5" /> 保存为预期
              </Button>
              <Button
                kind="ghost"
                className="h-8 px-3"
                title="攒到「异常案例 → 规则草稿」，等维护时和别的改动一起生成 yaml；同时记为预期"
                onClick={async () => {
                  const items = adjustments
                    .filter((a) => ['domain', 'suffix', 'keyword', 'ip', 'cidr', 'asn'].includes(a.target.kind))
                    .map((a) => {
                      const hit = rules.find((r) => r.index === a.hitIndex);
                      return {
                        kind: a.target.kind === 'domain' && domainAsSuffix ? 'suffix' : a.target.kind,
                        value: a.target.value,
                        grp: a.to,
                        from: a.from,
                        hitType: hit?.type ?? '',
                        hitPayload: hit?.payload ?? '',
                        source: `分流测试 · ${run.query}`,
                      };
                    });
                  try {
                    const r = await sendJson<{ added: number; updated: number }>('/api/drafts', 'POST', { items });
                    draftsChanged();
                    toast(`规则草稿：新增 ${r.added} 条${r.updated ? `，更新 ${r.updated} 条` : ''}`, undefined, {
                      label: '去看看',
                      run: () => navigate('cases', undefined, { view: 'drafts' }),
                    });
                  } catch (e) {
                    toast(`没有加入：${(e as Error).message}`, 'error');
                  }
                }}
              >
                <FilePlus2 className="h-3.5 w-3.5" /> 加入规则草稿
              </Button>
              <Button
                kind="primary"
                className="h-8 px-3"
                onClick={() => {
                  void navigator.clipboard?.writeText(yaml);
                  toast(`已复制 ${plan.lines.length} 条规则`);
                }}
              >
                <Copy className="h-3.5 w-3.5" /> 复制 yaml
              </Button>
            </span>
          </div>

          <ul className="flex flex-wrap gap-1.5 text-[12px]">
            {adjustments.slice(0, 40).map((a) => (
              <li key={a.target.value + a.target.kind} className="inline-flex items-center gap-1.5 rounded-chip bg-field px-2 py-1">
                <span className="max-w-[220px] truncate font-mono">{a.target.value}</span>
                <span className="text-ink-3">{a.from}</span>
                <ArrowRight className="h-3 w-3 text-ink-3" />
                <span className="font-medium" style={{ color: groupColor(a.to) }}>
                  {a.to}
                </span>
              </li>
            ))}
            {adjustments.length > 40 && <li className="px-2 py-1 text-ink-3">等 {adjustments.length} 个</li>}
          </ul>

          <pre className="max-h-64 overflow-auto rounded-control bg-field px-3.5 py-3 font-mono text-[12.5px] leading-relaxed shadow-plate scroll-thin">
            <span className="text-ink-3">rules:{'\n'}</span>
            {yaml}
          </pre>

          <p className="text-[12.5px] leading-relaxed text-ink-2">
            {beforeRule ? (
              <>
                要生效，这些规则必须排在 <span className="font-mono text-ink">#{beforeRule.index} {beforeRule.type}({beforeRule.payload})</span> 之前（这批目标现在最早停在那一条）。
              </>
            ) : (
              '要生效，这些规则必须排在它们现在命中的那条规则之前。'
            )}
            临时调整最省事的位置是 OpenClash 的自定义规则（<span className="font-mono">/etc/openclash/custom/openclash_custom_rules.list</span>），它们会插在所有 yaml 规则最前面。应用需要重载 OpenClash，会断网几秒到一两分钟；网站只生成文本，不会改配置。
          </p>
        </Card>
      )}

      <Card className="rise overflow-hidden" style={rise(2)}>
        {/* filters */}
        <div className="space-y-2.5 border-b border-dashed border-line-strong px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="eyebrow">Per target · 逐条结果</p>
            <span className="flex flex-wrap items-center gap-3 text-[12px] text-ink-2">
              <button
                className="tap inline-flex items-center gap-1 rounded-chip px-2 py-1 hover:bg-hover hover:text-ink"
                onClick={() =>
                  downloadCsv(
                    `分流测试-${run.query}`,
                    ['目标', '类型', '实际测试', '来源', '状态', '命中规则序号', '规则类型', '规则内容', '策略组', '线路', 'UDP 走向', '服务', '期望策略组'],
                    results.map((r, i) => {
                      const t = run.targets[i];
                      return [t.value, t.kind, t.test, t.from.join(' '), r?.status ?? '', r?.rule?.index ?? '', r?.rule?.type ?? '', r?.rule?.payload ?? '', r?.group ?? '', (r?.chain ?? []).join(' > '), r?.udp?.group ?? '', r?.service?.name ?? '', expected.get(i) ?? ''];
                    }),
                  )
                }
              >
                <Download className="h-3.5 w-3.5" /> CSV
              </button>
              {skipped > 0 && (
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={hideSkipped} onChange={(e) => setHideSkipped(e.target.checked)} className="accent-[var(--accent)]" /> 隐藏无法测试的 {skipped} 条
                </label>
              )}
              {failed > 0 && <span className="text-stop">{failed} 条探测失败</span>}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="按策略组筛选">
            <button
              onClick={() => {
                setGroupFilter(new Set());
                setOnlyFallback(false);
                setOnlyAdjusted(false);
              }}
              className={`tap rounded-chip px-2.5 py-1 text-[12.5px] ${!groupFilter.size && !onlyFallback && !onlyAdjusted ? 'bg-ink text-page' : 'bg-field text-ink-2 hover:text-ink'}`}
            >
              全部 <span className="num font-mono text-[11px] opacity-70">{routed.length}</span>
            </button>
            {byGroup.map(([g, n]) => {
              const on = groupFilter.has(g);
              return (
                <button
                  key={g}
                  onClick={() => toggleGroup(g)}
                  aria-pressed={on}
                  className="tap inline-flex items-center gap-1.5 rounded-chip px-2 py-1 text-[12.5px]"
                  style={{
                    background: on ? `color-mix(in srgb, ${groupColor(g)} 16%, transparent)` : 'var(--field)',
                    boxShadow: on ? `0 0 0 1.5px ${groupColor(g)}` : undefined,
                  }}
                >
                  <span className="h-2.5 w-[3px] rounded-full" style={{ background: groupColor(g) }} />
                  {g}
                  <span className="num font-mono text-[11px] text-ink-3">{n}</span>
                </button>
              );
            })}
            <span className="mx-1 h-4 w-px bg-line-strong" aria-hidden />
            {fallbackCount > 0 && (
              <button onClick={() => setOnlyFallback(!onlyFallback)} aria-pressed={onlyFallback} className={`tap rounded-chip px-2.5 py-1 text-[12.5px] ${onlyFallback ? 'bg-signal-bg text-signal shadow-[0_0_0_1.5px_var(--signal)]' : 'bg-field text-ink-2 hover:text-ink'}`}>
                只看兜底 <span className="num font-mono text-[11px]">{fallbackCount}</span>
              </button>
            )}
            <button
              onClick={() => setOnlyAdjusted(!onlyAdjusted)}
              aria-pressed={onlyAdjusted}
              disabled={!adjustedCount}
              className={`tap rounded-chip px-2.5 py-1 text-[12.5px] disabled:opacity-40 ${onlyAdjusted ? 'bg-accent-soft text-accent-ink shadow-[0_0_0_1.5px_var(--accent)]' : 'bg-field text-ink-2 hover:text-ink'}`}
            >
              待调整 <span className="num font-mono text-[11px]">{adjustedCount}</span>
            </button>
          </div>
          {/* bulk */}
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="accent-[var(--accent)]"
                checked={allPicked}
                onChange={(e) => setPicked(e.target.checked ? new Set(selectable) : new Set())}
              />
              选中当前筛选的 {selectable.length} 条
            </label>
            <span className="text-ink-3">·</span>
            <span>已选 {picked.size} 条，期望策略组设为</span>
            {groupSelect(bulkGroup, setBulkGroup, '选择策略组', 'w-40')}
            <Button kind="ghost" className="h-8 px-3" disabled={!picked.size || !bulkGroup} onClick={applyBulk}>
              应用
            </Button>
          </div>
        </div>

        <div className={`eyebrow hidden border-b border-line px-4 py-2 ${ROW}`}>
          <span />
          <span>目标</span>
          <span className="2xl:hidden">命中规则 · 线路</span>
          <span className="hidden 2xl:block">命中规则</span>
          <span className="hidden 2xl:block">线路</span>
          <span className="hidden 2xl:block">服务 · 解析</span>
          <span>期望策略组</span>
        </div>
        <ul className="divide-y divide-line">
          {rows.slice(0, 1000).map(({ r, t, i }) => {
            const routedRow = r && (r.status === 'ok' || r.status === 'dial-error');
            const changed = isAdjusted(i);
            return (
              <li key={i} className={`px-4 py-2.5 ${ROW} ${isFallbackResult(r) ? 'fallback-row' : ''} ${changed ? 'bg-accent-soft' : ''}`}>
                <span className="hidden md:block">
                  {routedRow && (
                    <input
                      type="checkbox"
                      aria-label={`选中 ${t.value}`}
                      className="accent-[var(--accent)]"
                      checked={picked.has(i)}
                      onChange={(e) =>
                        setPicked((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(i);
                          else next.delete(i);
                          return next;
                        })
                      }
                    />
                  )}
                </span>
                <span className="block min-w-0">
                  <span className="block truncate font-mono text-[13px]" title={t.value}>
                    {t.value}
                  </span>
                  <span className="block truncate text-[11.5px] text-ink-3">
                    {TARGET_KIND_LABEL[t.kind]}
                    {t.test && t.test !== t.value ? ` · 测 ${t.test}` : ''}
                    {t.note ? ` · ${t.note}` : t.from.length ? ` · ${t.from.map(sourceLabel).join('、')}` : ''}
                  </span>
                </span>
                {!r ? (
                  <span className="mt-1 flex items-center gap-2 text-[12.5px] text-ink-3 md:col-span-2 md:mt-0 2xl:col-span-4">
                    <span className="shimmer h-1.5 w-24 rounded-full bg-field" /> 等待内核判定…
                  </span>
                ) : r.status === 'skipped' ? (
                  <span className="mt-1 text-[12.5px] text-ink-2 md:col-span-2 md:mt-0 2xl:col-span-4">未测试：{r.error}</span>
                ) : r.status === 'timeout' || r.status === 'error' ? (
                  <span className="mt-1 text-[12.5px] text-stop md:col-span-2 md:mt-0 2xl:col-span-4">探测失败：{r.error}</span>
                ) : (
                  <>
                    <span className="mt-1 flex min-w-0 flex-col gap-1 md:mt-0 2xl:contents">
                    <span className="block min-w-0">
                      <RuleBadge type={r.rule?.type} payload={r.rule?.payload} index={r.rule?.index} />
                      {r.udp && (
                        <span className="mt-0.5 flex items-center gap-1 text-[11.5px] text-signal" title={`UDP/QUIC 走 #${r.udp.index} ${r.udp.type}(${r.udp.payload})`}>
                          UDP → {r.udp.group}
                        </span>
                      )}
                    </span>
                    <span className="block min-w-0">
                      <RouteStrip chain={r.chain ?? []} nodeProvider={r.nodeProvider} />
                      {r.status === 'dial-error' && (
                        <span className="mt-0.5 block truncate text-[11.5px] text-ink-3" title={r.error}>
                          线路已判定，连接失败：{r.error}
                        </span>
                      )}
                    </span>
                    <span className="block min-w-0 text-[12px] text-ink-2 2xl:text-[12.5px] 2xl:text-ink">
                      <span className="block truncate">
                        <ServiceName service={r.service} />
                        {r.resolved && r.resolved[0] && (
                          <span className="text-ink-2 2xl:hidden">
                            {' · '}
                            <ProviderLine p={r.resolved[0]} />
                          </span>
                        )}
                      </span>
                      {r.resolved && r.resolved[0] && (
                        <span className="hidden truncate text-ink-2 2xl:block">
                          <ProviderLine p={r.resolved[0]} />
                        </span>
                      )}
                    </span>
                    </span>
                    <span className="mt-1.5 flex min-w-0 items-center gap-1.5 md:mt-0">
                      {groupSelect(expected.get(i) ?? '', (v) => setOne(i, v === r.group ? '' : v), '符合预期', `w-full ${changed ? 'shadow-[0_0_0_1.5px_var(--accent)]' : ''}`)}
                    </span>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {rows.length > 1000 && <p className="px-4 py-2 text-[12px] text-ink-2">只显示前 1000 条。</p>}
        {rows.length === 0 && <p className="px-4 py-8 text-center text-[13px] text-ink-2">当前筛选下没有目标。点「全部」清除筛选。</p>}
      </Card>
      <p className="text-[12px] text-ink-3">线路以内核实时判定为准；「解析」一栏是参考地址，只用来标注供应商。</p>
    </section>
  );
}
