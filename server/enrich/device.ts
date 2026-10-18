import os from 'node:os';
import type { Device } from '../../shared/types.ts';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { readHostFiles } from '../hostFiles.ts';
import { discoveredFor, kindFromModel, modelName, rememberHint, runDiscovery } from './discover.ts';
import { hintFor } from './hints.ts';
import { isRandomMac, OuiDb } from './oui.ts';

export type { Device };

interface Alias {
  name: string;
  kind: string;
  note: string;
}

const LEASES = '/tmp/dhcp.leases';
const UCI_DHCP = '/etc/config/dhcp';
const ARP = '/proc/net/arp';

export const oui = new OuiDb();

const byIp = new Map<string, Device>();
let routerIps = new Set<string>(config.routerIps);
let lastRefresh = 0;
const listeners = new Set<() => void>();

export function onDevicesChanged(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function loadAliases(): Map<string, Alias> {
  const rows = db.prepare('SELECT key, name, kind, note FROM devices').all() as unknown as (Alias & { key: string })[];
  return new Map(rows.map((r) => [r.key, r]));
}

export function parseLeases(text: string) {
  const out: { expires: number; mac: string; ip: string; hostname: string }[] = [];
  for (const line of text.split('\n')) {
    const [expires, mac, ip, hostname] = line.trim().split(/\s+/);
    if (!ip || !mac) continue;
    out.push({ expires: Number(expires) * 1000, mac: mac.toLowerCase(), ip, hostname: hostname === '*' ? '' : hostname });
  }
  return out;
}

/** Parses `config host` sections from /etc/config/dhcp. */
export function parseUciHosts(text: string) {
  const hosts: { name: string; macs: string[]; ip: string }[] = [];
  let cur: { name: string; macs: string[]; ip: string } | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('config ')) {
      cur = line.startsWith('config host') ? { name: '', macs: [], ip: '' } : null;
      if (cur) hosts.push(cur);
      continue;
    }
    if (!cur) continue;
    const m = /^(option|list)\s+(\S+)\s+'?([^']*)'?$/.exec(line);
    if (!m) continue;
    const [, , key, value] = m;
    if (key === 'name') cur.name = value;
    else if (key === 'ip') cur.ip = value;
    else if (key === 'mac') cur.macs.push(...value.toLowerCase().split(/\s+/).filter(Boolean));
  }
  return hosts;
}

export function parseArp(text: string) {
  const out: { ip: string; mac: string; online: boolean; dev: string }[] = [];
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const [ip, , flags, mac, , dev] = cols;
    if (mac === '00:00:00:00:00:00') continue;
    out.push({ ip, mac: mac.toLowerCase(), online: (parseInt(flags, 16) & 0x2) !== 0, dev });
  }
  return out;
}

function ipToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return p.length === 4 ? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0 : -1;
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const a = ipToInt(ip);
  if (a < 0) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (ipToInt(base) & mask);
}

function specialOf(ip: string): Device['special'] {
  // no source at all: the kernel's own connections (relay hops, rule-set downloads)
  if (!ip || ip === '127.0.0.1' || routerIps.has(ip)) return 'router';
  if (inCidr(ip, '100.64.0.0', 10)) return 'wan';
  if (inCidr(ip, '172.16.0.0', 12)) return 'docker';
  return '';
}

const SPECIAL_LABEL: Record<string, string> = {
  router: '路由器本机',
  wan: '路由器 WAN',
  docker: 'Docker 容器',
};

/** Short vendor name: "Qingdao Haier Technology Co.,Ltd" -> "Qingdao Haier" */
function shortVendor(v: string): string {
  return v
    .replace(/\b(Co\.?,?\s*Ltd\.?|Corporation|Corp\.?|Inc\.?|Technologies|Technology|Electronics|Communication|Networks?|International|Limited|LLC|GmbH|S\.A\.)\b.*$/i, '')
    .replace(/[,.\s]+$/, '')
    .trim();
}

