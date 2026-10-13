import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { Bm7Index, syncBm7 } from '../analyze/bm7.ts';
import { config } from '../config.ts';
import { kvGet, kvSet } from '../db.ts';
import { downloadFile, proxyText } from '../net.ts';
import { GeoIpTags, IpDb } from './geoip.ts';
import { GeoSite, isAggregate } from './geosite.ts';
import { oui } from './device.ts';

/**
 * Service-identification data: GeoSite / GeoIP / ASN / country / OUI files plus the blackmatrix7 index.
 * Updates are change-driven: published sha256 (MetaCubeX) or ETag (Wireshark) is compared first and a
 * file is only re-downloaded when it changed; blackmatrix7 is synced per directory by git tree SHA.
 */

const MCX = 'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest';

interface AssetDef {
  name: string;
  url: string;
  check: 'sha256' | 'etag';
}

const ASSETS: AssetDef[] = [
  { name: 'geosite.dat', url: `${MCX}/geosite.dat`, check: 'sha256' },
  { name: 'geoip.dat', url: `${MCX}/geoip.dat`, check: 'sha256' },
  { name: 'GeoLite2-ASN.mmdb', url: `${MCX}/GeoLite2-ASN.mmdb`, check: 'sha256' },
  { name: 'country.mmdb', url: `${MCX}/country.mmdb`, check: 'sha256' },
  { name: 'manuf', url: 'https://www.wireshark.org/download/automated/data/manuf', check: 'etag' },
];

interface AssetState {
  version: string;
  size: number;
  updatedAt: number;
  checkedAt: number;
  error?: string;
}

export interface ChangeLogEntry {
  at: number;
  trigger: 'auto' | 'manual' | 'startup';
  items: string[];
}

export interface IntelStatus {
  running: boolean;
  phase: string;
  lastRunAt: number;
  assets: Record<string, AssetState>;
  bm7: { dirs: number; syncedAt: number; progress?: string; error?: string };
  geosite: { categories: number; domains: number } | null;
}

const dir = () => path.join(config.dataDir, 'intel');
const fileOf = (name: string) => path.join(dir(), name);

export const intel = {
  geosite: null as GeoSite | null,
  geoipTags: null as GeoIpTags | null,
  ipdb: new IpDb(),
  bm7: new Bm7Index(),
  /** dominant GeoSite service of each blackmatrix7 list (computed after both are loaded) */
  bm7Family: new Map<string, { key?: string; share: number; distinct: number; total: number }>(),
  /** bm7 lists that mix many unrelated services (e.g. "Mail") — useless for naming one connection */
  bm7Aggregate(dir: string): boolean {
    const f = this.bm7Family.get(dir);
    return !!f && f.total >= 5 && f.distinct >= 4 && f.share < 0.4;
  },
  services: { names: {}, aliases: {}, asn: {}, nodeRegions: {} } as {
    names: Record<string, string>;
    aliases: Record<string, string[]>;
    asn: Record<string, string>;
    /** node-name keyword -> exit country, for nodes whose names carry no region (own VPS) */
    nodeRegions: Record<string, string>;
  },
  status: {
    running: false,
    phase: '',
    lastRunAt: 0,
    assets: {},
    bm7: { dirs: 0, syncedAt: 0 },
    geosite: null,
  } as IntelStatus,
};

const listeners = new Set<() => void>();
export function onIntelChanged(fn: () => void) {
  listeners.add(fn);
}
const notify = () => listeners.forEach((fn) => fn());

function loadServices() {
  const f = path.join(config.staticDataDir, 'services.json');
  if (fs.existsSync(f)) intel.services = JSON.parse(fs.readFileSync(f, 'utf8'));
}

async function loadIndexes(only?: Set<string>) {
  const want = (n: string) => !only || only.has(n);
  if (want('geosite.dat')) {
    intel.geosite = GeoSite.load(fileOf('geosite.dat'));
    intel.status.geosite = intel.geosite?.stats() ?? null;
  }
  if (want('geoip.dat')) intel.geoipTags = GeoIpTags.load(fileOf('geoip.dat'));
  if (want('GeoLite2-ASN.mmdb') || want('country.mmdb')) {
    const db = new IpDb();
    await db.load(fileOf('GeoLite2-ASN.mmdb'), fileOf('country.mmdb'));
    intel.ipdb = db;
  }
  if (want('manuf')) oui.load(fileOf('manuf'));
  if (want('bm7')) {
    intel.bm7 = Bm7Index.load();
    intel.status.bm7.dirs = intel.bm7.meta.size;
  }
  if (want('bm7') || want('geosite.dat')) computeBm7Families();
}

