import type { LiveConn } from '../../shared/types.ts';
import { db, kvGet, kvSet } from '../db.ts';
import { scopeOf } from '../enrich/scope.ts';
import { onShutdown } from '../instance.ts';
import { detectAnomalies, flushCases, pruneCases } from './cases.ts';

/**
 * Every connection, one row: inserted when it appears, completed (end time, final bytes, late DNS
 * enrichment) when it closes. Written in small batches every few seconds. Kept `connlogDays`, and
 * never more than `connlogMaxRows` rows (oldest go first).
 *
 * Repeats are folded: a connection from the same device to the same host:port that hit the same
 * rule and went out the same way within a minute of an existing row is added to that row (`n`
 * counts them, bytes add up). Some apps open a new connection every second to the same place;
 * this keeps a week of such chatter to a row a minute without losing any distinct route.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS conn_log (
    id TEXT PRIMARY KEY,
    start INTEGER NOT NULL,
    end INTEGER,
    src TEXT NOT NULL,
    src_port INTEGER NOT NULL,
    host TEXT NOT NULL,
    dst_ip TEXT NOT NULL,
    dst_port INTEGER NOT NULL,
    network TEXT NOT NULL,
    inbound TEXT NOT NULL,
    rule TEXT NOT NULL,
    rule_payload TEXT NOT NULL,
    rule_index INTEGER NOT NULL,
    grp TEXT NOT NULL,
    chain TEXT NOT NULL,
    node TEXT NOT NULL,
    provider TEXT NOT NULL,
    direct INTEGER NOT NULL,
    fallback TEXT NOT NULL,
    service TEXT NOT NULL,
    svc_name TEXT NOT NULL,
    target_ip TEXT NOT NULL,
    country TEXT NOT NULL,
    asn INTEGER,
    org TEXT NOT NULL,
    scope TEXT NOT NULL,
    up INTEGER NOT NULL DEFAULT 0,
    down INTEGER NOT NULL DEFAULT 0,
    anomaly TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS conn_log_start ON conn_log (start);
  CREATE INDEX IF NOT EXISTS conn_log_src ON conn_log (src, start);
`);
// added after the first release: number of connections folded into the row
if (!(db.prepare('PRAGMA table_info(conn_log)').all() as { name: string }[]).some((c) => c.name === 'n'))
  db.exec('ALTER TABLE conn_log ADD COLUMN n INTEGER NOT NULL DEFAULT 1');

const FOLD_WINDOW = 60_000;
const bootedAt = Date.now();
const hasRow = db.prepare('SELECT 1 FROM conn_log WHERE id = ?');

export interface Settings {
  connlogDays: number;
  connlogMaxRows: number;
  caseDays: number;
}

export function getSettings(): Settings {
  return { connlogDays: 7, connlogMaxRows: 1_000_000, caseDays: 90, ...(kvGet<Partial<Settings>>('settings')?.value ?? {}) };
}

export function saveSettings(s: Partial<Settings>): Settings {
  const clamp = (v: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
  const cur = getSettings();
  const next = {
    connlogDays: clamp(s.connlogDays ?? cur.connlogDays, 1, 60, 7),
    connlogMaxRows: clamp(s.connlogMaxRows ?? cur.connlogMaxRows, 100_000, 5_000_000, 1_000_000),
    caseDays: clamp(s.caseDays ?? cur.caseDays, 7, 365, 90),
  };
  kvSet('settings', next);
  return next;
}

const opened = new Map<string, LiveConn>();
const closed = new Map<string, LiveConn>();
/** live connection id -> the row it was written to (its own id, or the row it was folded into) */
const rowOf = new Map<string, string>();
/** fold key -> the row repeats within FOLD_WINDOW of its start go to */
const folds = new Map<string, { row: string; start: number }>();

const foldKey = (c: LiveConn) => [c.srcIp, c.host || c.dstIp, c.dstPort, c.network, c.rule, c.rulePayload, c.group, c.node].join('|');

export function logOpen(c: LiveConn) {
  if (c.probe || c.self || c.relay) return;
  opened.set(c.id, c);
}

export function logClose(c: LiveConn) {
  if (c.probe || c.self || c.relay) return;
  closed.set(c.id, c);
}

