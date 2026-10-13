import dgram from 'node:dgram';
import { config } from '../config.ts';
import { db } from '../db.ts';

/**
 * Finds out what LAN devices call themselves, without any agent on them:
 *  - mDNS: reverse PTR (<ip>.in-addr.arpa -> "wangs-MacBook.local") and Bonjour service instances
 *    ("客厅._companion-link._tcp.local", TXT model=AppleTV14,1)
 *  - SSDP/UPnP: M-SEARCH, then the device description XML (friendlyName / manufacturer / modelName)
 * Results are kept per device (MAC when known) so a sleeping phone keeps its name.
 */

export interface Discovered {
  hostname?: string;
  friendly?: string;
  model?: string;
  manufacturer?: string;
  deviceType?: string;
  services?: string[];
  /** traffic-based guess, remembered so it survives restarts */
  hint?: string;
  hintKind?: string;
  updatedAt: number;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS discovered (
    key TEXT PRIMARY KEY,
    ip TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

const MDNS_ADDR = '224.0.0.251';
const SSDP_ADDR = '239.255.255.250';
const SERVICE_TYPES = [
  '_companion-link._tcp',
  '_device-info._tcp',
  '_airplay._tcp',
  '_raop._tcp',
  '_googlecast._tcp',
  '_hap._tcp',
  '_smb._tcp',
  '_ipp._tcp',
  '_printer._tcp',
  '_spotify-connect._tcp',
  '_rdlink._tcp',
  '_workstation._tcp',
  '_miio._udp',
];

/* ---------- DNS wire helpers ---------- */

function encodeName(name: string): number[] {
  return [...name.split('.').flatMap((l) => {
    const b = Buffer.from(l);
    return [b.length, ...b];
  }), 0];
}

function query(names: { name: string; type: number }[]): Buffer {
  const head = [0, 0, 0, 0, (names.length >> 8) & 255, names.length & 255, 0, 0, 0, 0, 0, 0];
  // class IN with the QU bit: ask for unicast replies so no port-5353 bind is needed
  const body = names.flatMap((q) => [...encodeName(q.name), 0, q.type, 0x80, 1]);
  return Buffer.from([...head, ...body]);
}

function readName(buf: Buffer, start: number): [string, number] {
  const parts: string[] = [];
  let off = start;
  let end = -1;
  for (let guard = 0; guard < 64 && off < buf.length; guard++) {
    const len = buf[off];
    if (len === 0) {
      if (end < 0) end = off + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      continue;
    }
    parts.push(buf.subarray(off + 1, off + 1 + len).toString('utf8'));
    off += len + 1;
  }
  return [parts.join('.'), end < 0 ? off : end];
}

interface Rr {
  name: string;
  type: number;
  data: string | string[];
}

export function parseDnsMessage(msg: Buffer): Rr[] {
  const out: Rr[] = [];
  let off = 12;
  const qd = msg.readUInt16BE(4);
  const total = msg.readUInt16BE(6) + msg.readUInt16BE(8) + msg.readUInt16BE(10);
  for (let i = 0; i < qd; i++) off = readName(msg, off)[1] + 4;
  for (let i = 0; i < total && off < msg.length; i++) {
    const [name, e] = readName(msg, off);
    const type = msg.readUInt16BE(e);
    const rdlen = msg.readUInt16BE(e + 8);
    const rd = e + 10;
    if (type === 12) out.push({ name, type, data: readName(msg, rd)[0] });
    else if (type === 16) {
      const items: string[] = [];
      for (let p = rd; p < rd + rdlen; ) {
        const l = msg[p];
        items.push(msg.subarray(p + 1, p + 1 + l).toString('utf8'));
        p += l + 1;
      }
      out.push({ name, type, data: items });
    }
    off = rd + rdlen;
  }
  return out;
}

/* ---------- mDNS ---------- */

type Partial_ = Omit<Discovered, 'updatedAt'>;

function mdnsScan(ips: string[], timeoutMs = 2500): Promise<Map<string, Partial_>> {
  return new Promise((resolve) => {
    const found = new Map<string, Partial_>();
    const get = (ip: string) => {
      let d = found.get(ip);
      if (!d) found.set(ip, (d = {}));
      return d;
    };
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => undefined);
    sock.on('message', (msg, rinfo) => {
      let rrs: Rr[];
      try {
        rrs = parseDnsMessage(msg);
      } catch {
        return;
      }
      const d = get(rinfo.address);
      for (const rr of rrs) {
        if (rr.type === 12 && rr.name.endsWith('.in-addr.arpa')) {
          const host = String(rr.data).replace(/\.local$/, '');
          if (host && host !== 'localhost') d.hostname = host;
        } else if (rr.type === 12) {
          const inst = String(rr.data);
          const m = /^(.*)\.(_[^.]+\._(?:tcp|udp))\.local$/.exec(inst);
          if (!m) continue;
          const [, instance, svc] = m;
          (d.services ??= []).includes(svc) || d.services!.push(svc);
          // the companion-link / airplay / cast instance name is the name the owner gave the device
          if (['_companion-link._tcp', '_airplay._tcp', '_googlecast._tcp', '_raop._tcp', '_hap._tcp'].includes(svc)) {
            const clean = instance.replace(/^[0-9A-F]{12}@/, '');
            if (svc === '_googlecast._tcp') continue; // instance is an id, the name comes in TXT fn=
            if (!d.friendly || svc === '_companion-link._tcp') d.friendly = clean;
          }
        } else if (rr.type === 16) {
          for (const kv of rr.data as string[]) {
            const [k, ...rest] = kv.split('=');
            const v = rest.join('=');
            if (!v) continue;
            if ((k === 'model' || k === 'rpMd' || k === 'am') && !d.model) d.model = v;
            if (k === 'md' && !d.model) d.model = v;
            if (k === 'fn') d.friendly = v;
          }
        }
      }
    });
    sock.bind(0, () => {
      if (config.mdnsInterface) {
        try {
          sock.setMulticastInterface(config.mdnsInterface);
        } catch {
          /* interface not present (dev machine) */
        }
      }
      const browse = query(SERVICE_TYPES.map((s) => ({ name: `${s}.local`, type: 12 })));
      sock.send(browse, 5353, MDNS_ADDR);
      for (const ip of ips) {
        const rev = query([{ name: `${ip.split('.').reverse().join('.')}.in-addr.arpa`, type: 12 }]);
        sock.send(rev, 5353, MDNS_ADDR);
        sock.send(rev, 5353, ip);
      }
      setTimeout(() => {
        sock.close();
        resolve(found);
      }, timeoutMs);
    });
  });
}

/* ---------- SSDP / UPnP ---------- */

function xmlTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(xml);
  return m?.[1]?.trim() || undefined;
}