/**
 * For each blackmatrix7 list, which GeoSite service its domains belong to. Share is measured over the
 * domains GeoSite knows at all, so a list with many domains GeoSite lacks (AliPay) still counts as one
 * family; ties go to the smaller (more specific) GeoSite list (YouTube rather than google).
 */
function computeBm7Families() {
  const gs = intel.geosite;
  const fam = new Map<string, { key?: string; share: number; distinct: number; total: number }>();
  if (gs) {
    for (const m of intel.bm7.meta.values()) {
      const counts = new Map<string, number>();
      let covered = 0;
      for (const [type, value] of intel.bm7.rules(m.dir).slice(0, 400)) {
        if (type !== 'DOMAIN' && type !== 'DOMAIN-SUFFIX') continue;
        // count every specific GeoSite list containing the domain: GeoSite nests services
        // (microsoft includes bing/xbox), so coverage is what tells a family from a grab-bag
        const keys = new Set((gs.match(value)?.all ?? []).filter((x) => !isAggregate(x)));
        if (keys.size) covered++;
        for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      let key: string | undefined;
      let best = 0;
      for (const [k, n] of counts) {
        if (n > best || (n === best && key && gs.size(k) < gs.size(key))) [key, best] = [k, n];
      }
      fam.set(m.dir, { key, share: covered ? best / covered : 0, distinct: counts.size, total: covered });
    }
  }
  intel.bm7Family = fam;
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Returns a change description when the asset was (re)downloaded, null when unchanged. */
async function updateAsset(def: AssetDef, states: Record<string, AssetState>): Promise<string | null> {
  const file = fileOf(def.name);
  const prev = states[def.name];
  const exists = fs.existsSync(file);
  let remoteVersion = '';

  if (def.check === 'sha256') {
    remoteVersion = (await proxyText(`${def.url}.sha256sum`, 20000)).trim().split(/\s+/)[0];
    if (exists && prev?.version === remoteVersion) {
      states[def.name] = { ...prev, checkedAt: Date.now(), error: undefined };
      return null;
    }
    const size = await downloadFile(def.url, file);
    const actual = sha256File(file);
    if (actual !== remoteVersion) throw new Error(`${def.name}: sha256 mismatch`);
    states[def.name] = { version: remoteVersion, size, updatedAt: Date.now(), checkedAt: Date.now() };
  } else {
    const res = await undiciFetch(def.url, {
      dispatcher: new ProxyAgent(config.mixedProxy),
      headers: exists && prev?.version ? { 'if-none-match': prev.version } : {},
      signal: AbortSignal.timeout(60000),
    });
    if (res.status === 304) {
      states[def.name] = { ...prev, checkedAt: Date.now(), error: undefined };
      return null;
    }
    if (!res.ok) throw new Error(`${def.name}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(`${file}.tmp`, buf);
    fs.renameSync(`${file}.tmp`, file);
    remoteVersion = res.headers.get('etag') ?? sha256File(file);
    states[def.name] = { version: remoteVersion, size: buf.length, updatedAt: Date.now(), checkedAt: Date.now() };
  }
  return prev ? `${def.name} 已更新（${fmtSize(prev.size)} → ${fmtSize(states[def.name].size)}）` : `${def.name} 首次下载`;
}

function fmtSize(n: number) {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;
}

function diffGeoSite(before: GeoSite | null, after: GeoSite | null): string[] {
  if (!before || !after) return [];
  const a = new Set(before.categories.keys());
  const b = new Set(after.categories.keys());
  const added = [...b].filter((k) => !a.has(k));
  const removed = [...a].filter((k) => !b.has(k));
  const out: string[] = [];
  const sa = before.stats();
  const sb = after.stats();
  out.push(`GeoSite 域名 ${sa.domains} → ${sb.domains}（${sb.domains - sa.domains >= 0 ? '+' : ''}${sb.domains - sa.domains}）`);
  if (added.length) out.push(`GeoSite 新增分类 ${added.length} 个：${added.slice(0, 12).join('、')}${added.length > 12 ? ' …' : ''}`);
  if (removed.length) out.push(`GeoSite 删除分类 ${removed.length} 个：${removed.slice(0, 12).join('、')}${removed.length > 12 ? ' …' : ''}`);
  return out;
}

let running: Promise<void> | null = null;

export function updateIntel(trigger: ChangeLogEntry['trigger']): Promise<void> {
  running ??= (async () => {
    intel.status.running = true;
    notify();
    const states = kvGet<Record<string, AssetState>>('intel:assets')?.value ?? {};
    const items: string[] = [];
    const reload = new Set<string>();
    fs.mkdirSync(dir(), { recursive: true });
    try {
      for (const def of ASSETS) {
        intel.status.phase = `检查 ${def.name}`;
        notify();
        try {
          const change = await updateAsset(def, states);
          if (change) {
            items.push(change);
            reload.add(def.name);
          }
        } catch (e) {
          states[def.name] = { ...(states[def.name] ?? { version: '', size: 0, updatedAt: 0 }), checkedAt: Date.now(), error: String((e as Error).message) };
          items.push(`${def.name} 更新失败：${(e as Error).message}`);
        }
        kvSet('intel:assets', states);
        intel.status.assets = states;
      }
      const oldGeoSite = intel.geosite;
      if (reload.size) await loadIndexes(reload);
      if (reload.has('geosite.dat')) items.push(...diffGeoSite(oldGeoSite, intel.geosite));

      intel.status.phase = '同步 blackmatrix7';
      notify();
      try {
        const r = await syncBm7((done, total) => {
          intel.status.bm7.progress = `${done}/${total}`;
          if (done % 20 === 0 || done === total) notify();
        });
        intel.status.bm7.error = undefined;
        if (r.changed) {
          await loadIndexes(new Set(['bm7']));
          const parts = [
            r.added.length && `新增 ${r.added.length}`,
            r.updated.length && `更新 ${r.updated.length}`,
            r.removed.length && `删除 ${r.removed.length}`,
          ].filter(Boolean);
          items.push(`blackmatrix7 规则：${parts.join('，')}${r.updated.length && r.updated.length <= 12 ? `（${r.updated.join('、')}）` : ''}`);
        }
        if (r.failed.length) items.push(`blackmatrix7 有 ${r.failed.length} 个目录拉取失败，下次重试`);
      } catch (e) {
        intel.status.bm7.error = (e as Error).message;
        items.push(`blackmatrix7 同步失败：${(e as Error).message}`);
      }
      intel.status.bm7.progress = undefined;
      intel.status.bm7.syncedAt = kvGet<{ syncedAt: number }>('bm7:state')?.value.syncedAt ?? 0;

      const log = kvGet<ChangeLogEntry[]>('intel:changelog')?.value ?? [];
      log.unshift({ at: Date.now(), trigger, items: items.length ? items : ['全部数据已是最新，无变化'] });
      kvSet('intel:changelog', log.slice(0, 30));
      intel.status.lastRunAt = Date.now();
    } finally {
      intel.status.running = false;
      intel.status.phase = '';
      running = null;
      notify();
    }
  })();
  return running;
}

export async function initIntel(): Promise<void> {
  loadServices();
  intel.status.assets = kvGet<Record<string, AssetState>>('intel:assets')?.value ?? {};
  intel.status.bm7.syncedAt = kvGet<{ syncedAt: number }>('bm7:state')?.value.syncedAt ?? 0;
  intel.status.lastRunAt = kvGet<ChangeLogEntry[]>('intel:changelog')?.value[0]?.at ?? 0;
  await loadIndexes();
  const missing = ASSETS.some((a) => !fs.existsSync(fileOf(a.name))) || intel.bm7.meta.size === 0;
  if (missing || Date.now() - intel.status.lastRunAt > 24 * 3600 * 1000) {
    void updateIntel('startup').catch(() => undefined);
  }
}

export function intelChangelog(): ChangeLogEntry[] {
  return kvGet<ChangeLogEntry[]>('intel:changelog')?.value ?? [];
}