const insert = db.prepare(`
  INSERT OR IGNORE INTO conn_log (id, start, src, src_port, host, dst_ip, dst_port, network, inbound, rule, rule_payload, rule_index,
    grp, chain, node, provider, direct, fallback, service, svc_name, target_ip, country, asn, org, scope, anomaly)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const bump = db.prepare('UPDATE conn_log SET n = n + 1 WHERE id = ?');
// bytes add up and the row ends with its last member, so the same statement serves folded rows
const finish = db.prepare(`
  UPDATE conn_log SET end = max(coalesce(end, 0), ?), up = up + ?, down = down + ?, target_ip = CASE WHEN ? <> '' THEN ? ELSE target_ip END,
    country = CASE WHEN ? <> '' THEN ? ELSE country END, asn = coalesce(?, asn), org = CASE WHEN ? <> '' THEN ? ELSE org END,
    service = CASE WHEN ? <> '' THEN ? ELSE service END, svc_name = CASE WHEN ? <> '' THEN ? ELSE svc_name END
  WHERE id = ?
`);

/** Writes (or folds) the row for a connection once; returns the row id. */
function place(c: LiveConn): string {
  const known = rowOf.get(c.id);
  if (known) return known;
  // still open from before a restart: it already has its own row (and was counted then)
  if (c.start < bootedAt && hasRow.get(c.id)) {
    rowOf.set(c.id, c.id);
    return c.id;
  }
  // every connection counts toward its case, folded or not
  const anomalies = detectAnomalies(c);
  const key = foldKey(c);
  const f = folds.get(key);
  if (f && c.start >= f.start && c.start - f.start < FOLD_WINDOW) {
    bump.run(f.row);
    rowOf.set(c.id, f.row);
    return f.row;
  }
  folds.set(key, { row: c.id, start: c.start });
  rowOf.set(c.id, c.id);
  insert.run(
    c.id,
    c.start,
    c.srcIp,
    c.srcPort,
    c.host,
    c.dstIp,
    c.dstPort,
    c.network,
    c.inbound,
    c.rule,
    c.rulePayload,
    c.ruleIndex,
    c.group,
    c.chain.join(' > '),
    c.node,
    c.nodeProvider,
    c.direct ? 1 : 0,
    c.fallback,
    c.service?.id ?? '',
    c.service?.name ?? '',
    c.target?.ip ?? '',
    c.target?.country ?? '',
    c.target?.asn ?? null,
    c.target?.brand ?? c.target?.org ?? '',
    scopeOf(c.host, c.target?.ip ?? c.dstIp, c.target?.country ?? ''),
    anomalies.join(','),
  );
  return c.id;
}

export function flushConnLog() {
  if (!opened.size && !closed.size) return;
  const open = [...opened.values()];
  const done = [...closed.values()];
  opened.clear();
  closed.clear();
  db.exec('BEGIN');
  try {
    for (const c of open) place(c);
    for (const c of done) {
      // opened and closed between two flushes: its open row was never written
      const row = place(c);
      rowOf.delete(c.id);
      const t = c.target;
      // duration measured on this site's clock, anchored to the kernel's start time, so a clock
      // difference between the router and the machine running the site never yields a negative span
      const lived = Math.max(0, (c.closedAt ?? Date.now()) - (c.seenAt ?? c.closedAt ?? Date.now()));
      finish.run(
        c.start + lived,
        c.up,
        c.down,
        t?.ip ?? '',
        t?.ip ?? '',
        t?.country ?? '',
        t?.country ?? '',
        t?.asn ?? null,
        t?.brand ?? t?.org ?? '',
        t?.brand ?? t?.org ?? '',
        c.service?.id ?? '',
        c.service?.id ?? '',
        c.service?.name ?? '',
        c.service?.name ?? '',
        row,
      );
    }
    const now = Date.now();
    if (folds.size > 2000) for (const [k, f] of folds) if (now - f.start > FOLD_WINDOW * 2) folds.delete(k);
    flushCases();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function pruneConnLog() {
  const s = getSettings();
  db.prepare('DELETE FROM conn_log WHERE start < ?').run(Date.now() - s.connlogDays * 86_400_000);
  // size cap: keep the newest connlogMaxRows rows
  const edge = db.prepare('SELECT start FROM conn_log ORDER BY start DESC LIMIT 1 OFFSET ?').get(s.connlogMaxRows) as { start: number } | undefined;
  if (edge) db.prepare('DELETE FROM conn_log WHERE start <= ?').run(edge.start);
  pruneCases(s.caseDays);
}

export function startConnLog() {
  setInterval(() => {
    try {
      flushConnLog();
    } catch (e) {
      console.error('[connlog] flush failed:', (e as Error).message);
    }
  }, 5_000);
  setInterval(pruneConnLog, 3_600_000);
  pruneConnLog();
  onShutdown(() => flushConnLog());
}

/* ---------- queries ---------- */

export interface ConnQuery {
  from?: number;
  to?: number;
  src?: string;
  group?: string;
  q?: string;
  fallback?: boolean;
  anomaly?: boolean;
  limit?: number;
  offset?: number;
}

function where(f: ConnQuery): { sql: string; args: (string | number)[] } {
  const w = ['start >= ?', 'start <= ?'];
  const args: (string | number)[] = [f.from ?? Date.now() - 86_400_000, f.to ?? Date.now()];
  if (f.src) {
    w.push('src = ?');
    args.push(f.src);
  }
  if (f.group) {
    w.push('grp = ?');
    args.push(f.group);
  }
  if (f.fallback) w.push(`fallback <> ''`);
  if (f.anomaly) w.push(`anomaly <> ''`);
  if (f.q) {
    w.push('(host LIKE ? OR dst_ip LIKE ? OR svc_name LIKE ? OR node LIKE ? OR rule_payload LIKE ? OR target_ip LIKE ?)');
    const like = `%${f.q}%`;
    args.push(like, like, like, like, like, like);
  }
  return { sql: w.join(' AND '), args };
}

export function queryConnLog(f: ConnQuery) {
  const { sql, args } = where(f);
  const limit = Math.min(500, Math.max(1, f.limit ?? 100));
  const rows = db.prepare(`SELECT * FROM conn_log WHERE ${sql} ORDER BY start DESC LIMIT ? OFFSET ?`).all(...args, limit, Math.max(0, f.offset ?? 0));
  const t = db.prepare(`SELECT count(*) n, coalesce(sum(n), 0) c FROM conn_log WHERE ${sql}`).get(...args) as { n: number; c: number };
  return { total: t.n, conns: t.c, rows };
}

export const CONN_COLUMNS = [
  ['start', '开始时间'],
  ['end', '结束时间'],
  ['src', '设备 IP'],
  ['src_port', '源端口'],
  ['host', '域名'],
  ['dst_ip', '目标 IP（连接）'],
  ['dst_port', '目标端口'],
  ['network', '网络'],
  ['inbound', '入站'],
  ['rule', '规则类型'],
  ['rule_payload', '规则内容'],
  ['rule_index', '规则序号'],
  ['grp', '策略组'],
  ['chain', '线路'],
  ['node', '节点'],
  ['provider', '订阅'],
  ['direct', '直连'],
  ['fallback', '兜底'],
  ['service', '服务 ID'],
  ['svc_name', '服务'],
  ['target_ip', '目标 IP'],
  ['country', '国家'],
  ['asn', 'ASN'],
  ['org', '运营商'],
  ['scope', '国内/境外'],
  ['n', '连接数'],
  ['up', '上传字节'],
  ['down', '下载字节'],
  ['anomaly', '异常'],
] as const;

/** Rows for export, oldest first, streamed in pages so a week of history never sits in memory at once. */
export function* iterateConnLog(f: ConnQuery): Generator<Record<string, unknown>> {
  const { sql, args } = where(f);
  // keyset paging on (start, id): rows sharing a millisecond are never skipped
  const stmt = db.prepare(`SELECT * FROM conn_log WHERE ${sql} AND (start > ? OR (start = ? AND id > ?)) ORDER BY start, id LIMIT 2000`);
  let after = -1;
  let afterId = '';
  for (;;) {
    const rows = stmt.all(...args, after, after, afterId) as Record<string, unknown>[];
    if (!rows.length) return;
    for (const r of rows) yield r;
    after = Number(rows[rows.length - 1].start);
    afterId = String(rows[rows.length - 1].id);
    if (rows.length < 2000) return;
  }
}

export function storageStats() {
  const count = (t: string) => (db.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n;
  const span = db.prepare('SELECT min(start) a, max(start) b FROM conn_log').get() as { a: number | null; b: number | null };
  const page = db.prepare('PRAGMA page_count').get() as { page_count: number };
  const size = db.prepare('PRAGMA page_size').get() as { page_size: number };
  return {
    dbBytes: page.page_count * size.page_size,
    connlog: { rows: count('conn_log'), conns: (db.prepare('SELECT coalesce(sum(n), 0) n FROM conn_log').get() as { n: number }).n, since: span.a ?? 0, until: span.b ?? 0 },
    cases: count('cases'),
    expectations: count('expectations'),
    trafficHour: count('traffic_hour'),
    trafficMin: count('traffic_min'),
  };
}
