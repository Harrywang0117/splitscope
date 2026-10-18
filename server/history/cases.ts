import type { LiveConn } from '../../shared/types.ts';
import { onRestored } from '../backup.ts';
import { db } from '../db.ts';
import { ipToInt, isIPv4 } from '../enrich/geoip.ts';
import { scopeOf } from '../enrich/scope.ts';
import { homeGroups } from './queries.ts';

/**
 * Misrouted traffic, kept as reusable cases. A connection becomes a case when
 *  - it violates one of your expectations ("*.alipay.com should go 国内"), or
 *  - the generic path decided it badly: domestic service proxied, foreign service direct,
 *    or it fell through to MATCH / the UDP catch-all.
 * Cases merge on reason × host × group; a case marked fixed that happens again reopens as "regressed".
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS expectations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    grp TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (kind, value)
  );
  CREATE TABLE IF NOT EXISTS cases (
    key TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    host TEXT NOT NULL,
    service TEXT NOT NULL,
    grp TEXT NOT NULL,
    rule TEXT NOT NULL,
    rule_payload TEXT NOT NULL,
    rule_index INTEGER NOT NULL,
    node TEXT NOT NULL,
    chain TEXT NOT NULL,
    expected TEXT NOT NULL,
    scope TEXT NOT NULL,
    country TEXT NOT NULL,
    target_ip TEXT NOT NULL,
    org TEXT NOT NULL,
    network TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    count INTEGER NOT NULL,
    devices TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    regressed INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    status_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS cases_last ON cases (last_seen);
`);

export type Reason = 'expect' | 'cn_proxy' | 'intl_direct' | 'fallback' | 'udp_fallback';
export type ExpKind = 'domain' | 'suffix' | 'keyword' | 'ip' | 'cidr';

export interface Expectation {
  id: number;
  kind: ExpKind;
  value: string;
  grp: string;
  note: string;
  source: string;
  created_at: number;
}

/* ---------- expectations ---------- */

let expCache: Expectation[] | null = null;
onRestored(() => (expCache = null));
const loadExp = () => (expCache ??= db.prepare('SELECT * FROM expectations ORDER BY id').all() as unknown as Expectation[]);

export function listExpectations() {
  return loadExp();
}

export function addExpectations(items: { kind: ExpKind; value: string; grp: string; note?: string; source?: string }[]) {
  const stmt = db.prepare(
    `INSERT INTO expectations (kind, value, grp, note, source, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (kind, value) DO UPDATE SET grp = excluded.grp, note = excluded.note, source = excluded.source`,
  );
  let n = 0;
  for (const it of items) {
    const kind = (['domain', 'suffix', 'keyword', 'ip', 'cidr'] as const).includes(it.kind) ? it.kind : 'domain';
    const value = String(it.value ?? '').trim().toLowerCase();
    if (!value || !it.grp) continue;
    stmt.run(kind, value, String(it.grp), String(it.note ?? ''), String(it.source ?? ''), Date.now());
    n++;
  }
  expCache = null;
  return n;
}

export function deleteExpectation(id: number) {
  db.prepare('DELETE FROM expectations WHERE id = ?').run(id);
  expCache = null;
}

function inCidr(ip: string, cidr: string) {
  const [base, b] = cidr.split('/');
  const bits = Number(b);
  if (!isIPv4(ip) || !isIPv4(base) || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(base) & mask) >>> 0);
}

/** Most specific expectation for a destination: exact domain > longest suffix > IP > CIDR > keyword. */
export function expectationFor(host: string, ip: string): Expectation | undefined {
  const h = host.toLowerCase();
  let best: { e: Expectation; score: number } | undefined;
  for (const e of loadExp()) {
    let score = 0;
    if (e.kind === 'domain' && h && h === e.value) score = 1000;
    else if (e.kind === 'suffix' && h && (h === e.value || h.endsWith(`.${e.value}`))) score = 500 + e.value.length;
    else if (e.kind === 'ip' && (ip === e.value || h === e.value)) score = 900;
    else if (e.kind === 'cidr' && (inCidr(ip, e.value) || inCidr(h, e.value))) score = 300 + Number(e.value.split('/')[1] ?? 0);
    else if (e.kind === 'keyword' && h && h.includes(e.value)) score = 100 + e.value.length;
    if (score && (!best || score > best.score)) best = { e, score };
  }
  return best?.e;
}