/** Readable names for the cryptic hostnames IoT gear and phones put in DHCP. */
const HOSTNAME_RULES: [RegExp, (m: RegExpExecArray) => string, string][] = [
  [/^EAP(\d+\w*)-(\w{2,})$/i, (m) => `锐捷无线 AP · ${m[2].slice(-4)}`, 'router'],
  [/^EG(\d+\w*(?:-\w)?)-(\w+)$/i, (m) => `锐捷网关 EG${m[1]}`, 'router'],
  [/^uplus-haier-(\w{4})/i, (m) => `海尔家电 · ${m[1]}`, 'iot'],
  [/^Lock_/i, () => '智能门锁', 'iot'],
  [/^dreame_vacuum_(\w+)/i, (m) => `追觅扫地机 ${m[1].toUpperCase()}`, 'iot'],
  [/^(roborock|rockrobo)[-_]/i, () => '石头扫地机', 'iot'],
  [/^(chuangmi|isa)[-_]?camera/i, () => '小米摄像头', 'camera'],
  [/^(yeelink|yeelight)/i, () => 'Yeelight 灯', 'iot'],
  [/^(lumi|aqara)[-_]/i, () => 'Aqara 网关', 'iot'],
  [/^(zhimi|xiaomi)[-_](airpurifier|airp)/i, () => '小米空气净化器', 'iot'],
  [/^(MiTV|MiBOX|xiaomi-tv)/i, () => '小米电视', 'tv'],
  [/^Xiaomi-(\w+)$/i, (m) => `小米 ${m[1]}`, 'phone'],
  [/^Redmi-?(\w+)/i, (m) => `Redmi ${m[1]}`, 'phone'],
  [/^HUAWEI[-_ ](.+)$/i, (m) => `华为 ${m[1].replace(/[-_]/g, ' ')}`, 'phone'],
  [/^HONOR[-_ ](.+)$/i, (m) => `荣耀 ${m[1].replace(/[-_]/g, ' ')}`, 'phone'],
  [/^(OPPO|vivo|OnePlus|realme|iQOO)[-_ ]?(.*)$/i, (m) => `${m[1]} ${m[2]}`.trim(), 'phone'],
  [/^Galaxy[-_ ](.+)$/i, (m) => `三星 Galaxy ${m[1]}`, 'phone'],
  [/^android-[0-9a-f]+$/i, () => '安卓设备', ''],
  [/^(iPhone|iPad)(-\d+)?$/i, (m) => m[1].replace(/^ip/i, 'iP'), ''],
  [/^(DESKTOP|LAPTOP)-\w+$/i, (m) => `Windows 电脑 ${m[0]}`, 'computer'],
  [/^(ESP|espressif)[-_]/i, () => 'ESP 物联网模块', 'iot'],
  [/^(Tapo|TL-IPC|IPC)/i, () => 'TP-Link 摄像头', 'camera'],
];

export function prettyHostname(hostname: string): { label: string; kind: string } | null {
  for (const [re, fmt, kind] of HOSTNAME_RULES) {
    const m = re.exec(hostname);
    if (m) return { label: fmt(m), kind };
  }
  return null;
}

/** OUI vendor -> what that vendor's gadget usually is in a home. */
const VENDOR_RULES: [RegExp, string, string][] = [
  [/Nintendo/i, 'Nintendo Switch', 'console'],
  [/Sony Interactive/i, 'PlayStation 设备', 'console'],
  [/Ruijie/i, '锐捷网络设备', 'router'],
  [/Haier/i, '海尔家电', 'iot'],
  [/Dreame/i, '追觅扫地机', 'iot'],
  [/Tp-?Link/i, 'TP-Link 设备', ''],
  [/Hikvision|Ezviz/i, '海康 / 萤石摄像头', 'camera'],
  [/Espressif/i, 'ESP 物联网模块', 'iot'],
  [/Fn-Link|AMPAK|AI-Link|Realtek|MediaTek|Texas Instruments|Silicon Labs|Hui Zhou Gaoshengda|Shenzhen.*Ai-Thinker/i, '物联网模块', 'iot'],
  [/Apple/i, '苹果设备', ''],
  [/Xiaomi|Beijing Xiaomi/i, '小米设备', ''],
  [/Huawei|Honor/i, '华为设备', ''],
  [/Samsung/i, '三星设备', ''],
  [/Amazon/i, 'Amazon 设备', 'iot'],
  [/Google/i, 'Google 设备', ''],
  [/Synology/i, '群晖 NAS', 'server'],
  [/Raspberry/i, '树莓派', 'server'],
  [/Intel|Liteon|Azurewave|Hon Hai|Foxconn/i, '电脑', 'computer'],
];

