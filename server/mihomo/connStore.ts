import { EventEmitter } from 'node:events';
import type { FallbackKind, LiveConn, LiveTick, ProviderInfo } from '../../shared/types.ts';
import { config } from '../config.ts';
import { resolveHost } from '../enrich/dns.ts';
import { recordHost } from '../enrich/hints.ts';
import { ipToInt } from '../enrich/geoip.ts';
import { identifyHost, identifyIp, providerOf } from '../enrich/service.ts';
import { isProbeConnection } from '../analyze/probe.ts';
import { isSelfConnection } from '../selfTraffic.ts';
import { logClose, logOpen } from '../history/connlog.ts';
import { recordDelta } from '../history/store.ts';
import { streamWs, type RawConnection } from './client.ts';
import { getSnapshot, type SnapshotRule } from './snapshot.ts';

const CLOSED_MAX = 5000;
const CLOSED_TTL = 30 * 60 * 1000;

const active = new Map<string, LiveConn>();
let closed: LiveConn[] = [];
let lastTs = 0;
let totals = { up: 0, down: 0, upSpeed: 0, downSpeed: 0, active: 0 };
let prevTotals = { up: 0, down: 0 };
/** relay bytes seen since this site started; the kernel's own totals include them */
let relayBytes = { up: 0, down: 0 };
let prevKernel = { up: 0, down: 0 };
let pendingPatches: LiveTick['patches'] = [];
let connected = false;

export const liveEvents = new EventEmitter();
liveEvents.setMaxListeners(100);

let fakeNets: { key: string; nets: { base: number; mask: number }[] } = { key: '', nets: [] };

/** Inside a fake-ip range: mihomo's default, FAKE_IP_RANGE, or dns.fake-ip-range from the yaml. */
export function isFakeIp(ip: string): boolean {
  const n = ipToInt(ip);
  if (n < 0) return false;
  const ranges = [...config.fakeIpRanges, getSnapshot()?.fakeIpRange ?? ''].filter(Boolean);
  const key = ranges.join(',');
  if (fakeNets.key !== key) {
    fakeNets = {
      key,
      nets: ranges.map((r) => {
        const [base, bits = '32'] = r.split('/');
        const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
        return { base: (ipToInt(base) & mask) >>> 0, mask };
      }),
    };
  }
  return fakeNets.nets.some((x) => ((n & x.mask) >>> 0) === x.base);
}

let ruleIndexCache: { hash: string; map: Map<string, SnapshotRule> } = { hash: '', map: new Map() };
export function findRule(type: string, payload: string): SnapshotRule | undefined {
  const snap = getSnapshot();
  if (!snap) return undefined;
  if (ruleIndexCache.hash !== snap.running.hash) {
    const map = new Map<string, SnapshotRule>();
    for (const r of snap.running.rules) {
      const k = `${r.type}|${r.payload}`.toLowerCase();
      if (!map.has(k)) map.set(k, r);
    }
    ruleIndexCache = { hash: snap.running.hash, map };
  }
  return ruleIndexCache.map.get(`${type}|${payload}`.toLowerCase());
}

export function isDirectNode(node: string): boolean {
  if (node === 'DIRECT') return true;
  const t = getSnapshot()?.proxyTypes[node];
  return t === 'Direct';
}

/**
 * A node with `dialer-proxy` reaches its server through another node, and the kernel lists that
 * hop as a connection of its own: type Inner, no source, no rule (front node -> landing server).
 * Its bytes are the carried connection's bytes again. Inner connections that did match a rule
 * are the kernel's own requests (rule-set downloads and the like) and count normally.
 */
export function isRelay(c: Pick<RawConnection, 'metadata' | 'rule'>): boolean {
  return c.metadata.type === 'Inner' && !c.rule;
}

function fallbackOf(rule: string): FallbackKind {
  if (rule === 'Match') return 'match';
  if (rule === 'Network') return 'udp';
  return '';
}

function enrich(c: RawConnection): LiveConn {
  const m = c.metadata;
  const host = m.host || m.sniffHost || '';
  recordHost(m.sourceIP, host);
  const chain = [...c.chains].reverse();
  const node = c.chains[0] ?? '';
  const direct = isDirectNode(node);
  const rule = findRule(c.rule, c.rulePayload);

  let targetIp = '';
  if (direct && m.remoteDestination) targetIp = m.remoteDestination;
  else if (m.destinationIP && !isFakeIp(m.destinationIP)) targetIp = m.destinationIP;
  const target: ProviderInfo | null = targetIp ? providerOf(targetIp) : null;
  const ruleSet = c.rule === 'RuleSet' ? c.rulePayload : undefined;
  const service = host ? identifyHost(host, ruleSet) : targetIp ? identifyIp(targetIp, target, ruleSet) : null;

  const conn: LiveConn = {
    id: c.id,
    start: Date.parse(c.start),
    network: m.network,
    inbound: m.type,
    srcIp: m.sourceIP,
    srcPort: Number(m.sourcePort),
    host,
    dstIp: m.destinationIP && !isFakeIp(m.destinationIP) ? m.destinationIP : '',
    dstPort: Number(m.destinationPort),
    rule: c.rule,
    rulePayload: c.rulePayload,
    ruleIndex: rule?.index ?? -1,
    fallback: fallbackOf(c.rule),
    chain,
    group: chain[0] ?? '',
    node,
    nodeProvider: c.providerChains?.[0] ?? '',
    direct,
    service,
    target,
    targetApprox: false,
    up: c.upload,
    down: c.download,
    upSpeed: 0,
    downSpeed: 0,
    probe: isProbeConnection(m.sourceIP, Number(m.sourcePort)) || undefined,
    self: isSelfConnection(m.sourceIP, Number(m.sourcePort)) || undefined,
    relay: isRelay(c) || undefined,
    seenAt: Date.now(),
  };

  if (!targetIp && host) {
    void resolveHost(host, direct).then((r) => {
      const ip = r.ips[0];
      if (!ip) return;
      const t = providerOf(ip);
      const svc = conn.service && conn.service.source !== 'site' ? conn.service : (identifyHost(host, ruleSet) ?? identifyIp(ip, t, ruleSet));
      conn.target = t;
      conn.targetApprox = true;
      conn.service = svc;
      pendingPatches.push({ id: conn.id, target: t, targetApprox: true, service: svc });
    });
  }
  return conn;
}