/** "@direct" / "@proxy" accept any group that ends direct / proxied. */
export function satisfies(c: Pick<LiveConn, 'group' | 'direct'>, grp: string) {
  if (grp === '@direct') return c.direct;
  if (grp === '@proxy') return !c.direct;
  return c.group === grp;
}

/* ---------- detection ---------- */

interface Hit {
  reason: Reason;
  conn: LiveConn;
  expected: string;
  scope: string;
}

const pending: Hit[] = [];

export function detectAnomalies(c: LiveConn): Reason[] {
  if (c.probe || c.self || c.relay || !c.group) return [];
  const ip = c.target?.ip ?? c.dstIp;
  const exp = expectationFor(c.host, ip);
  const scope = scopeOf(c.host, ip, c.target?.country ?? '');
  if (exp) {
    // your expectation is the final word: met -> nothing to report, missed -> one case
    if (satisfies(c, exp.grp)) return [];
    pending.push({ reason: 'expect', conn: c, expected: exp.grp, scope });
    return ['expect'];
  }
  const { domestic, foreign } = homeGroups();
  const generic = c.group === domestic || c.group === foreign || ['Match', 'Network', ''].includes(c.rule);
  const out: Reason[] = [];
  const rejected = /^REJECT/i.test(c.node) || /^REJECT/i.test(c.group);
  if (scope === 'cn' && !c.direct && !rejected && generic) out.push('cn_proxy');
  if (scope === 'intl' && c.direct && generic) out.push('intl_direct');
  if (c.fallback === 'match') out.push('fallback');
  if (c.fallback === 'udp') out.push('udp_fallback');
  for (const reason of out) {
    const guess = reason === 'cn_proxy' ? domestic : reason === 'intl_direct' ? foreign : scope === 'cn' ? domestic : scope === 'intl' ? foreign : '';
    // a guess equal to where it already went is no expectation at all
    pending.push({ reason, conn: c, expected: guess === c.group ? '' : guess, scope });
  }
  return out;
}

const getCase = db.prepare('SELECT devices, status FROM cases WHERE key = ?');
const upsertCase = db.prepare(`
  INSERT INTO cases (key, reason, host, service, grp, rule, rule_payload, rule_index, node, chain, expected, scope, country, target_ip, org, network,
    first_seen, last_seen, count, devices, status, regressed, status_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, NULL)
  ON CONFLICT (key) DO UPDATE SET
    last_seen = excluded.last_seen, count = count + excluded.count, devices = excluded.devices,
    service = CASE WHEN excluded.service <> '' THEN excluded.service ELSE service END,
    rule = excluded.rule, rule_payload = excluded.rule_payload, rule_index = excluded.rule_index,
    node = excluded.node, chain = excluded.chain, expected = excluded.expected,
    country = CASE WHEN excluded.country <> '' THEN excluded.country ELSE country END,
    target_ip = CASE WHEN excluded.target_ip <> '' THEN excluded.target_ip ELSE target_ip END,
    org = CASE WHEN excluded.org <> '' THEN excluded.org ELSE org END,
    status = CASE WHEN status = 'fixed' THEN 'open' ELSE status END,
    regressed = CASE WHEN status = 'fixed' THEN 1 ELSE regressed END
`);

