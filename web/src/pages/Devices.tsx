import { Pencil } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Device } from '../../../shared/types.ts';
import { sendJson, type LiveData, type Range } from '../api.ts';
import { DeviceDetail } from '../components/DeviceDetail.tsx';
import { Button, Card, KindIcon, rise, SectionHead, Segmented, useToast } from '../components/bits.tsx';
import { fmtBytes, fmtSpeed, KIND_LABEL } from '../lib/format.ts';

const SOURCE_LABEL: Record<string, string> = {
  alias: '你起的名',
  friendly: '设备自报',
  static: '静态租约',
  dhcp: 'DHCP',
  mdns: 'mDNS',
  model: '型号',
  hint: '按流量推测',
  vendor: '按厂商推测',
  special: '',
  unknown: '未识别',
};

type Filter = 'all' | 'active' | 'unnamed';

export function Devices({ live, range }: { live: LiveData; range: Range }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('ip'));
  const [filter, setFilter] = useState<Filter>('all');

  const usage = useMemo(() => {
    const m = new Map<string, { conns: number; speed: number; bytes: number; fallback: number }>();
    for (const c of live.active.values()) {
      if (c.probe || c.self || c.relay) continue;
      const u = m.get(c.srcIp) ?? { conns: 0, speed: 0, bytes: 0, fallback: 0 };
      u.conns++;
      u.speed += c.upSpeed + c.downSpeed;
      u.bytes += c.up + c.down;
      if (c.fallback) u.fallback++;
      m.set(c.srcIp, u);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.version]);

  const weak = (d: Device) => ['hint', 'vendor', 'unknown'].includes(d.labelSource);
  const all = useMemo(() => [...live.devices.values()], [live.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(
    () =>
      all
        .filter((d) => (filter === 'active' ? usage.has(d.ip) : filter === 'unnamed' ? weak(d) && !d.special : true))
        .sort((a, b) => (usage.get(b.ip)?.speed ?? 0) - (usage.get(a.ip)?.speed ?? 0) || (usage.get(b.ip)?.conns ?? 0) - (usage.get(a.ip)?.conns ?? 0) || Number(!!a.special) - Number(!!b.special)),
    [all, filter, usage],
  );
  const unnamed = all.filter((d) => weak(d) && !d.special).length;

  return (
    <div className="space-y-4">
      <SectionHead
        className="rise"
        style={rise(0)}
        title="家里的设备"
        desc="点一台设备看它的历史；名字依次取自：你起的名 → 设备自报（Bonjour / UPnP）→ 路由器租约 → 型号 → 流量特征 → 网卡厂商"
        aside={
          <Segmented
            label="筛选"
            value={filter}
            onChange={setFilter}
            options={[
              ['all', `全部 ${all.length}`],
              ['active', `有连接 ${usage.size}`],
              ['unnamed', `待起名 ${unnamed}`],
            ]}
          />
        }
      />
      <Card className="rise overflow-hidden" style={rise(1)}>
        <div className="eyebrow hidden border-b border-dashed border-line-strong px-4 py-2.5 md:grid md:grid-cols-[minmax(220px,1.5fr)_120px_minmax(180px,1.1fr)_130px_64px] md:gap-4">
          <span>设备</span>
          <span>IP</span>
          <span>MAC · 厂商</span>
          <span className="text-right">当前</span>
          <span />
        </div>
        <ul className="divide-y divide-line">
          {list.map((d, i) =>
            editing === d.key ? (
              <li key={d.key}>
                <DeviceEditor device={d} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <li
                key={d.key}
                onClick={() => setDetail(d.ip)}
                className="rise group cursor-pointer px-4 py-3 hover:bg-hover md:grid md:grid-cols-[minmax(220px,1.5fr)_120px_minmax(180px,1.1fr)_130px_64px] md:items-center md:gap-4"
                style={rise(i + 2)}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="relative flex h-9 w-9 flex-none items-center justify-center rounded-control bg-field text-ink-2 shadow-plate">
                    <KindIcon kind={d.kind} />
                    <span
                      className={`lamp absolute -right-0.5 -bottom-0.5 h-2 w-2 ${usage.has(d.ip) ? 'lamp-live' : ''}`}
                      style={{ color: usage.has(d.ip) ? 'var(--go)' : d.online ? 'var(--ink-3)' : 'transparent' }}
                      title={usage.has(d.ip) ? '有连接' : d.online ? '在线' : '离线'}
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className={`truncate text-[14px] ${weak(d) ? 'text-ink-2' : 'font-medium'}`}>{d.label}</span>
                      {SOURCE_LABEL[d.labelSource] && <span className="flex-none rounded-chip bg-field px-1.5 py-px font-pixel text-[10px] text-ink-3">{SOURCE_LABEL[d.labelSource]}</span>}
                    </span>
                    <span className="block truncate text-[12px] text-ink-2">
                      {[
                        KIND_LABEL[d.kind],
                        d.model && d.model !== d.label ? d.model : '',
                        d.hostname && d.hostname !== d.label ? d.hostname : '',
                        d.mdnsHost && d.mdnsHost !== d.label && d.mdnsHost !== d.hostname ? `${d.mdnsHost}.local` : '',
                        d.staticName && d.staticName !== d.label ? `静态 ${d.staticName}` : '',
                        d.hint && d.labelSource !== 'hint' ? `流量像${d.hint}` : '',
                        d.note,
                      ]
                        .filter(Boolean)
                        .join(' · ') || ' '}
                    </span>
                  </span>
                </span>
                <span className="mt-1.5 block font-mono text-[12px] text-ink-2 md:mt-0 md:text-ink">{d.ip}</span>
                <span className="block min-w-0 text-[12px]">
                  <span className="block font-mono text-ink-2">{d.mac || '—'}</span>
                  <span className="block truncate text-ink-3">{d.special === 'docker' ? 'Docker 网桥' : d.randomMac ? '私有随机地址' : d.vendor}</span>
                </span>
                <span className="num mt-1 block font-mono text-[11.5px] text-ink-2 md:mt-0 md:text-right">
                  {usage.get(d.ip) ? (
                    <>
                      {usage.get(d.ip)!.conns} 条 · {fmtSpeed(usage.get(d.ip)!.speed) || fmtBytes(usage.get(d.ip)!.bytes)}
                      {usage.get(d.ip)!.fallback > 0 && <span className="block text-signal">兜底 {usage.get(d.ip)!.fallback}</span>}
                    </>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </span>
                <span className="mt-1 flex md:mt-0 md:justify-end">
                  {!d.special || d.special === 'docker' ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(d.key);
                      }}
                      className="tap inline-flex items-center gap-1 rounded-chip px-2 py-1 text-[12px] text-accent-ink hover:bg-accent-soft">
                      <Pencil className="h-3 w-3" />
                      {d.alias ? '改名' : '起名'}
                    </button>
                  ) : null}
                </span>
              </li>
            ),
          )}
        </ul>
      </Card>
      {detail && <DeviceDetail ip={detail} device={live.devices.get(detail)} range={range} onClose={() => setDetail(null)} />}
    </div>
  );
}

function DeviceEditor({ device, onDone }: { device: Device; onDone: () => void }) {
  const [name, setName] = useState(device.alias);
  const [kind, setKind] = useState(device.kind);
  const [note, setNote] = useState(device.note);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const save = async () => {
    setSaving(true);
    try {
      await sendJson(`/api/devices/${encodeURIComponent(device.key)}`, 'PUT', { name, kind, note });
      toast(name ? `已保存「${name}」` : '已清除名字');
    } catch (e) {
      toast(`保存失败：${(e as Error).message}`, 'error');
    }
    setSaving(false);
    onDone();
  };
  const field = 'h-9 rounded-control bg-page px-2.5 text-[14px] text-ink shadow-card outline-none focus:shadow-[0_0_0_1.5px_var(--accent)]';
  return (
    <form
      className="dialog-in flex flex-wrap items-end gap-2.5 bg-field px-4 py-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="flex flex-col gap-1 text-[12px] text-ink-2">
        名称
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={device.label} className={`${field} w-52`} />
      </label>
      <label className="flex flex-col gap-1 text-[12px] text-ink-2">
        类型
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={field}>
          <option value="">未分类</option>
          {Object.entries(KIND_LABEL).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="flex min-w-[160px] flex-1 flex-col gap-1 text-[12px] text-ink-2">
        备注
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：客厅、妈妈的手机" className={field} />
      </label>
      <span className="pb-2 font-mono text-[11px] text-ink-3">按 {device.mac ? `MAC ${device.mac}` : `IP ${device.ip}`} 记住</span>
      <Button type="submit" kind="primary" disabled={saving}>
        保存
      </Button>
      <Button kind="quiet" onClick={onDone}>
        取消
      </Button>
    </form>
  );
}