function onSnapshot(data: unknown) {
  const d = data as { connections?: RawConnection[] | null; uploadTotal?: number; downloadTotal?: number };
  const now = Date.now();
  const dt = lastTs ? Math.max((now - lastTs) / 1000, 0.2) : 1;
  lastTs = now;
  const tick: LiveTick = { added: [], updated: [], closed: [], patches: [], totals };
  const seen = new Set<string>();

  for (const c of d.connections ?? []) {
    seen.add(c.id);
    const cur = active.get(c.id);
    if (!cur) {
      const e = enrich(c);
      active.set(c.id, e);
      tick.added.push(e);
      recordDelta(e, c.upload, c.download, true);
      logOpen(e);
      if (e.relay) {
        relayBytes.up += c.upload;
        relayBytes.down += c.download;
      }
      continue;
    }
    const dUp = Math.max(0, c.upload - cur.up);
    const dDown = Math.max(0, c.download - cur.down);
    if (dUp || dDown) recordDelta(cur, dUp, dDown, false);
    if (cur.relay) {
      relayBytes.up += dUp;
      relayBytes.down += dDown;
    }
    const upSpeed = dUp / dt;
    const downSpeed = dDown / dt;
    if (c.upload !== cur.up || c.download !== cur.down || cur.upSpeed || cur.downSpeed) {
      cur.up = c.upload;
      cur.down = c.download;
      cur.upSpeed = upSpeed;
      cur.downSpeed = downSpeed;
      tick.updated.push([cur.id, cur.up, cur.down, Math.round(upSpeed), Math.round(downSpeed)]);
    }
  }
  for (const [id, c] of active) {
    if (seen.has(id)) continue;
    active.delete(id);
    c.closedAt = now;
    c.upSpeed = 0;
    c.downSpeed = 0;
    closed.push(c);
    logClose(c);
    tick.closed.push([id, now]);
  }
  if (closed.length > CLOSED_MAX * 1.1 || (closed[0] && now - (closed[0].closedAt ?? now) > CLOSED_TTL)) {
    closed = closed.filter((c) => now - (c.closedAt ?? now) < CLOSED_TTL).slice(-CLOSED_MAX);
  }

  const kUp = d.uploadTotal ?? 0;
  const kDown = d.downloadTotal ?? 0;
  if (kUp < prevKernel.up || kDown < prevKernel.down) {
    // the kernel restarted: its totals start over with only the connections open now
    relayBytes = { up: 0, down: 0 };
    for (const c of active.values()) {
      if (!c.relay) continue;
      relayBytes.up += c.up;
      relayBytes.down += c.down;
    }
  }
  prevKernel = { up: kUp, down: kDown };
  const up = Math.max(0, kUp - relayBytes.up);
  const down = Math.max(0, kDown - relayBytes.down);
  totals = {
    up,
    down,
    upSpeed: prevTotals.up ? Math.max(0, Math.round((up - prevTotals.up) / dt)) : 0,
    downSpeed: prevTotals.down ? Math.max(0, Math.round((down - prevTotals.down) / dt)) : 0,
    active: active.size,
  };
  prevTotals = { up, down };
  tick.totals = totals;
  tick.patches = pendingPatches;
  pendingPatches = [];
  liveEvents.emit('tick', tick);
}

export function startLive() {
  // the kernel sends a frame every second; 15 s of silence means the stream is dead
  streamWs(
    '/connections?interval=1000',
    onSnapshot,
    (up) => {
      connected = up;
      liveEvents.emit('status', up);
    },
    { staleMs: 15_000 },
  );
}

export function liveState() {
  return {
    connected,
    active: [...active.values()],
    closed: closed.slice(-1500),
    totals,
  };
}

/** Distinct source IPs seen recently (to list devices that have no DHCP lease). */
export function recentSourceIps(): Set<string> {
  const s = new Set<string>();
  for (const c of active.values()) s.add(c.srcIp);
  for (const c of closed) s.add(c.srcIp);
  return s;
}
