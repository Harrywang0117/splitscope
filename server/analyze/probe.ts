import net from 'node:net';
import type { ProbeResult, ProbeTarget, RuleRef } from '../../shared/types.ts';
import { config, mixedProxyUrl } from '../config.ts';
import { resolveHost } from '../enrich/dns.ts';
import { isIPv4 } from '../enrich/geoip.ts';
import { identifyHost, identifyIp, providerOf } from '../enrich/service.ts';
import { mihomo } from '../mihomo/client.ts';
import { parseLogLine, type LogMatch } from '../mihomo/logParser.ts';
import { udpCatchAll, type Snapshot } from '../mihomo/snapshot.ts';

/**
 * Real-engine probe: open a SOCKS5 CONNECT through the mihomo mixed port (no payload is sent),
 * then read the rule decision for that local source port from the kernel log stream
 * (falls back to /connections when the log line is missing).
 */

/**
 * Probing reads the rule decision from the kernel's info log and assumes rule mode. With a higher
 * log level every target would sit out the full timeout, and in global/direct mode the rules are
 * not consulted at all, so check before starting.
 */
export async function probeReadiness(): Promise<{ ok: boolean; logLevel: string; mode: string; problem?: string }> {
  const c = await mihomo.configs();
  const logLevel = String(c['log-level'] ?? '').toLowerCase();
  const mode = String(c.mode ?? '').toLowerCase();
  let problem: string | undefined;
  if (logLevel !== 'info' && logLevel !== 'debug')
    problem = `内核日志级别是「${logLevel || '未知'}」，分流测试要读 info 级日志才能拿到命中规则。请在 OpenClash 里把日志级别调回 info（或 debug）再测。`;
  else if (mode && mode !== 'rule') problem = `内核现在是「${mode}」模式，不按规则分流，测出来的结果没有参考意义。切回规则模式再测。`;
  return { ok: !problem, logLevel, mode, problem };
}

// mihomo only logs a direct connection once its dial finishes (a dead host times out after ~5s per IP)
const TIMEOUT = 20000;
const recentPorts = new Map<number, number>();

export function isProbeConnection(_srcIp: string, srcPort: number): boolean {
  const exp = recentPorts.get(srcPort);
  return !!exp && exp > Date.now();
}

/* ---------- shared log stream, kept open while probes run ---------- */

type Waiter = { host: string; resolve: (m: LogMatch) => void };
const waiters = new Map<number, Waiter>();
let ws: WebSocket | null = null;
let wsReady: Promise<void> | null = null;
let idleTimer: NodeJS.Timeout | null = null;

function ensureLogStream(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    ws?.close();
    ws = null;
    wsReady = null;
  }, 120000);
  if (wsReady) return wsReady;
  wsReady = new Promise<void>((resolve, reject) => {
    const base = config.clashApi.replace(/^http/, 'ws');
    const sock = new WebSocket(`${base}/logs?level=info&token=${encodeURIComponent(config.clashSecret)}`);
    ws = sock;
    const t = setTimeout(() => reject(new Error('log stream timeout')), 5000);
    sock.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    sock.onerror = () => {
      clearTimeout(t);
      reject(new Error('log stream error'));
    };
    sock.onclose = () => {
      if (ws === sock) {
        ws = null;
        wsReady = null;
      }
    };
    sock.onmessage = (ev) => {
      if (!waiters.size) return;
      try {
        const msg = JSON.parse(String(ev.data)) as { payload?: string };
        const m = msg.payload ? parseLogLine(msg.payload) : null;
        if (!m) return;
        const w = waiters.get(m.srcPort);
        if (w && m.dstHost.toLowerCase() === w.host.toLowerCase()) {
          waiters.delete(m.srcPort);
          w.resolve(m);
        }
      } catch {
        /* ignore */
      }
    };
  }).catch((e) => {
    wsReady = null;
    throw e;
  });
  return wsReady;
}

/* ---------- SOCKS5 ---------- */

function socksRequest(host: string, port: number): Buffer {
  const portBuf = Buffer.from([port >> 8, port & 255]);
  if (isIPv4(host)) {
    return Buffer.concat([Buffer.from([5, 1, 0, 1]), Buffer.from(host.split('.').map(Number)), portBuf]);
  }
  const name = Buffer.from(host);
  return Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, portBuf]);
}