function vendorGuess(vendor: string): { label: string; kind: string } | null {
  for (const [re, label, kind] of VENDOR_RULES) if (re.test(vendor)) return { label, kind };
  return null;
}

function pickLabel(d: Omit<Device, 'label' | 'labelSource'>): [string, Device['labelSource']] {
  if (d.alias) return [d.alias, 'alias'];
  if (d.special) return [SPECIAL_LABEL[d.special], 'special'];
  if (d.friendly) return [d.friendly, 'friendly'];
  if (d.staticName) return [d.staticName, 'static'];
  if (d.hostname) return [prettyHostname(d.hostname)?.label ?? d.hostname, 'dhcp'];
  if (d.mdnsHost && !/^(iphone|ipad|android|localhost)(-\d+)?$/i.test(d.mdnsHost)) return [d.mdnsHost, 'mdns'];
  if (d.model) return [d.model, 'model'];
  if (d.mdnsHost) return [d.mdnsHost, 'mdns'];
  if (d.hint) return [`${d.hint}（推测）`, 'hint'];
  if (d.vendor) return [vendorGuess(d.vendor)?.label ?? `${shortVendor(d.vendor)} 设备`, 'vendor'];
  // randomized MACs are what phones, tablets and laptops use on Wi-Fi
  if (d.randomMac) return [`未识别的手机/电脑 .${d.ip.split('.').pop()}`, 'unknown'];
  return [`未知设备 .${d.ip.split('.').pop()}`, 'unknown'];
}

function build(partial: Partial<Device> & { ip: string }, aliases: Map<string, Alias>): Device {
  const mac = partial.mac ?? '';
  const key = mac || `ip:${partial.ip}`;
  const alias = aliases.get(key) ?? (mac ? aliases.get(`ip:${partial.ip}`) : undefined);
  const special = specialOf(partial.ip);
  const disc = discoveredFor(key);
  const live = special ? undefined : hintFor(partial.ip);
  if (live) rememberHint(key, partial.ip, live.label, live.kind);
  const hint = live?.label ?? disc?.hint;
  const base: Omit<Device, 'label' | 'labelSource'> = {
    key,
    ip: partial.ip,
    mac,
    hostname: partial.hostname ?? '',
    staticName: partial.staticName ?? '',
    vendor: mac && !(special === 'docker') ? oui.lookup(mac) : '',
    randomMac: mac ? isRandomMac(mac) && special !== 'docker' : false,
    alias: alias?.name ?? '',
    kind:
      alias?.kind ||
      (special === 'router' || special === 'wan' ? 'router' : '') ||
      (disc ? kindFromModel(disc) : '') ||
      (partial.hostname ? prettyHostname(partial.hostname)?.kind : '') ||
      // "MacBook-Pro", "DESKTOP-7H2K9QF", "iPhone", a static host called "PS5": the name says what it is
      kindFromModel({ hostname: [partial.hostname, partial.staticName].filter(Boolean).join(' ') }) ||
      (live?.kind ?? disc?.hintKind ?? '') ||
      (mac && !special ? (vendorGuess(oui.lookup(mac))?.kind ?? '') : ''),
    note: alias?.note ?? '',
    special,
    online: partial.online ?? false,
    leaseExpires: partial.leaseExpires ?? 0,
    friendly: disc?.friendly,
    mdnsHost: disc?.hostname,
    model: modelName(disc?.model),
    manufacturer: disc?.manufacturer,
    hint,
  };
  const [label, labelSource] = pickLabel(base);
  return { ...base, label, labelSource };
}