function ssdpScan(timeoutMs = 2500): Promise<Map<string, Partial_>> {
  return new Promise((resolve) => {
    const locations = new Map<string, string>();
    const servers = new Map<string, string>();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => undefined);
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      const loc = /^location:\s*(\S+)/im.exec(text)?.[1];
      const server = /^server:\s*(.+)$/im.exec(text)?.[1]?.trim();
      if (loc && !locations.has(rinfo.address)) locations.set(rinfo.address, loc);
      if (server && !servers.has(rinfo.address)) servers.set(rinfo.address, server);
    });
    sock.bind(0, () => {
      if (config.mdnsInterface) {
        try {
          sock.setMulticastInterface(config.mdnsInterface);
        } catch {
          /* ignore */
        }
      }
      const m = Buffer.from(
        `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n`,
      );
      sock.send(m, 1900, SSDP_ADDR);
      setTimeout(async () => {
        sock.close();
        const out = new Map<string, Partial_>();
        await Promise.all(
          [...locations].map(async ([ip, url]) => {
            try {
              const u = new URL(url);
              if (u.hostname !== ip) return; // only trust descriptions served by the device itself
              const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
              const xml = (await res.text()).slice(0, 200_000);
              out.set(ip, {
                friendly: xmlTag(xml, 'friendlyName'),
                manufacturer: xmlTag(xml, 'manufacturer'),
                model: xmlTag(xml, 'modelName') ?? xmlTag(xml, 'modelDescription'),
                deviceType: xmlTag(xml, 'deviceType')?.replace(/^urn:[^:]+:device:/, '').replace(/:\d+$/, ''),
              });
            } catch {
              if (servers.has(ip)) out.set(ip, { model: servers.get(ip) });
            }
          }),
        );
        resolve(out);
      }, timeoutMs);
    });
  });
}

/* ---------- persistence ---------- */

const cache = new Map<string, Discovered>();
for (const r of db.prepare('SELECT key, data FROM discovered').all() as { key: string; data: string }[]) {
  cache.set(r.key, JSON.parse(r.data));
}

export function discoveredFor(key: string): Discovered | undefined {
  return cache.get(key);
}

/**
 * Runs both scans. `targets` maps IP -> storage key (MAC, or "ip:<addr>").
 * Newly seen fields overwrite old ones; fields not seen this time are kept.
 */
export async function runDiscovery(targets: Map<string, string>): Promise<number> {
  const ips = [...targets.keys()];
  const [mdns, ssdp] = await Promise.all([mdnsScan(ips), ssdpScan()]);
  const upsert = db.prepare(
    'INSERT INTO discovered (key, ip, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET ip = excluded.ip, data = excluded.data, updated_at = excluded.updated_at',
  );
  let changed = 0;
  for (const ip of new Set([...mdns.keys(), ...ssdp.keys()])) {
    const key = targets.get(ip);
    if (!key) continue;
    const fresh = { ...ssdp.get(ip), ...stripEmpty(mdns.get(ip) ?? {}) };
    if (!Object.keys(stripEmpty(fresh)).length) continue;
    const prev = cache.get(key);
    const next: Discovered = { ...prev, ...stripEmpty(fresh), updatedAt: Date.now() };
    if (prev && JSON.stringify({ ...prev, updatedAt: 0 }) === JSON.stringify({ ...next, updatedAt: 0 })) continue;
    cache.set(key, next);
    upsert.run(key, ip, JSON.stringify(next), next.updatedAt);
    changed++;
  }
  return changed;
}