function openSocks(
  host: string,
  port: number,
  onConnect: (localPort: number) => void,
): Promise<{ sock: net.Socket; localPort: number }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(mixedProxyUrl.port || 7893), mixedProxyUrl.hostname);
    sock.setTimeout(TIMEOUT);
    let stage = 0;
    let buf = Buffer.alloc(0);
    const fail = (e: Error) => {
      sock.destroy();
      reject(e);
    };
    sock.once('error', fail);
    sock.once('timeout', () => fail(new Error('socks timeout')));
    sock.on('connect', () => {
      recentPorts.set(sock.localPort!, Date.now() + 60000);
      onConnect(sock.localPort!);
      sock.write(Buffer.from([5, 1, 0]));
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk as Buffer]);
      if (stage === 0 && buf.length >= 2) {
        if (buf[0] !== 5 || buf[1] !== 0) return fail(new Error('socks auth rejected'));
        buf = buf.subarray(2);
        stage = 1;
        sock.write(socksRequest(host, port));
      }
      if (stage === 1 && buf.length >= 2) {
        stage = 2;
        sock.removeAllListeners('data');
        if (buf[1] !== 0) return fail(new Error(`socks reply ${buf[1]}`));
        // the tunnel is idle from here on; keep it open until the verdict arrives
        sock.setTimeout(0);
        resolve({ sock, localPort: sock.localPort! });
      }
    });
  });
}

/* ---------- probe ---------- */

function toRuleRef(snap: Snapshot, type: string, payload: string): RuleRef | undefined {
  const r = snap.running.rules.find((x) => x.type.toLowerCase() === type.toLowerCase() && x.payload.toLowerCase() === payload.toLowerCase());
  return r ? { type: r.type, payload: r.payload, index: r.index, target: r.target } : type ? { type, payload, index: -1, target: '' } : undefined;
}

async function findConnection(localPort: number) {
  const conns = await mihomo.connections();
  return conns.find((c) => Number(c.metadata.sourcePort) === localPort);
}

const sleep = (ms: number) => new Promise<undefined>((r) => setTimeout(() => r(undefined), ms));

export async function probeOne(target: ProbeTarget, snap: Snapshot, dstPort = 443): Promise<ProbeResult> {
  if (!target.test) return { target, status: 'skipped', error: target.note };
  const t0 = Date.now();
  await ensureLogStream();

  let localPort = 0;
  let sock: net.Socket | null = null;
  let resolveLog!: (m: LogMatch | null) => void;
  const logPromise = new Promise<LogMatch | null>((r) => (resolveLog = r));
  const timer = setTimeout(() => resolveLog(null), TIMEOUT);
  try {
    const opened = await openSocks(target.test, dstPort, (p) => {
      // registered at TCP connect, before the SOCKS request, so the log line cannot arrive first
      localPort = p;
      waiters.set(p, { host: target.test, resolve: (m) => resolveLog(m) });
    });
    sock = opened.sock;

    // normally the log line arrives within a few hundred ms; meanwhile poll /connections as a fallback
    let logLine: LogMatch | null | undefined = await Promise.race([logPromise, sleep(1500)]);
    let conn: Awaited<ReturnType<typeof findConnection>>;
    while (logLine === undefined && Date.now() - t0 < TIMEOUT) {
      conn = await findConnection(localPort).catch(() => undefined);
      if (conn) break;
      logLine = await Promise.race([logPromise, sleep(500)]);
    }
    if (logLine === undefined && !conn) logLine = await logPromise;
    if (logLine && !logLine.error && !conn) conn = await findConnection(localPort).catch(() => undefined);
    if (!logLine && !conn) return { target, status: 'timeout', error: '内核没有返回该连接的命中信息', ms: Date.now() - t0 };

    const rule = toRuleRef(snap, logLine?.ruleType ?? conn?.rule ?? '', logLine?.rulePayload ?? conn?.rulePayload ?? '');
    const chain = conn ? [...conn.chains].reverse() : [logLine!.group, ...(logLine!.node ? [logLine!.node] : [])];
    const result: ProbeResult = {
      target,
      status: logLine?.error ? 'dial-error' : 'ok',
      rule,
      group: chain[0],
      chain,
      nodeProvider: conn?.providerChains?.[0] || undefined,
      error: logLine?.error,
      ms: Date.now() - t0,
    };

    const udp = udpCatchAll(snap.running.rules);
    if (udp && rule && rule.index > udp.index) {
      result.udp = { type: udp.type, payload: udp.payload, index: udp.index, target: udp.target, group: udp.target };
    }
    return result;
  } catch (e) {
    return { target, status: 'error', error: (e as Error).message, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
    if (localPort) waiters.delete(localPort);
    sock?.destroy();
  }
}

/** Adds service name and reference resolution (best effort, does not affect the routing result). */
export async function annotate(r: ProbeResult, direct: boolean): Promise<ProbeResult> {
  const test = r.target.test;
  if (!test) return r;
  const ruleSet = r.rule?.type === 'RuleSet' ? r.rule.payload : undefined;
  if (isIPv4(test)) {
    const p = providerOf(test);
    r.resolved = p ? [p] : [];
    r.service = identifyIp(test, p, ruleSet);
    return r;
  }
  r.service = identifyHost(test, ruleSet);
  try {
    const res = await resolveHost(test, direct);
    r.resolved = res.ips.slice(0, 3).map((ip) => providerOf(ip)).filter((p) => !!p);
  } catch {
    r.resolved = [];
  }
  return r;
}