export async function refreshDevices(): Promise<void> {
  if (!config.hostFiles.startsWith('ssh:')) {
    // running on the router itself (network_mode: host): its interface addresses are "router"
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) if (a.family === 'IPv4') routerIps.add(a.address);
    }
  } else {
    routerIps = new Set(config.routerIps);
  }

  const files = await readHostFiles([LEASES, UCI_DHCP, ARP]);
  const aliases = loadAliases();
  const leases = parseLeases(files[LEASES] ?? '');
  const statics = parseUciHosts(files[UCI_DHCP] ?? '');
  const arp = parseArp(files[ARP] ?? '');

  const staticByMac = new Map<string, string>();
  const staticByIp = new Map<string, string>();
  for (const h of statics) {
    for (const m of h.macs) staticByMac.set(m, h.name);
    if (h.ip) staticByIp.set(h.ip, h.name);
  }

  const next = new Map<string, Device>();
  const arpByIp = new Map(arp.map((a) => [a.ip, a]));
  for (const l of leases) {
    const a = arpByIp.get(l.ip);
    next.set(
      l.ip,
      build(
        {
          ip: l.ip,
          mac: l.mac,
          hostname: l.hostname,
          staticName: staticByMac.get(l.mac) ?? staticByIp.get(l.ip) ?? '',
          online: a ? a.online && a.mac === l.mac : false,
          leaseExpires: l.expires,
        },
        aliases,
      ),
    );
  }
  for (const a of arp) {
    if (next.has(a.ip)) continue;
    next.set(
      a.ip,
      build({ ip: a.ip, mac: a.mac, staticName: staticByMac.get(a.mac) ?? staticByIp.get(a.ip) ?? '', online: a.online }, aliases),
    );
  }

  const changed =
    next.size !== byIp.size || [...next].some(([ip, d]) => JSON.stringify(byIp.get(ip)) !== JSON.stringify(d));
  byIp.clear();
  for (const [ip, d] of next) byIp.set(ip, d);
  lastRefresh = Date.now();
  if (changed) for (const fn of listeners) fn();
}

/** Device for a source IP; unknown IPs get a synthetic entry (still aliasable by IP). */
export function deviceForIp(ip: string): Device {
  return byIp.get(ip) ?? build({ ip }, loadAliasesCached());
}

let aliasCache: { at: number; map: Map<string, Alias> } = { at: 0, map: new Map() };
function loadAliasesCached() {
  if (Date.now() - aliasCache.at > 5000) aliasCache = { at: Date.now(), map: loadAliases() };
  return aliasCache.map;
}

export function listDevices(extraIps: Iterable<string> = []): Device[] {
  const all = new Map(byIp);
  for (const ip of extraIps) if (!all.has(ip)) all.set(ip, deviceForIp(ip));
  return [...all.values()].sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
}

export function saveAlias(key: string, alias: Alias): void {
  db.prepare(
    `INSERT INTO devices (key, name, kind, note, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET name = excluded.name, kind = excluded.kind, note = excluded.note, updated_at = excluded.updated_at`,
  ).run(key, alias.name.trim(), alias.kind, alias.note.trim(), Date.now());
  aliasCache.at = 0;
  // re-label in place, then notify
  const aliases = loadAliases();
  for (const [ip, d] of byIp) byIp.set(ip, build(d, aliases));
  for (const fn of listeners) fn();
}

/** mDNS/SSDP scan of every known LAN device; relabels and notifies when something new was learned. */
export async function discoverDevices(): Promise<number> {
  const targets = new Map<string, string>();
  for (const [ip, d] of byIp) if (!d.special) targets.set(ip, d.key);
  const n = await runDiscovery(targets);
  if (n) {
    const aliases = loadAliases();
    for (const [ip, d] of byIp) byIp.set(ip, build(d, aliases));
    for (const fn of listeners) fn();
  }
  return n;
}

export function devicesUpdatedAt() {
  return lastRefresh;
}