/** Remembers a traffic-based guess for a device (only written when it changes). */
export function rememberHint(key: string, ip: string, hint: string, hintKind: string) {
  const prev = cache.get(key);
  if (prev?.hint === hint && prev?.hintKind === hintKind) return;
  const next: Discovered = { ...prev, hint, hintKind, updatedAt: Date.now() };
  cache.set(key, next);
  db.prepare(
    'INSERT INTO discovered (key, ip, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET ip = excluded.ip, data = excluded.data, updated_at = excluded.updated_at',
  ).run(key, ip, JSON.stringify(next), next.updatedAt);
}

function stripEmpty<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))) as Partial<T>;
}

/* ---------- friendly model names ---------- */

const APPLE_MODELS: Record<string, string> = {
  'Mac16,10': 'Mac mini (M4)',
  'Mac16,11': 'Mac mini (M4 Pro)',
  'Mac14,3': 'Mac mini (M2)',
  'Mac14,12': 'Mac mini (M2 Pro)',
  'Macmini9,1': 'Mac mini (M1)',
  'AppleTV14,1': 'Apple TV 4K（第 3 代）',
  'AppleTV11,1': 'Apple TV 4K（第 2 代）',
  'AppleTV6,2': 'Apple TV 4K',
  J255AP: 'Apple TV 4K（第 3 代）',
  'iPhone17,1': 'iPhone 16 Pro',
  'iPhone17,2': 'iPhone 16 Pro Max',
  'iPhone17,3': 'iPhone 16',
  'iPhone17,4': 'iPhone 16 Plus',
  'iPhone17,5': 'iPhone 16e',
  'iPhone16,1': 'iPhone 15 Pro',
  'iPhone16,2': 'iPhone 15 Pro Max',
  'iPhone15,4': 'iPhone 15',
  'iPhone15,5': 'iPhone 15 Plus',
  'iPhone15,2': 'iPhone 14 Pro',
  'iPhone15,3': 'iPhone 14 Pro Max',
  'iPhone14,7': 'iPhone 14',
  'iPhone14,8': 'iPhone 14 Plus',
  'iPhone14,2': 'iPhone 13 Pro',
  'iPhone14,3': 'iPhone 13 Pro Max',
  'iPhone14,5': 'iPhone 13',
  'iPhone14,4': 'iPhone 13 mini',
  AudioAccessory5: 'HomePod mini',
  'AudioAccessory5,1': 'HomePod mini',
  'AudioAccessory6,1': 'HomePod（第 2 代）',
};

export function modelName(model?: string): string | undefined {
  if (!model) return undefined;
  if (APPLE_MODELS[model]) return APPLE_MODELS[model];
  const fam = /^(iPhone|iPad|Mac|MacBookPro|MacBookAir|iMac|AppleTV|Watch|AudioAccessory)\d/.exec(model)?.[1];
  const FAM: Record<string, string> = {
    iPhone: 'iPhone',
    iPad: 'iPad',
    Mac: 'Mac',
    MacBookPro: 'MacBook Pro',
    MacBookAir: 'MacBook Air',
    iMac: 'iMac',
    AppleTV: 'Apple TV',
    Watch: 'Apple Watch',
    AudioAccessory: 'HomePod',
  };
  return fam ? `${FAM[fam]}（${model}）` : model;
}

export function kindFromModel(d: Pick<Discovered, 'model' | 'deviceType' | 'hostname' | 'friendly'>): string {
  const s = `${d.model ?? ''} ${d.deviceType ?? ''} ${d.hostname ?? ''} ${d.friendly ?? ''}`;
  if (/AppleTV|J255AP|MediaRenderer|\bTV\b|Chromecast|Shield/i.test(s)) return 'tv';
  if (/iPad|Tab/i.test(s)) return 'tablet';
  if (/iPhone|Android|Xiaomi-\d|Pixel|Galaxy|HUAWEI|Redmi|OPPO|vivo/i.test(s)) return 'phone';
  if (/PS5|PS4|PlayStation|Xbox|Switch/i.test(s)) return 'console';
  if (/Mac|MacBook|iMac|Windows|DESKTOP-|LAPTOP-|ThinkPad/i.test(s)) return 'computer';
  if (/Camera|IPC|NVR|DVR|Hikvision|EZVIZ|Dahua/i.test(s)) return 'camera';
  if (/HomePod|AudioAccessory|Speaker|Sonos/i.test(s)) return 'iot';
  if (/Printer|ipp/i.test(s)) return 'other';
  return '';
}
