import type { LiveConn } from '../../shared/types.ts';
import { db } from '../db.ts';
import { onShutdown } from '../instance.ts';
import { scopeOf } from '../enrich/scope.ts';

/**
 * Traffic history. Live connections report byte deltas every second; they are summed in memory and
 * written once a minute into
 *  - traffic_min:  minute × policy group (direct flag)              → trend charts, kept 8 days
 *  - traffic_hour: hour × device × host × group × node × rule × net → rankings, checkup, kept 31 days
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS traffic_hour (
    hour INTEGER NOT NULL,
    src TEXT NOT NULL,
    host TEXT NOT NULL,
    grp TEXT NOT NULL,
    node TEXT NOT NULL,
    rule TEXT NOT NULL,
    network TEXT NOT NULL,
    service TEXT NOT NULL,
    svc_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    fallback TEXT NOT NULL,
    direct INTEGER NOT NULL,
    scope TEXT NOT NULL,
    country TEXT NOT NULL,
    up INTEGER NOT NULL DEFAULT 0,
    down INTEGER NOT NULL DEFAULT 0,
    conns INTEGER NOT NULL DEFAULT 0,
    last INTEGER NOT NULL,
    PRIMARY KEY (hour, src, host, grp, node, rule, network)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS traffic_hour_hour ON traffic_hour (hour);
  CREATE TABLE IF NOT EXISTS traffic_min (
    minute INTEGER NOT NULL,
    grp TEXT NOT NULL,
    direct INTEGER NOT NULL,
    up INTEGER NOT NULL DEFAULT 0,
    down INTEGER NOT NULL DEFAULT 0,
    conns INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (minute, grp)
  ) WITHOUT ROWID;
`);

const HOUR = 3_600_000;
const MIN = 60_000;
const KEEP_MIN = 8 * 24 * HOUR;
const KEEP_HOUR = 31 * 24 * HOUR;

interface Pending {
  conn: LiveConn;
  up: number;
  down: number;
  isNew: boolean;
}

const pending = new Map<string, Pending>();
const minuteAcc = new Map<string, { minute: number; grp: string; direct: number; up: number; down: number; conns: number }>();

/** Called by the live store for every byte delta; `isNew` once when the connection first appears. */
export function recordDelta(conn: LiveConn, up: number, down: number, isNew: boolean) {
  if (conn.probe || conn.self || conn.relay) return;
  if (!up && !down && !isNew) return;
  const p = pending.get(conn.id);
  if (p) {
    p.up += up;
    p.down += down;
    p.isNew ||= isNew;
  } else pending.set(conn.id, { conn, up, down, isNew });

  const minute = Math.floor(Date.now() / MIN);
  const grp = conn.group || conn.node || '?';
  const k = `${minute}|${grp}`;
  const m = minuteAcc.get(k);
  if (m) {
    m.up += up;
    m.down += down;
    m.conns += isNew ? 1 : 0;
  } else minuteAcc.set(k, { minute, grp, direct: conn.direct ? 1 : 0, up, down, conns: isNew ? 1 : 0 });
}

const upsertHour = db.prepare(`
  INSERT INTO traffic_hour (hour, src, host, grp, node, rule, network, service, svc_name, provider, fallback, direct, scope, country, up, down, conns, last)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (hour, src, host, grp, node, rule, network) DO UPDATE SET
    up = up + excluded.up, down = down + excluded.down, conns = conns + excluded.conns,
    last = max(last, excluded.last), service = excluded.service, svc_name = excluded.svc_name,
    provider = excluded.provider, fallback = excluded.fallback, direct = excluded.direct,
    scope = excluded.scope, country = excluded.country
`);
const upsertMin = db.prepare(`
  INSERT INTO traffic_min (minute, grp, direct, up, down, conns) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (minute, grp) DO UPDATE SET up = up + excluded.up, down = down + excluded.down, conns = conns + excluded.conns
`);

let lastFlush = Date.now();

export function flushHistory(): number {
  const now = Date.now();
  const hour = Math.floor(now / HOUR);
  const rows = [...pending.values()];
  const mins = [...minuteAcc.values()];
  pending.clear();
  minuteAcc.clear();
  if (!rows.length && !mins.length) return 0;
  db.exec('BEGIN');
  try {
    for (const p of rows) {
      const c = p.conn;
      const host = c.host || c.dstIp || c.target?.ip || '?';
      const ip = c.target?.ip ?? c.dstIp;
      upsertHour.run(
        hour,
        c.srcIp,
        host,
        c.group || c.node || '?',
        c.node || '?',
        c.rule ? `${c.rule}|${c.rulePayload}` : '',
        c.network,
        c.service?.id ?? '',
        c.service?.name ?? '',
        c.nodeProvider ?? '',
        c.fallback,
        c.direct ? 1 : 0,
        scopeOf(c.host, ip, c.target?.country ?? ''),
        c.target?.country ?? '',
        p.up,
        p.down,
        p.isNew ? 1 : 0,
        now,
      );
    }
    for (const m of mins) upsertMin.run(m.minute, m.grp, m.direct, m.up, m.down, m.conns);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  lastFlush = now;
  return rows.length;
}

export function pruneHistory() {
  const now = Date.now();
  db.prepare('DELETE FROM traffic_min WHERE minute < ?').run(Math.floor((now - KEEP_MIN) / MIN));
  db.prepare('DELETE FROM traffic_hour WHERE hour < ?').run(Math.floor((now - KEEP_HOUR) / HOUR));
}

export function historyStatus() {
  const r = db.prepare('SELECT min(hour) AS first, count(*) AS rows FROM traffic_hour').get() as { first: number | null; rows: number };
  return { since: r.first ? r.first * HOUR : 0, rows: r.rows, lastFlush };
}

export function startHistory() {
  setInterval(() => {
    try {
      flushHistory();
    } catch (e) {
      console.error('[history] flush failed:', (e as Error).message);
    }
  }, MIN);
  setInterval(() => pruneHistory(), HOUR);
  pruneHistory();
  // do not lose the last minute on a clean shutdown
  onShutdown(() => flushHistory());
}