/** Called inside the connection-log transaction. */
export function flushCases() {
  if (!pending.length) return;
  const hits = pending.splice(0);
  const merged = new Map<string, { hit: Hit; count: number; devices: Set<string>; first: number; last: number }>();
  for (const h of hits) {
    const host = h.conn.host || h.conn.target?.ip || h.conn.dstIp;
    const key = `${h.reason}|${host}|${h.conn.group}${h.reason === 'expect' ? `|${h.expected}` : ''}`;
    const m = merged.get(key);
    if (m) {
      m.count++;
      m.devices.add(h.conn.srcIp);
      m.last = Math.max(m.last, h.conn.start);
      m.hit = h;
    } else merged.set(key, { hit: h, count: 1, devices: new Set([h.conn.srcIp]), first: h.conn.start, last: h.conn.start });
  }
  for (const [key, m] of merged) {
    const prev = getCase.get(key) as { devices: string } | undefined;
    const devices = new Set<string>([...(prev ? (JSON.parse(prev.devices) as string[]) : []), ...m.devices]);
    const c = m.hit.conn;
    upsertCase.run(
      key,
      m.hit.reason,
      c.host || c.target?.ip || c.dstIp,
      c.service?.name ?? '',
      c.group,
      c.rule,
      c.rulePayload,
      c.ruleIndex,
      c.node,
      c.chain.join(' > '),
      m.hit.expected,
      m.hit.scope,
      c.target?.country ?? '',
      c.target?.ip ?? c.dstIp,
      c.target?.brand ?? c.target?.org ?? '',
      c.network,
      m.first,
      m.last,
      m.count,
      JSON.stringify([...devices].slice(0, 50)),
    );
  }
}

export function pruneCases(days: number) {
  // ignored cases stay: they record what you decided is fine
  db.prepare(`DELETE FROM cases WHERE last_seen < ? AND status <> 'ignored'`).run(Date.now() - days * 86_400_000);
}

/* ---------- queries ---------- */

export interface CaseRow {
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
  status_at: number | null;
}

export function listCases(f: { status?: string; reason?: string; q?: string; limit?: number; offset?: number; sort?: string }) {
  const w: string[] = ['1 = 1'];
  const args: (string | number)[] = [];
  if (f.status && f.status !== 'all') {
    w.push('status = ?');
    args.push(f.status);
  }
  if (f.reason) {
    w.push('reason = ?');
    args.push(f.reason);
  }
  if (f.q) {
    w.push('(host LIKE ? OR service LIKE ? OR grp LIKE ? OR rule_payload LIKE ? OR note LIKE ?)');
    for (let i = 0; i < 5; i++) args.push(`%${f.q}%`);
  }
  const order = f.sort === 'count' ? 'count DESC' : f.sort === 'first' ? 'first_seen DESC' : 'last_seen DESC';
  const sql = w.join(' AND ');
  const rows = db.prepare(`SELECT * FROM cases WHERE ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, Math.min(500, f.limit ?? 100), Math.max(0, f.offset ?? 0)) as unknown as CaseRow[];
  const total = (db.prepare(`SELECT count(*) n FROM cases WHERE ${sql}`).get(...args) as { n: number }).n;
  const counts = Object.fromEntries(
    (db.prepare(`SELECT status, reason, count(*) n FROM cases GROUP BY status, reason`).all() as { status: string; reason: string; n: number }[]).map((r) => [`${r.status}|${r.reason}`, r.n]),
  );
  return { total, rows, counts };
}

export function updateCases(keys: string[], patch: { status?: string; note?: string }) {
  const status = ['open', 'fixed', 'ignored'].includes(patch.status ?? '') ? patch.status : undefined;
  const stmt = db.prepare(
    `UPDATE cases SET status = coalesce(?, status), note = coalesce(?, note), status_at = CASE WHEN ? IS NULL THEN status_at ELSE ? END,
       regressed = CASE WHEN ? IS NULL THEN regressed ELSE 0 END WHERE key = ?`,
  );
  for (const k of keys) stmt.run(status ?? null, patch.note ?? null, status ?? null, Date.now(), status ?? null, k);
}

export function caseConnections(key: string) {
  const c = db.prepare('SELECT host, grp FROM cases WHERE key = ?').get(key) as { host: string; grp: string } | undefined;
  if (!c) return [];
  return db
    .prepare(`SELECT * FROM conn_log WHERE grp = ? AND (host = ? OR (host = '' AND (dst_ip = ? OR target_ip = ?))) ORDER BY start DESC LIMIT 50`)
    .all(c.grp, c.host, c.host, c.host);
}
