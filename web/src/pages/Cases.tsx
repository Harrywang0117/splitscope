import { Check, CheckCheck, ChevronDown, Copy, Download, EyeOff, FilePlus2, FlaskConical, Plus, RotateCcw, Search, Target, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { draftsChanged, getJson, sendJson, useData, type LiveData } from '../api.ts';
import { Button, Card, GroupChip, RuleBadge, rise, SectionHead, Segmented, useToast } from '../components/bits.tsx';
import { Country, Favicon, RowMenu, siteOf } from '../components/data.tsx';
import { navigate } from '../App.tsx';
import { basket, targetOf } from '../lib/basket.ts';
import { planBlocks, ruleFor, yamlItem } from '../lib/rules.ts';
import { fmtAgo, fmtBytes, fmtDateTime } from '../lib/format.ts';

type Status = 'open' | 'fixed' | 'ignored' | 'all';
type Reason = 'expect' | 'cn_proxy' | 'intl_direct' | 'fallback' | 'udp_fallback';

interface CaseRow {
  key: string;
  reason: Reason;
  host: string;
  service: string;
  grp: string;
  rule: string;
  rule_payload: string;
  rule_index: number;
  node: string;
  chain: string;
  expected: string;
  scope: string;
  country: string;
  target_ip: string;
  org: string;
  network: string;
  first_seen: number;
  last_seen: number;
  count: number;
  devices: string;
  status: 'open' | 'fixed' | 'ignored';
  regressed: number;
  note: string;
  /** the drafted rule that would catch this host, if any */
  draft: { status: 'pending' | 'applied'; kind: string; value: string; grp: string } | null;
}

interface Expectation {
  id: number;
  kind: string;
  value: string;
  grp: string;
  note: string;
  source: string;
  created_at: number;
}

const REASONS: { id: Reason; label: string }[] = [
  { id: 'expect', label: '违反预期' },
  { id: 'cn_proxy', label: '国内走代理' },
  { id: 'intl_direct', label: '境外走直连' },
  { id: 'fallback', label: '落到兜底' },
  { id: 'udp_fallback', label: 'UDP 兜底' },
];
const REASON_LABEL = Object.fromEntries(REASONS.map((r) => [r.id, r.label])) as Record<Reason, string>;
const STATUS_LABEL = { open: '待处理', fixed: '已修复', ignored: '已忽略' } as const;
const KIND_LABEL: Record<string, string> = { domain: '域名', suffix: '后缀', keyword: '关键词', ip: 'IP', cidr: '网段' };
const SPECIAL: Record<string, string> = { '@direct': '任意直连', '@proxy': '任意代理' };

interface SnapRule {
  index: number;
  type: string;
  payload: string;
  target: string;
}

function useSnapshotInfo() {
  const { data } = useData<{ snapshot: { groups: { name: string }[]; running: { rules: SnapRule[] } } | null }>('/api/snapshot', 0);
  return useMemo(() => {
    const rules = data?.snapshot?.running.rules ?? [];
    const used = [...new Set(rules.map((r) => r.target))];
    const rest = (data?.snapshot?.groups ?? []).map((g) => g.name).filter((n) => !used.includes(n));
    return { groups: [...new Set([...used, 'DIRECT', 'REJECT', ...rest])], ruleAt: new Map(rules.map((r) => [r.index, r])) };
  }, [data]);
}

const useGroups = () => useSnapshotInfo().groups;

function GroupSelect({ value, onChange, groups, placeholder = '选择策略组', className = '' }: { value: string; onChange: (v: string) => void; groups: string[]; placeholder?: string; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`h-8 rounded-control bg-page px-2 text-[12.5px] shadow-card outline-none focus:shadow-[0_0_0_1.5px_var(--accent)] ${className}`}>
      <option value="">{placeholder}</option>
      <optgroup label="按出口">
        <option value="@direct">任意直连（不管哪个组）</option>
        <option value="@proxy">任意代理（不管哪个组）</option>
      </optgroup>
      <optgroup label="策略组">
        {groups.map((g) => (
          <option key={g} value={g}>
            {g}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

const ExpectedChip = ({ grp }: { grp: string }) => (grp ? SPECIAL[grp] ? <span className="rounded-chip bg-field px-1.5 py-0.5 text-[12px]">{SPECIAL[grp]}</span> : <GroupChip name={grp} /> : <span className="text-[12px] text-ink-3">未指定</span>);

type View = 'cases' | 'drafts' | 'expect';

const viewFromHash = (): View => {
  const v = new URLSearchParams(location.hash.split('?')[1] ?? '').get('view');
  return v === 'drafts' || v === 'expect' ? v : 'cases';
};

export function Cases({ live }: { live: LiveData }) {
  const [tab, setTabState] = useState<View>(viewFromHash);
  // the view lives in the URL, so the sidebar's draft badge and links can switch it
  const setTab = (v: View) => {
    setTabState(v);
    history.replaceState(null, '', `#/cases${v === 'cases' ? '' : `?view=${v}`}`);
  };
  useEffect(() => {
    const on = () => setTabState(viewFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const exp = useData<Expectation[]>('/api/expectations', 0);
  const drafts = useData<DraftRow[]>('/api/drafts', 30_000);
  return (
    <div className="space-y-5">
      <SectionHead
        className="rise"
        style={rise(0)}
        title="异常案例"
        desc="走了和预期不符的策略组的连接，按「原因 + 域名 + 策略组」合并；改规则时拿来当参考，修好后标记，复发会自动重新打开"
        aside={
          <Segmented
            label="视图"
            value={tab}
            onChange={setTab}
            options={[
              ['cases', '案例'],
              ['drafts', `规则草稿 ${drafts.data?.length ?? 0}`],
              ['expect', `我的预期 ${exp.data?.length ?? 0}`],
            ]}
          />
        }
      />
      {tab === 'cases' ? (
        <CaseList
          live={live}
          onExpectChanged={exp.reload}
          onDrafted={() => {
            drafts.reload();
            exp.reload();
            draftsChanged();
          }}
          openDrafts={() => setTab('drafts')}
        />
      ) : tab === 'drafts' ? (
        <DraftList
          items={drafts.data ?? []}
          reload={() => {
            drafts.reload();
            exp.reload();
            draftsChanged();
          }}
        />
      ) : (
        <ExpectList items={exp.data ?? []} reload={exp.reload} />
      )}
    </div>
  );
}

function CaseList({ live, onExpectChanged, onDrafted, openDrafts }: { live: LiveData; onExpectChanged: () => void; onDrafted: () => void; openDrafts: () => void }) {
  const [status, setStatus] = useState<Status>('open');
  const [reason, setReason] = useState<Reason | ''>('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'last' | 'count' | 'first'>('last');
  const [page, setPage] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [expectGroup, setExpectGroup] = useState('');
  const [bySuffix, setBySuffix] = useState(true);
  const groups = useGroups();
  const toast = useToast();
  const PAGE = 50;
  useEffect(() => {
    setPage(0);
    setPicked(new Set());
  }, [status, reason, q, sort]);
  const qs = new URLSearchParams({ status, sort, limit: String(PAGE), offset: String(page * PAGE), ...(reason ? { reason } : {}), ...(q ? { q } : {}) });
  const { data, reload, loading } = useData<{ total: number; rows: CaseRow[]; counts: Record<string, number> }>(`/api/cases?${qs}`, 30_000);
  const rows = data?.rows ?? [];
  const count = (st: Status, r?: Reason) =>
    Object.entries(data?.counts ?? {})
      .filter(([k]) => (st === 'all' || k.startsWith(`${st}|`)) && (!r || k.endsWith(`|${r}`)))
      .reduce((n, [, v]) => n + v, 0);
  const selected = rows.filter((r) => picked.has(r.key));
  const deviceName = (ip: string) => live.devices.get(ip)?.label ?? ip;

  const patch = async (keys: string[], body: { status?: string; note?: string }, msg: string) => {
    await sendJson('/api/cases', 'PATCH', { keys, ...body });
    toast(msg);
    setPicked(new Set());
    reload();
  };
  const saveExpect = async (list: CaseRow[], grp: string) => {
    if (!grp) return toast('先选一个期望策略组', 'error');
    const items = list.map((r) => {
      const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(r.host);
      const site = siteOf(r.host);
      return { kind: isIp ? 'ip' : bySuffix && site ? 'suffix' : 'domain', value: isIp ? r.host : bySuffix && site ? site : r.host, grp, source: '异常案例' };
    });
    const { added } = await sendJson<{ added: number }>('/api/expectations', 'POST', { items });
    toast(`已保存 ${added} 条预期，之后违反的连接会记成「违反预期」`);
    onExpectChanged();
  };
  const toDrafts = async (list: CaseRow[]) => {
    // the group picked in the bar wins; otherwise each case's own expected group
    const usable = list.filter((r) => expectGroup || (r.expected && !r.expected.startsWith('@')));
    if (!usable.length) return toast('先在右边选一个期望策略组（「任意直连 / 代理」写不成规则）', 'error');
    if (expectGroup.startsWith('@')) return toast('规则要写具体的策略组，「任意直连 / 代理」只能当预期', 'error');
    const items = usable.map((r) => {
      const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(r.host);
      const site = siteOf(r.host);
      const suffix = !isIp && bySuffix && site;
      return {
        kind: isIp ? 'ip' : suffix ? 'suffix' : 'domain',
        value: isIp ? r.host : suffix ? site : r.host,
        grp: expectGroup || r.expected,
        from: r.grp,
        hitType: r.rule,
        hitPayload: r.rule_payload,
        source: `异常案例 · ${REASON_LABEL[r.reason]}`,
      };
    });
    try {
      const res = await sendJson<{ added: number; updated: number }>('/api/drafts', 'POST', { items });
      toast(`规则草稿：新增 ${res.added} 条${res.updated ? `，更新 ${res.updated} 条` : ''}${usable.length < list.length ? `；${list.length - usable.length} 条没有期望组，跳过了` : ''}`, undefined, {
        label: '去看看',
        run: openDrafts,
      });
      setPicked(new Set());
      reload();
      onDrafted();
    } catch (e) {
      toast(`没有加入：${(e as Error).message}`, 'error');
    }
  };

  const exportUrl = (format: string) => `/api/cases/export?${new URLSearchParams({ format, status, ...(reason ? { reason } : {}), ...(q ? { q } : {}) })}`;

  return (
    <>
      <div className="rise flex flex-wrap items-center gap-2" style={rise(1)}>
        <Segmented
          label="状态"
          value={status}
          onChange={setStatus}
          options={[
            ['open', `待处理 ${count('open')}`],
            ['fixed', `已修复 ${count('fixed')}`],
            ['ignored', `已忽略 ${count('ignored')}`],
            ['all', `全部 ${count('all')}`],
          ]}
        />
        <span className="flex flex-wrap gap-1.5">
          {REASONS.map((r) => {
            const n = count(status, r.id);
            const on = reason === r.id;
            return (
              <button key={r.id} onClick={() => setReason(on ? '' : r.id)} aria-pressed={on} className={`tap rounded-chip px-2.5 py-1 text-[12.5px] ${on ? 'bg-signal-bg text-signal shadow-[0_0_0_1.5px_var(--signal)]' : 'bg-field text-ink-2 hover:text-ink'}`}>
                {r.label} <span className="num font-mono text-[11px]">{n}</span>
              </button>
            );
          })}
        </span>
        <span className="hidden flex-1 lg:block" />
        <label className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索域名、服务、备注" className="h-8 w-48 rounded-control bg-page pr-2 pl-8 text-[13px] shadow-card outline-none focus:shadow-[0_0_0_1.5px_var(--accent)]" />
        </label>
        <Segmented
          label="排序"
          value={sort}
          onChange={setSort}
          options={[
            ['last', '最近'],
            ['count', '次数'],
            ['first', '首次'],
          ]}
        />
      </div>

      <Card className="rise overflow-hidden" style={rise(2)}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed border-line-strong px-4 py-2.5 text-[12.5px]">
          <label className="flex items-center gap-2 text-ink-2">
            <input type="checkbox" className="accent-[var(--accent)]" checked={rows.length > 0 && rows.every((r) => picked.has(r.key))} onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.key)) : new Set())} />
            全选本页 {rows.length} 条 · 已选 {selected.length}
          </label>
          {/* on a phone the actions only take room once something is picked */}
          <span className={`${selected.length ? 'flex' : 'hidden lg:flex'} flex-wrap items-center gap-1.5`}>
            <Button kind="ghost" className="h-8 px-2.5" disabled={!selected.length} onClick={() => void patch(selected.map((r) => r.key), { status: 'fixed' }, `已标记 ${selected.length} 条为已修复`)}>
              <Check className="h-3.5 w-3.5" /> 已修复
            </Button>
            <Button kind="ghost" className="h-8 px-2.5" disabled={!selected.length} onClick={() => void patch(selected.map((r) => r.key), { status: 'ignored' }, `已忽略 ${selected.length} 条`)}>
              <EyeOff className="h-3.5 w-3.5" /> 忽略
            </Button>
            <Button kind="ghost" className="h-8 px-2.5" disabled={!selected.length} onClick={() => void patch(selected.map((r) => r.key), { status: 'open' }, `已重新打开 ${selected.length} 条`)}>
              <RotateCcw className="h-3.5 w-3.5" /> 重新打开
            </Button>
            <span className="mx-1 h-4 w-px bg-line-strong" />
            <Button
              kind="ghost"
              className="h-8 px-2.5"
              disabled={!selected.length}
              onClick={() => {
                const n = basket.add(selected.map((r) => targetOf(r.host, '异常案例', r.expected || undefined, r.service || undefined)));
                toast(`已加入测试清单 ${n} 条`);
              }}
            >
              <Plus className="h-3.5 w-3.5" /> 测试清单
            </Button>
            <GroupSelect value={expectGroup} onChange={setExpectGroup} groups={groups} placeholder="期望策略组" className="w-36" />
            <label className="flex items-center gap-1 text-ink-2" title="把 www.a.com 保存成 a.com 的后缀预期">
              <input type="checkbox" className="accent-[var(--accent)]" checked={bySuffix} onChange={(e) => setBySuffix(e.target.checked)} /> 按站点后缀
            </label>
            <Button kind="ghost" className="h-8 px-3" disabled={!selected.length || !expectGroup} onClick={() => void saveExpect(selected, expectGroup)}>
              <Target className="h-3.5 w-3.5" /> 设为预期
            </Button>
            <Button kind="primary" className="h-8 px-3" disabled={!selected.length} title="攒到「规则草稿」，维护时一次生成 yaml；同时记为预期" onClick={() => void toDrafts(selected)}>
              <FilePlus2 className="h-3.5 w-3.5" /> 加入规则草稿
            </Button>
          </span>
          <span className="flex items-center gap-1.5">
            <a href={exportUrl('csv')} className="tap inline-flex items-center gap-1 rounded-chip px-2 py-1 text-ink-2 hover:bg-hover hover:text-ink">
              <Download className="h-3.5 w-3.5" /> CSV
            </a>
            <a href={exportUrl('json')} className="tap inline-flex items-center gap-1 rounded-chip px-2 py-1 text-ink-2 hover:bg-hover hover:text-ink">
              <Download className="h-3.5 w-3.5" /> JSON
            </a>
          </span>
        </div>
        <div className="eyebrow hidden border-b border-line px-4 py-2 lg:grid lg:grid-cols-[18px_minmax(200px,1.5fr)_minmax(190px,1.3fr)_minmax(110px,0.7fr)_minmax(120px,0.8fr)_96px_28px] lg:gap-4">
          <span />
          <span>域名 / IP · 原因</span>
          <span>实际：规则 · 策略组</span>
          <span>期望</span>
          <span>设备</span>
          <span className="text-right">次数 · 最近</span>
          <span />
        </div>
        {rows.length === 0 ? (
          <p className="px-4 py-12 text-center text-[13px] text-ink-3">{loading ? '读取中…' : status === 'open' ? '没有待处理的异常。新出现的会自动记在这里。' : '没有符合条件的案例。'}</p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r, i) => {
              const devs = JSON.parse(r.devices) as string[];
              const expanded = open === r.key;
              return (
                <li key={r.key} className={`rise ${r.status !== 'open' ? 'opacity-70' : ''}`} style={rise(Math.min(i, 20))}>
                  <div className="dense-row grid grid-cols-[18px_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 py-2.5 lg:grid-cols-[18px_minmax(200px,1.5fr)_minmax(190px,1.3fr)_minmax(110px,0.7fr)_minmax(120px,0.8fr)_96px_28px] lg:items-center lg:gap-4">
                    <input
                      type="checkbox"
                      aria-label={`选中 ${r.host}`}
                      className="mt-1.5 self-start accent-[var(--accent)] lg:mt-0 lg:self-center"
                      checked={picked.has(r.key)}
                      onChange={(e) =>
                        setPicked((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(r.key);
                          else next.delete(r.key);
                          return next;
                        })
                      }
                    />
                    <button className="flex min-w-0 items-center gap-2 text-left" onClick={() => setOpen(expanded ? null : r.key)}>
                      <Favicon host={r.host} />
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-[13px]">{r.host}</span>
                        <span className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3">
                          <span className="rounded-chip bg-signal-bg px-1.5 font-pixel text-[10px] text-signal">{REASON_LABEL[r.reason]}</span>
                          {r.regressed ? <span className="rounded-chip bg-stop/15 px-1.5 font-pixel text-[10px] text-stop">复发</span> : null}
                          {r.draft && (
                            <span
                              role="link"
                              tabIndex={0}
                              title={`${r.draft.status === 'pending' ? '规则草稿里已有' : '已并入的规则'}：${r.draft.value} → ${r.draft.grp}（点击查看草稿）`}
                              onClick={(e) => {
                                e.stopPropagation();
                                openDrafts();
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') openDrafts();
                              }}
                              className={`rounded-chip px-1.5 font-pixel text-[10px] ${r.draft.status === 'pending' ? 'bg-accent-soft text-accent-ink' : 'bg-field text-ink-2'}`}
                            >
                              {r.draft.status === 'pending' ? `草稿 → ${r.draft.grp}` : `规则已并入 → ${r.draft.grp}`}
                            </span>
                          )}
                          {r.status !== 'open' && <span className="rounded-chip bg-field px-1.5 font-pixel text-[10px]">{STATUS_LABEL[r.status]}</span>}
                          {r.service && <span className="truncate">{r.service}</span>}
                          {r.network === 'udp' && <span className="font-pixel text-[10px]">UDP</span>}
                        </span>
                      </span>
                    </button>
                    <span className="col-start-2 flex min-w-0 flex-wrap items-center gap-1.5 lg:col-start-auto lg:flex-col lg:flex-nowrap lg:items-start lg:gap-1">
                      <RuleBadge type={r.rule} payload={r.rule_payload} index={r.rule_index} />
                      <span className="flex min-w-0 items-center gap-1.5">
                        <GroupChip name={r.grp} />
                        <span className="sub truncate text-[11.5px] text-ink-3">{r.node}</span>
                      </span>
                    </span>
                    <span className="hidden lg:block">
                      <ExpectedChip grp={r.expected} />
                    </span>
                    <span className="hidden min-w-0 truncate text-[12px] text-ink-2 lg:block" title={devs.map(deviceName).join('\n')}>
                      {devs.slice(0, 2).map(deviceName).join('、')}
                      {devs.length > 2 ? ` 等 ${devs.length} 台` : ''}
                    </span>
                    <span className="num hidden font-mono text-[12px] lg:block lg:text-right">
                      {r.count.toLocaleString()} 次<span className="sub block text-[11px] text-ink-3">{fmtAgo(r.last_seen)}</span>
                    </span>
                    {/* phone: expected, devices and count on one line */}
                    <span className="col-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3 lg:hidden">
                      {r.expected && (
                        <span className="flex items-center gap-1">
                          期望 <ExpectedChip grp={r.expected} />
                        </span>
                      )}
                      <span className="min-w-0 truncate text-ink-2">
                        {devs.slice(0, 1).map(deviceName).join('')}
                        {devs.length > 1 ? ` 等 ${devs.length} 台` : ''}
                      </span>
                      <span className="num font-mono">
                        {r.count.toLocaleString()} 次 · {fmtAgo(r.last_seen)}
                      </span>
                    </span>
                    <span className="hidden flex-col items-end gap-0.5 lg:flex">
                      <RowMenu host={r.host} expect={r.expected || undefined} from="异常案例" />
                      <button onClick={() => setOpen(expanded ? null : r.key)} className="tap rounded-[7px] p-1 text-ink-3 hover:bg-hover hover:text-ink" aria-label={expanded ? '收起详情' : '展开详情'} aria-expanded={expanded}>
                        <ChevronDown className={`h-4 w-4 transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`} />
                      </button>
                    </span>
                  </div>
                  {expanded && <CaseDetail row={r} deviceName={deviceName} onNote={(note) => void patch([r.key], { note }, '备注已保存')} />}
                </li>
              );
            })}
          </ul>
        )}
        {(data?.total ?? 0) > PAGE && (
          <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[12px] text-ink-2">
            <span className="num font-mono">
              {page * PAGE + 1}–{Math.min((page + 1) * PAGE, data!.total)} / {data!.total}
            </span>
            <span className="flex gap-1">
              <button disabled={page === 0} onClick={() => setPage(page - 1)} className="tap rounded-chip px-2 py-1 hover:bg-hover disabled:opacity-35">
                上一页
              </button>
              <button disabled={(page + 1) * PAGE >= data!.total} onClick={() => setPage(page + 1)} className="tap rounded-chip px-2 py-1 hover:bg-hover disabled:opacity-35">
                下一页
              </button>
            </span>
          </div>
        )}
      </Card>
    </>
  );
}

function CaseDetail({ row, deviceName, onNote }: { row: CaseRow; deviceName: (ip: string) => string; onNote: (note: string) => void }) {
  const [conns, setConns] = useState<Record<string, string | number | null>[] | null>(null);
  const [note, setNote] = useState(row.note);
  useEffect(() => {
    getJson<Record<string, string | number | null>[]>(`/api/cases/conns?key=${encodeURIComponent(row.key)}`).then(setConns).catch(() => setConns([]));
  }, [row.key]);
  return (
    <div className="dialog-in grid gap-4 border-t border-dashed border-line-strong bg-field/50 px-4 py-3 text-[12.5px] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <dl className="grid grid-cols-[72px_1fr] gap-x-3 gap-y-1.5">
        <dt className="eyebrow pt-0.5">线路</dt>
        <dd className="break-all">{row.chain || '—'}</dd>
        <dt className="eyebrow pt-0.5">目标</dt>
        <dd>
          <span className="font-mono">{row.target_ip || '—'}</span> {row.country && <Country code={row.country} />} {row.org && <span className="text-ink-2">· {row.org}</span>}
        </dd>
        <dt className="eyebrow pt-0.5">归属</dt>
        <dd>{row.scope === 'cn' ? '国内服务' : row.scope === 'intl' ? '境外服务' : '未知'}</dd>
        <dt className="eyebrow pt-0.5">时间</dt>
        <dd>
          首次 {fmtDateTime(row.first_seen)} · 最近 {fmtDateTime(row.last_seen)}
        </dd>
        <dt className="eyebrow pt-0.5">备注</dt>
        <dd className="flex gap-1.5">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="比如：已加到自定义规则，等重载" className="h-8 min-w-0 flex-1 rounded-control bg-page px-2 text-[12.5px] shadow-card outline-none focus:shadow-[0_0_0_1.5px_var(--accent)]" />
          <Button kind="ghost" className="h-8 px-2.5" disabled={note === row.note} onClick={() => onNote(note)}>
            保存
          </Button>
        </dd>
      </dl>
      <div className="min-w-0">
        <p className="eyebrow mb-1">最近的连接（来自连接记录）</p>
        {!conns ? (
          <p className="text-ink-3">读取中…</p>
        ) : conns.length === 0 ? (
          <p className="text-ink-3">连接记录里没有了（超过保留天数或网站当时没运行）。</p>
        ) : (
          <ul className="max-h-48 divide-y divide-line overflow-y-auto scroll-thin">
            {conns.map((c) => (
              <li key={String(c.id)} className="grid grid-cols-[120px_minmax(0,1fr)_90px] gap-2 py-1 font-mono text-[11.5px]">
                <span className="text-ink-2">{fmtDateTime(Number(c.start))}</span>
                <span className="truncate">
                  {deviceName(String(c.src))} · :{c.dst_port} {String(c.network).toUpperCase()}
                </span>
                <span className="text-right text-ink-2">{fmtBytes(Number(c.up) + Number(c.down))}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ExpectList({ items, reload }: { items: Expectation[]; reload: () => void }) {
  const [kind, setKind] = useState('suffix');
  const [value, setValue] = useState('');
  const [grp, setGrp] = useState('');
  const [note, setNote] = useState('');
  const groups = useGroups();
  const toast = useToast();
  const add = async () => {
    if (!value.trim() || !grp) return toast('填上目标和期望策略组', 'error');
    await sendJson('/api/expectations', 'POST', { items: [{ kind, value: value.trim(), grp, note, source: '手动' }] });
    setValue('');
    setNote('');
    toast('预期已保存');
    reload();
  };
  const field = 'h-9 rounded-control bg-page px-2.5 text-[13px] shadow-card outline-none focus:shadow-[0_0_0_1.5px_var(--accent)]';
  return (
    <>
      <Card className="rise space-y-3 p-4" style={rise(1)}>
        <p className="text-[12.5px] leading-relaxed text-ink-2">
          预期是你对「某个域名 / IP 应该走哪」的声明。连接命中预期但没走对，会记成「违反预期」的案例；走对了，就不再按国内 / 境外的自动规则报异常。选「任意直连 / 任意代理」时只看出口，不管经过哪个策略组。
        </p>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={field} aria-label="类型">
            {Object.entries(KIND_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === 'cidr' ? '47.235.16.0/20' : kind === 'ip' ? '47.52.123.84' : 'alipay.com'} className={`${field} w-56 font-mono`} aria-label="目标" />
          <span className="text-ink-3">应该走</span>
          <GroupSelect value={grp} onChange={setGrp} groups={groups} className="h-9 w-44" />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（可选）" className={`${field} min-w-[140px] flex-1`} />
          <Button type="submit" kind="primary">
            <Plus className="h-3.5 w-3.5" /> 添加预期
          </Button>
        </form>
      </Card>
      <Card className="rise overflow-hidden" style={rise(2)}>
        {items.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] text-ink-3">还没有预期。可以在上面添加，或者在分流测试的调整方案、异常案例里一键保存。</p>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((e) => (
              <li key={e.id} className="grid grid-cols-[56px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_28px] items-center gap-3 px-4 py-2 text-[13px]">
                <span className="rounded-chip bg-field px-1.5 py-0.5 text-center font-pixel text-[10.5px] text-ink-2">{KIND_LABEL[e.kind] ?? e.kind}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <Favicon host={e.value} />
                  <span className="truncate font-mono">{e.value}</span>
                </span>
                <span>
                  <ExpectedChip grp={e.grp} />
                </span>
                <span className="truncate text-[12px] text-ink-3">
                  {e.note || e.source} · {fmtAgo(e.created_at)}
                </span>
                <button
                  aria-label={`删除 ${e.value}`}
                  onClick={async () => {
                    await sendJson(`/api/expectations/${e.id}`, 'DELETE');
                    toast('已删除');
                    reload();
                  }}
                  className="tap rounded-[7px] p-1 text-ink-3 hover:bg-hover hover:text-stop"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/* ---------- rule drafts ---------- */

interface DraftRow {
  id: number;
  kind: 'domain' | 'suffix' | 'keyword' | 'ip' | 'cidr' | 'asn';
  value: string;
  grp: string;
  from_grp: string;
  source: string;
  note: string;
  status: 'pending' | 'applied';
  created_at: number;
  applied_at: number | null;
  hit: SnapRule | null;
  /** index of the same rule in the running config, when it is already there */
  inConfig: number | null;
}

const DRAFT_KIND: Record<string, string> = { ...KIND_LABEL, asn: 'ASN' };
const LINE_KIND: Record<string, DraftRow['kind']> = { DOMAIN: 'domain', 'DOMAIN-SUFFIX': 'suffix', 'DOMAIN-KEYWORD': 'keyword', 'IP-CIDR': 'cidr', 'IP-ASN': 'asn' };

/** "- DOMAIN-SUFFIX,a.com,国内" / "IP-CIDR,1.2.3.4/32,DIRECT,no-resolve" -> draft fields */
function parseRuleLine(raw: string): { kind: DraftRow['kind']; value: string; grp: string } | null {
  const line = raw
    .trim()
    .replace(/^-\s*/, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
  const [type, value, grp] = line.split(',').map((s) => s.trim());
  let kind = LINE_KIND[type?.toUpperCase()];
  if (!kind || !value || !grp) return null;
  let v = value;
  if (kind === 'cidr' && v.endsWith('/32')) {
    kind = 'ip';
    v = v.slice(0, -3);
  }
  return { kind, value: v, grp };
}

/** 47.235.16.0/20 -> 47.235.16.1 (the network address itself is not a host to dial) */
function firstHost(cidr: string): string {
  const [ip, bits] = cidr.split('/');
  const p = ip.split('.').map(Number);
  if (Number(bits) >= 31) return ip;
  p[3] += 1;
  return p.join('.');
}

function DraftList({ items, reload }: { items: DraftRow[]; reload: () => void }) {
  const { ruleAt } = useSnapshotInfo();
  const toast = useToast();
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [showApplied, setShowApplied] = useState(false);
  const applied = useData<DraftRow[]>(showApplied ? '/api/drafts?status=applied' : null, 0);

  // lines already in the running config are left out of the yaml
  const todo = useMemo(() => items.filter((d) => d.inConfig === null), [items]);
  const plan = useMemo(
    () =>
      planBlocks(
        todo.map((d) => ({
          target: { kind: d.kind, value: d.value, test: d.value, from: [] },
          from: d.from_grp,
          to: d.grp,
          hitIndex: d.hit?.index ?? -1,
        })),
      ),
    [todo],
  );
  const ruleLabel = (i: number) => {
    const r = ruleAt.get(i);
    return r ? `#${i} ${r.type}${r.payload ? `(${r.payload})` : ''} → ${r.target}` : `#${i}`;
  };
  const yaml = plan.blocks
    .map((b) => [`  # ${b.before < 0 ? '放在最前面（这些没测过现在停在哪条）' : `插在 ${ruleLabel(b.before)} 之前`}`, ...b.lines.map(yamlItem)].join('\n'))
    .join('\n');
  const lineCount = plan.blocks.reduce((n, b) => n + b.lines.length, 0);
  const selected = items.filter((d) => picked.has(d.id));

  const add = async () => {
    const lines = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    const parsed = lines.map(parseRuleLine);
    const bad = lines.filter((_, i) => !parsed[i]);
    const ok = parsed.filter((p): p is NonNullable<typeof p> => !!p);
    if (!ok.length) return toast(bad.length ? `认不出这条规则：${bad[0].trim()}` : '先粘贴规则行', 'error');
    try {
      const r = await sendJson<{ added: number; updated: number }>('/api/drafts', 'POST', { items: ok.map((p) => ({ ...p, source: '手动' })) });
      toast(`新增 ${r.added} 条${r.updated ? `，更新 ${r.updated} 条` : ''}${bad.length ? `；${bad.length} 行认不出（只支持 DOMAIN / SUFFIX / KEYWORD / IP-CIDR / IP-ASN），没加` : ''}`);
      setText('');
      reload();
    } catch (e) {
      toast(`没有加入：${(e as Error).message}`, 'error');
    }
  };
  const mark = async (ids: number[], status: 'applied' | 'pending', msg: string) => {
    try {
      await sendJson('/api/drafts', 'PATCH', { ids, status });
      toast(msg);
      setPicked(new Set());
      reload();
      applied.reload();
    } catch (e) {
      toast(`没有保存：${(e as Error).message}`, 'error');
    }
  };
  const retest = (list: DraftRow[]) => {
    const n = basket.add(
      list
        .filter((d) => d.kind !== 'asn')
        .map((d) => ({ value: d.value, kind: d.kind, test: d.kind === 'cidr' ? firstHost(d.value) : d.kind === 'keyword' ? `${d.value}.com` : d.value, from: ['规则草稿'], expect: d.grp })),
    );
    toast(`已放进测试清单 ${n} 条，带着期望策略组`);
    navigate('analyze', '@basket');
  };
  const field = 'rounded-control bg-page px-2.5 text-[13px] shadow-card outline-none focus:shadow-[0_0_0_1.5px_var(--accent)]';

  return (
    <>
      <Card className="rise space-y-3 p-4" style={rise(1)}>
        <p className="text-[12.5px] leading-relaxed text-ink-2">
          攒着等 yaml 维护时一次改的规则。从分流测试的调整方案、异常案例的批量操作加进来，或者在下面直接粘贴规则行。加入时同时记为预期，改完之后如果又走错，会重新出现在案例里。网站只生成文本，不会改路由器上的配置。
        </p>
        <form
          className="flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder={'每行一条，例如\nDOMAIN-SUFFIX,alipaylog.com,国内'}
            className={`${field} min-h-[60px] min-w-[240px] flex-1 py-2 font-mono`}
            aria-label="规则行"
          />
          <Button type="submit" kind="primary" className="h-9">
            <Plus className="h-3.5 w-3.5" /> 加入草稿
          </Button>
        </form>
      </Card>

      <Card className="rise overflow-hidden" style={rise(2)}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed border-line-strong px-4 py-2.5 text-[12.5px]">
          <label className="flex items-center gap-2 text-ink-2">
            <input type="checkbox" className="accent-[var(--accent)]" checked={items.length > 0 && items.every((d) => picked.has(d.id))} onChange={(e) => setPicked(e.target.checked ? new Set(items.map((d) => d.id)) : new Set())} />
            待改 {items.length} 条 · 已选 {selected.length}
          </label>
          <span className="flex flex-wrap items-center gap-1.5">
            <Button kind="ghost" className="h-8 px-2.5" disabled={!items.length} onClick={() => retest(selected.length ? selected : items)} title="放进测试清单，用内核真实判定一遍（改完配置后用来确认）">
              <FlaskConical className="h-3.5 w-3.5" /> 复测{selected.length ? '所选' : '全部'}
            </Button>
            <Button kind="ghost" className="h-8 px-2.5" disabled={!selected.length} onClick={() => void mark(selected.map((d) => d.id), 'applied', `已标记 ${selected.length} 条为已并入`)}>
              <CheckCheck className="h-3.5 w-3.5" /> 标为已并入
            </Button>
          </span>
        </div>
        {items.length === 0 ? (
          <p className="px-4 py-10 text-center text-[13px] text-ink-3">草稿箱是空的。在分流测试的调整方案里点「加入规则草稿」，或在异常案例里选中后加进来。</p>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((d) => (
              <li key={d.id} className="grid grid-cols-[18px_minmax(0,1fr)_28px] items-start gap-3 px-4 py-2.5 text-[13px] lg:grid-cols-[18px_56px_minmax(180px,1.3fr)_minmax(160px,1fr)_minmax(200px,1.3fr)_28px] lg:items-center">
                <input
                  type="checkbox"
                  aria-label={`选中 ${d.value}`}
                  className="mt-1 accent-[var(--accent)] lg:mt-0"
                  checked={picked.has(d.id)}
                  onChange={(e) =>
                    setPicked((s) => {
                      const next = new Set(s);
                      if (e.target.checked) next.add(d.id);
                      else next.delete(d.id);
                      return next;
                    })
                  }
                />
                <span className="hidden rounded-chip bg-field px-1.5 py-0.5 text-center font-pixel text-[10.5px] text-ink-2 lg:block">{DRAFT_KIND[d.kind] ?? d.kind}</span>
                <span className="min-w-0 lg:contents">
                  <span className="flex min-w-0 items-center gap-2">
                    <Favicon host={d.value} />
                    <span className="truncate font-mono">{d.value}</span>
                    <span className="rounded-chip bg-field px-1.5 font-pixel text-[10px] text-ink-2 lg:hidden">{DRAFT_KIND[d.kind] ?? d.kind}</span>
                  </span>
                  <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 lg:mt-0">
                    {d.from_grp && <span className="truncate text-[12px] text-ink-3">{d.from_grp}</span>}
                    {d.from_grp && <span className="text-ink-3">→</span>}
                    <GroupChip name={d.grp} />
                  </span>
                  <span className="mt-1 block min-w-0 text-[12px] text-ink-3 lg:mt-0">
                    {d.inConfig !== null ? (
                      <span className="rounded-chip bg-accent-soft px-1.5 py-0.5 text-accent-ink">配置里已有（#{d.inConfig}），可以标为已并入</span>
                    ) : d.hit ? (
                      <span className="block truncate" title={ruleLabel(d.hit.index)}>
                        现在停在 <span className="font-mono text-ink-2">{ruleLabel(d.hit.index)}</span>
                      </span>
                    ) : (
                      <span>还没测过现在停在哪条</span>
                    )}
                    <span className="block truncate">
                      {d.source} · {fmtAgo(d.created_at)}
                    </span>
                  </span>
                </span>
                <button
                  aria-label={`删除 ${d.value}`}
                  onClick={async () => {
                    try {
                      await sendJson(`/api/drafts/${d.id}`, 'DELETE');
                      toast('已从草稿删除（预期还在，要删去「我的预期」）');
                      reload();
                    } catch (e) {
                      toast(`没有删除：${(e as Error).message}`, 'error');
                    }
                  }}
                  className="tap rounded-[7px] p-1 text-ink-3 hover:bg-hover hover:text-stop"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {lineCount > 0 && (
        <Card className="rise space-y-3 p-5" style={rise(3)}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-baseline gap-x-2.5">
              <h3 className="font-display text-[16px] font-semibold">要改的 yaml</h3>
              <span className="text-[12.5px] text-ink-2">
                {lineCount} 条规则，分 {plan.blocks.length} 处插入
                {plan.skipped ? `（${plan.skipped} 条被同组的后缀 / 网段覆盖，已省略）` : ''}
                {items.length > todo.length ? `；${items.length - todo.length} 条配置里已有，没写进来` : ''}
              </span>
            </div>
            <Button
              kind="primary"
              className="h-8 px-3"
              onClick={() => {
                void navigator.clipboard?.writeText(yaml);
                toast(`已复制 ${lineCount} 条规则`);
              }}
            >
              <Copy className="h-3.5 w-3.5" /> 复制 yaml
            </Button>
          </div>
          <pre className="max-h-80 overflow-auto rounded-control bg-field px-3.5 py-3 font-mono text-[12.5px] leading-relaxed shadow-plate scroll-thin">
            <span className="text-ink-3">rules:{'\n'}</span>
            {yaml}
          </pre>
          <p className="text-[12.5px] leading-relaxed text-ink-2">
            每段注释写的是这段规则要插在哪条规则前面：这些目标现在最早停在那一条，排在它后面就不会生效。规则号按当前运行的配置算，改动配置后会自动更新。也可以全部放进 OpenClash 的自定义规则（排在所有 yaml 规则最前面）。改完重载后点「复测」确认，再标为已并入。
          </p>
        </Card>
      )}

      <button className="tap inline-flex items-center gap-1 text-[12.5px] text-ink-2 hover:text-ink" onClick={() => setShowApplied(!showApplied)}>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showApplied ? '' : '-rotate-90'}`} /> 已并入的规则
      </button>
      {showApplied && (
        <Card className="overflow-hidden">
          {(applied.data ?? []).length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-ink-3">{applied.loading ? '读取中…' : '还没有标为已并入的规则。'}</p>
          ) : (
            <ul className="divide-y divide-line">
              {(applied.data ?? []).map((d) => (
                <li key={d.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-2 text-[13px]">
                  <span className="truncate font-mono">{ruleFor({ kind: d.kind, value: d.value, test: d.value, from: [] }, d.grp)}</span>
                  <span className="text-[12px] text-ink-3">{d.applied_at ? fmtDateTime(d.applied_at) : ''}</span>
                  <button className="tap rounded-chip px-2 py-1 text-[12px] text-ink-2 hover:bg-hover" onClick={() => void mark([d.id], 'pending', '已放回待改')}>
                    放回待改
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}
