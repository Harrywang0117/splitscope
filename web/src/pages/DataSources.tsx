import { Download, RefreshCw, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getJson, sendJson, useData, type Status } from '../api.ts';
import { Button, Card, rise, SectionHead, useToast } from '../components/bits.tsx';
import { fmtAgo, fmtBytes, fmtDateTime } from '../lib/format.ts';

interface ChangeLogEntry {
  at: number;
  trigger: string;
  items: string[];
}

const TRIGGER: Record<string, string> = { auto: '每日自动', manual: '手动', startup: '启动时', detected: '检测到变化' };
const ASSET_DESC: Record<string, string> = {
  'geosite.dat': '域名 → 服务分类（MetaCubeX）',
  'geoip.dat': 'IP → Telegram / Google / Netflix 等分类',
  'GeoLite2-ASN.mmdb': 'IP → ASN / 运营商',
  'country.mmdb': 'IP → 国家',
  manuf: 'MAC → 设备厂商（Wireshark）',
};

export function DataSources({ status, reload }: { status: Status | null; reload: () => void }) {
  const [log, setLog] = useState<ChangeLogEntry[]>([]);
  const [busy, setBusy] = useState('');
  const toast = useToast();

  useEffect(() => {
    getJson<{ changelog: ChangeLogEntry[] }>('/api/intel').then((r) => setLog(r.changelog)).catch(() => undefined);
  }, [status?.intel.lastRunAt, status?.intel.running]);

  const snap = status?.snapshot;
  const intel = status?.intel;
  const at = (name: string) => status?.schedule.find((s) => s.name === name);

  const refreshConfig = async () => {
    setBusy('config');
    try {
      await sendJson('/api/snapshot/refresh', 'POST');
      toast('配置已重新读取');
    } catch (e) {
      toast(`读取配置失败：${(e as Error).message}`, 'error');
    }
    setBusy('');
    reload();
  };
  const refreshIntel = async () => {
    setBusy('intel');
    await sendJson('/api/intel/refresh', 'POST').catch(() => undefined);
    toast('开始检查识别库更新');
    setBusy('');
    reload();
  };

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <StorageSection />
      <section className="min-w-0 space-y-3">
        <SectionHead
          className="rise"
          style={rise(0)}
          title="OpenClash 配置"
          desc={`每天 ${at('snapshot')?.at ?? '04:30'} 自动读取`}
          aside={
            <Button onClick={() => void refreshConfig()} disabled={busy === 'config'} title="只读取配置，不会让 OpenClash 重载，不断网">
              <RefreshCw className={`h-3.5 w-3.5 ${busy === 'config' ? 'animate-spin' : ''}`} />
              {busy === 'config' ? '读取中…' : '立即更新配置'}
            </Button>
          }
        />
        <Card className="rise space-y-4 p-5 text-[13px]" style={rise(1)}>
          {!snap ? (
            <p className="text-ink-2">还没读到配置。确认 OpenClash 在运行后点「立即更新配置」。</p>
          ) : (
            <>
              <dl className="grid grid-cols-[84px_1fr] gap-x-3 gap-y-2.5">
                <dt className="eyebrow pt-0.5">Config</dt>
                <dd className="font-mono text-[12.5px] break-all">{snap.configName || '—'}</dd>
                <dt className="eyebrow pt-0.5">Kernel</dt>
                <dd>Mihomo {snap.version}</dd>
                <dt className="eyebrow pt-0.5">Rules</dt>
                <dd>
                  运行中 {snap.rules} 条 = yaml {snap.diskRules ?? '?'} 条 + OpenClash 自定义 {snap.customRules} 条
                  <span className="block text-ink-2">
                    策略组 {snap.groups} · 规则集 {snap.providers}
                  </span>
                </dd>
                <dt className="eyebrow pt-0.5">Read at</dt>
                <dd>
                  {fmtDateTime(snap.takenAt)}（{TRIGGER[snap.trigger] ?? snap.trigger}）
                  <span className="block text-ink-2">另外每 5 分钟比对一次内核规则，变了就自动重读；按钮只读取，不重载、不断网</span>
                </dd>
              </dl>
              {snap.drift ? (
                <div className="rounded-control bg-signal-bg px-3.5 py-3">
                  <p className="font-medium text-signal">yaml 与内核运行的配置不一致</p>
                  <p className="mt-1 text-[12px]">测试结果以内核正在运行的配置为准。重载 OpenClash 后差异会消失。</p>
                  <DiffList title="只在内核里" items={snap.drift.onlyRunning} />
                  <DiffList title="只在 yaml 里" items={snap.drift.onlyDisk} />
                </div>
              ) : (
                <p className="flex items-center gap-2 text-go">
                  <span className="lamp" /> yaml 与内核运行的配置一致
                </p>
              )}
              {snap.lastChange && (
                <div className="rounded-control bg-field px-3.5 py-3 shadow-plate">
                  <p className="eyebrow">Last change · {fmtDateTime(snap.lastChange.at)}</p>
                  {snap.lastChange.configChanged && (
                    <p className="mt-1 text-[12px] break-all">
                      配置文件：{snap.lastChange.fromPath?.split('/').pop()} → {snap.lastChange.toPath?.split('/').pop()}
                    </p>
                  )}
                  <DiffList title={`新增规则 ${snap.lastChange.added.length}`} items={snap.lastChange.added} />
                  <DiffList title={`删除规则 ${snap.lastChange.removed.length}`} items={snap.lastChange.removed} />
                  {snap.lastChange.groupsAdded.length > 0 && <p className="text-[12px]">新增策略组：{snap.lastChange.groupsAdded.join('、')}</p>}
                  {snap.lastChange.groupsRemoved.length > 0 && <p className="text-[12px]">删除策略组：{snap.lastChange.groupsRemoved.join('、')}</p>}
                </div>
              )}
            </>
          )}
        </Card>
      </section>

      <section className="min-w-0 space-y-3">
        <SectionHead
          className="rise"
          style={rise(0)}
          title="服务识别库"
          desc={`每天 ${at('intel')?.at ?? '05:00'} 检查，变了才下载`}
          aside={
            <Button onClick={() => void refreshIntel()} disabled={!!intel?.running || busy === 'intel'}>
              <RefreshCw className={`h-3.5 w-3.5 ${intel?.running ? 'animate-spin' : ''}`} />
              {intel?.running ? `${intel.phase}${intel.bm7.progress ? ` ${intel.bm7.progress}` : ''}` : '立即更新识别库'}
            </Button>
          }
        />
        <Card className="rise overflow-hidden" style={rise(1)}>
          <ul className="divide-y divide-line">
            {Object.keys(ASSET_DESC).map((name) => {
              const a = intel?.assets[name];
              return (
                <li key={name} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-2.5">
                  <span className="min-w-0">
                    <span className="block font-mono text-[12.5px]">{name}</span>
                    <span className="block text-[12px] text-ink-2">{ASSET_DESC[name]}</span>
                    {a?.error && <span className="block text-[12px] text-stop">{a.error}</span>}
                  </span>
                  <span className="text-right font-mono text-[11.5px] text-ink-2">
                    {a ? (
                      <>
                        <span className="block">
                          {fmtBytes(a.size)} · 更新于 {fmtAgo(a.updatedAt)}
                        </span>
                        <span className="block text-ink-3">检查于 {fmtAgo(a.checkedAt)}</span>
                      </>
                    ) : (
                      '未下载'
                    )}
                  </span>
                </li>
              );
            })}
            <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-2.5">
              <span className="min-w-0">
                <span className="block font-mono text-[12.5px]">blackmatrix7/ios_rule_script</span>
                <span className="block text-[12px] text-ink-2">App 名（含中文名）→ 域名 / IP 段，按目录增量同步</span>
                {intel?.bm7.error && <span className="block text-[12px] text-stop">{intel.bm7.error}</span>}
              </span>
              <span className="text-right font-mono text-[11.5px] text-ink-2">
                <span className="block">{intel?.bm7.dirs ?? 0} 个目录</span>
                <span className="block text-ink-3">同步于 {fmtAgo(intel?.bm7.syncedAt ?? 0)}</span>
              </span>
            </li>
          </ul>
          {intel?.geosite && (
            <p className="border-t border-dashed border-line-strong px-4 py-2.5 text-[12px] text-ink-2">
              GeoSite 共 {intel.geosite.categories.toLocaleString()} 个分类、{intel.geosite.domains.toLocaleString()} 条域名。
            </p>
          )}
        </Card>

        <SectionHead className="rise pt-3" style={rise(2)} title="更新记录" desc="最近 10 次" />
        <Card className="rise p-4" style={rise(3)}>
          {log.length === 0 ? (
            <p className="text-[12px] text-ink-2">还没有更新记录。</p>
          ) : (
            <ol className="relative space-y-4 pl-5">
              <span className="absolute top-1 bottom-1 left-[5px] border-l border-dashed border-line-strong" />
              {log.slice(0, 10).map((e) => (
                <li key={e.at} className="relative">
                  <span className="absolute top-1 -left-5 h-[11px] w-[11px] rounded-full border-2 border-accent bg-page" />
                  <p className="font-mono text-[11.5px] text-ink-2">
                    {fmtDateTime(e.at)} · {TRIGGER[e.trigger] ?? e.trigger}
                  </p>
                  <ul className="mt-0.5 space-y-0.5 text-[12.5px]">
                    {e.items.map((it) => (
                      <li key={it}>{it}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </section>
    </div>
  );
}

function DiffList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <details className="mt-1.5">
      <summary className="cursor-pointer text-[12px]">{title}</summary>
      <pre className="mt-1 max-h-40 overflow-auto font-mono text-[11px] scroll-thin">{items.join('\n')}</pre>
    </details>
  );
}

interface StorageResp {
  settings: { connlogDays: number; connlogMaxRows: number; caseDays: number };
  storage: { dbBytes: number; connlog: { rows: number; conns: number; since: number; until: number }; cases: number; expectations: number; trafficHour: number; trafficMin: number };
}

/** measured on this database: a stored connection row plus its index entries */
const ROW_BYTES = 400;
const MAX_ROWS = [500_000, 1_000_000, 2_000_000, 5_000_000];

function StorageSection() {
  const { data, reload } = useData<StorageResp>('/api/settings', 60_000);
  const toast = useToast();
  const save = async (patch: Partial<StorageResp['settings']>) => {
    try {
      await sendJson('/api/settings', 'PUT', patch);
      toast('已更新，超出的记录会在一小时内清理');
      reload();
    } catch (e) {
      toast(`没有保存：${(e as Error).message}`, 'error');
    }
  };
  const st = data?.storage;
  const sel = 'h-8 rounded-control bg-page px-2 text-[13px] shadow-card outline-none focus:shadow-[0_0_0_1.5px_var(--accent)]';
  const week = Date.now() - 7 * 86_400_000;
  return (
    <section className="min-w-0 space-y-3 lg:col-span-2">
      <SectionHead className="rise" style={rise(0)} title="存储与导出" desc="连接记录、异常案例、历史统计都存在这台机器的 SQLite 里" />
      <Card className="rise grid gap-5 p-5 text-[13px] md:grid-cols-3" style={rise(1)}>
        <div>
          <p className="eyebrow">Connection log</p>
          <p className="mt-1 font-display text-[22px] font-semibold">{st ? st.connlog.rows.toLocaleString() : '—'} 条</p>
          <p className="text-[12px] text-ink-3">
            {st?.connlog.since ? `从 ${fmtDateTime(st.connlog.since)} 开始` : '还没有记录'}
            {st && st.connlog.conns > st.connlog.rows ? `；合计 ${st.connlog.conns.toLocaleString()} 次连接（一分钟内的重复连接合并成一条）` : ''}
          </p>
          <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-ink-2">
            <label className="flex items-center gap-2">
              保留
              <select value={data?.settings.connlogDays ?? 7} onChange={(e) => void save({ connlogDays: Number(e.target.value) })} className={sel}>
                {[3, 7, 14, 30].map((d) => (
                  <option key={d} value={d}>
                    {d} 天{d === 7 ? '（推荐）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              最多
              <select value={data?.settings.connlogMaxRows ?? 1_000_000} onChange={(e) => void save({ connlogMaxRows: Number(e.target.value) })} className={sel}>
                {MAX_ROWS.map((n) => (
                  <option key={n} value={n}>
                    {n / 10_000} 万条（约 {fmtBytes(n * ROW_BYTES)}）
                  </option>
                ))}
              </select>
            </label>
          </span>
          <span className="mt-2 flex gap-1.5">
            <a className="tap inline-flex items-center gap-1 rounded-chip px-2 py-1 text-[12px] text-accent-ink hover:bg-accent-soft" href={`/api/connlog/export?format=csv&from=${week}`}>
              <Download className="h-3.5 w-3.5" /> 近 7 天 CSV
            </a>
            <a className="tap inline-flex items-center gap-1 rounded-chip px-2 py-1 text-[12px] text-accent-ink hover:bg-accent-soft" href={`/api/connlog/export?format=json&from=${week}`}>
              <Download className="h-3.5 w-3.5" /> JSON
            </a>
          </span>
        </div>
        <div>
          <p className="eyebrow">Cases</p>
          <p className="mt-1 font-display text-[22px] font-semibold">{st ? st.cases.toLocaleString() : '—'} 个案例</p>
          <p className="text-[12px] text-ink-3">{st ? `${st.expectations} 条预期` : ''}；已忽略的案例不会被清理</p>
          <label className="mt-2 flex items-center gap-2 text-[12.5px] text-ink-2">
            保留
            <select value={data?.settings.caseDays ?? 90} onChange={(e) => void save({ caseDays: Number(e.target.value) })} className={sel}>
              {[30, 90, 180, 365].map((d) => (
                <option key={d} value={d}>
                  {d} 天{d === 90 ? '（推荐）' : ''}
                </option>
              ))}
            </select>
          </label>
          <span className="mt-2 flex gap-1.5">
            <a className="tap inline-flex items-center gap-1 rounded-chip px-2 py-1 text-[12px] text-accent-ink hover:bg-accent-soft" href="/api/cases/export?format=csv&status=all">
              <Download className="h-3.5 w-3.5" /> 全部案例 CSV
            </a>
            <a className="tap inline-flex items-center gap-1 rounded-chip px-2 py-1 text-[12px] text-accent-ink hover:bg-accent-soft" href="/api/cases/export?format=json&status=all">
              <Download className="h-3.5 w-3.5" /> JSON
            </a>
          </span>
        </div>
        <div>
          <p className="eyebrow">Database</p>
          <p className="mt-1 font-display text-[22px] font-semibold">{st ? fmtBytes(st.dbBytes) : '—'}</p>
          <p className="text-[12px] leading-relaxed text-ink-3">
            小时汇总 {st?.trafficHour.toLocaleString() ?? '—'} 行（31 天）· 分钟趋势 {st?.trafficMin.toLocaleString() ?? '—'} 行（8 天）。连接记录每条约 {ROW_BYTES} 字节，到了天数或条数上限，最旧的先删。
          </p>
        </div>
      </Card>
      <BackupCard />
    </section>
  );
}

/** Device names, expectations, cases and saved tests: download, or merge a backup back in. */
function BackupCard() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const restore = async (file: File) => {
    setBusy(true);
    try {
      const r = await sendJson<{ restored: Record<string, number> }>('/api/restore', 'POST', JSON.parse(await file.text()));
      const label: Record<string, string> = { devices: '设备名', discovered: '自动识别的设备', expectations: '预期', cases: '案例', analyses: '测试记录', drafts: '规则草稿' };
      const parts = Object.entries(r.restored)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${label[t] ?? t} ${n}`);
      toast(parts.length ? `已恢复：${parts.join('、')}` : '备份里的内容这里都已经有了');
    } catch (e) {
      toast(`恢复失败：${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="rise flex flex-wrap items-center gap-x-5 gap-y-3 p-5 text-[13px]" style={rise(2)}>
      <div className="min-w-[240px] flex-1">
        <p className="eyebrow">Backup</p>
        <p className="mt-1 text-ink-2">设备名、预期、异常案例（含状态和备注）、规则草稿、测试记录和保留设置。换机器或重装前先下载一份；恢复是合并，不会覆盖这里更新过的内容。流量统计和连接记录不在备份里。</p>
      </div>
      <span className="flex flex-wrap gap-2">
        <a href="/api/backup" className="tap inline-flex h-9 items-center gap-1.5 rounded-control bg-page px-3 shadow-card hover:bg-hover">
          <Download className="h-3.5 w-3.5" /> 下载备份
        </a>
        <label className={`tap inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-control bg-page px-3 shadow-card hover:bg-hover ${busy ? 'pointer-events-none opacity-50' : ''}`}>
          <Upload className="h-3.5 w-3.5" /> {busy ? '恢复中…' : '从备份恢复'}
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void restore(f);
            }}
          />
        </label>
      </span>
    </Card>
  );
}
