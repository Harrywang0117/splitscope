import type { ProbeResult } from '../../shared/types.ts';
import { db } from '../db.ts';
import { ipToInt, isIPv4 } from '../enrich/geoip.ts';
import { findRule } from '../mihomo/connStore.ts';
import { getSnapshot } from '../mihomo/snapshot.ts';
import { addExpectations } from './cases.ts';

/**
 * Rule drafts: changes collected from tests and cases, waiting for the next yaml maintenance
 * window. Each remembers the rule its target stops at today, so the generated yaml can say where
 * each line has to go. Nothing here touches the router's config.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,                      -- domain | suffix | keyword | ip | cidr | asn
    value TEXT NOT NULL,
    grp TEXT NOT NULL,                       -- group the new rule sends it to
    from_grp TEXT NOT NULL DEFAULT '',       -- where it goes today
    hit_type TEXT NOT NULL DEFAULT '',       -- the rule it stops at today
    hit_payload TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | applied
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    applied_at INTEGER,
    UNIQUE (kind, value)
  );
`);

export type DraftKind = 'domain' | 'suffix' | 'keyword' | 'ip' | 'cidr' | 'asn';
const KINDS: DraftKind[] = ['domain', 'suffix', 'keyword', 'ip', 'cidr', 'asn'];

export interface DraftInput {
  kind: DraftKind;
  value: string;
  grp: string;
  from?: string;
  hitType?: string;
  hitPayload?: string;
  source?: string;
  note?: string;
}

/** Adds drafts (or re-targets existing ones); optionally records them as expectations too. */
export function addDrafts(items: DraftInput[], alsoExpect = true): { added: number; updated: number; expected: number } {
  const find = db.prepare('SELECT id FROM drafts WHERE kind = ? AND value = ?');
  const ins = db.prepare(
    `INSERT INTO drafts (kind, value, grp, from_grp, hit_type, hit_payload, source, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upd = db.prepare(
    `UPDATE drafts SET grp = ?, from_grp = CASE WHEN ? <> '' THEN ? ELSE from_grp END, hit_type = CASE WHEN ? <> '' THEN ? ELSE hit_type END,
       hit_payload = CASE WHEN ? <> '' THEN ? ELSE hit_payload END, source = ?, note = CASE WHEN ? <> '' THEN ? ELSE note END,
       status = 'pending', applied_at = NULL, updated_at = ? WHERE id = ?`,
  );
  let added = 0;
  let updated = 0;
  const valid: DraftInput[] = [];
  db.exec('BEGIN');
  try {
    for (const it of items) {
      const kind = KINDS.includes(it.kind) ? it.kind : null;
      const value = String(it.value ?? '').trim().toLowerCase();
      const grp = String(it.grp ?? '').trim();
      if (!kind || !value || !grp) continue;
      const now = Date.now();
      const [from, ht, hp, src, note] = [it.from ?? '', it.hitType ?? '', it.hitPayload ?? '', it.source ?? '', it.note ?? ''].map(String);
      const row = find.get(kind, value) as { id: number } | undefined;
      if (row) {
        upd.run(grp, from, from, ht, ht, hp, hp, src, note, note, now, row.id);
        updated++;
      } else {
        ins.run(kind, value, grp, from, ht, hp, src, note, now, now);
        added++;
      }
      valid.push({ ...it, kind, value, grp });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // the intent "X should go to G" is also an expectation: once the rule is in, a relapse shows up as a case
  const expected = alsoExpect
    ? addExpectations(
        valid
          .filter((d) => d.kind !== 'asn')
          .map((d) => ({ kind: d.kind as 'domain', value: d.value, grp: d.grp === 'DIRECT' ? '@direct' : d.grp, source: d.source || '规则草稿' })),
      )
    : 0;
  return { added, updated, expected };
}

interface DraftRow {
  id: number;
  kind: DraftKind;
  value: string;
  grp: string;
  from_grp: string;
  hit_type: string;
  hit_payload: string;
  source: string;
  note: string;
  status: 'pending' | 'applied';
  created_at: number;
  updated_at: number;
  applied_at: number | null;
}

const API_TYPE: Record<DraftKind, string> = { domain: 'Domain', suffix: 'DomainSuffix', keyword: 'DomainKeyword', ip: 'IPCIDR', cidr: 'IPCIDR', asn: 'IPASN' };

/**
 * Drafts with today's position of the rule they stop at (rule numbers shift when the config
 * changes) and whether the running config already has the drafted rule.
 */
export function listDrafts(status: 'pending' | 'applied' | 'all' = 'pending') {
  const rows = db
    .prepare(`SELECT * FROM drafts ${status === 'all' ? '' : 'WHERE status = ?'} ORDER BY created_at DESC`)
    .all(...(status === 'all' ? [] : [status])) as unknown as DraftRow[];
  const running = getSnapshot()?.running.rules ?? [];
  return rows.map((r) => {
    const hit = r.hit_type ? findRule(r.hit_type, r.hit_payload) : undefined;
    const payload = r.kind === 'ip' ? `${r.value}/32` : r.value;
    const inConfig = running.find((x) => x.type === API_TYPE[r.kind] && x.payload.toLowerCase() === payload && x.target === r.grp);
    return {
      ...r,
      hit: hit ? { index: hit.index, type: hit.type, payload: hit.payload, target: hit.target } : null,
      inConfig: inConfig ? inConfig.index : null,
    };
  });
}

/** After a test run: remember where each drafted target stops today (fills drafts added by hand). */
export function recordProbeHits(results: ProbeResult[]) {
  const stmt = db.prepare(
    `UPDATE drafts SET hit_type = ?, hit_payload = ?, from_grp = ?, updated_at = ? WHERE kind = ? AND value = ? AND status = 'pending'`,
  );
  for (const r of results) {
    if (!r.rule || !r.group) continue;
    stmt.run(r.rule.type, r.rule.payload, r.group, Date.now(), r.target.kind, r.target.value.toLowerCase());
  }
}

export interface DraftMark {
  status: 'pending' | 'applied';
  kind: DraftKind;
  value: string;
  grp: string;
}

/** For each host (or IP): the draft whose rule would catch it, most specific first, pending before applied. */
export function draftsCovering(hosts: string[]): Map<string, DraftMark> {
  const all = db.prepare('SELECT status, kind, value, grp FROM drafts').all() as unknown as DraftMark[];
  const out = new Map<string, DraftMark>();
  if (!all.length) return out;
  const rank = { domain: 0, ip: 0, suffix: 1, cidr: 2, keyword: 3, asn: 9 } as const;
  for (const h of new Set(hosts.map((x) => x.toLowerCase()))) {
    const hits = all.filter((d) => covers(d, h));
    hits.sort((a, b) => (a.status === b.status ? 0 : a.status === 'pending' ? -1 : 1) || rank[a.kind] - rank[b.kind] || b.value.length - a.value.length);
    if (hits[0]) out.set(h, hits[0]);
  }
  return out;
}

function covers(d: DraftMark, h: string): boolean {
  switch (d.kind) {
    case 'domain':
    case 'ip':
      return h === d.value;
    case 'suffix':
      return h === d.value || h.endsWith(`.${d.value}`);
    case 'keyword':
      return !isIPv4(h) && h.includes(d.value);
    case 'cidr': {
      if (!isIPv4(h)) return false;
      const [base, bits] = d.value.split('/');
      const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
      return ((ipToInt(h) & mask) >>> 0) === ((ipToInt(base) & mask) >>> 0);
    }
    default:
      return false;
  }
}

export function pendingDraftCount(): number {
  return (db.prepare(`SELECT count(*) n FROM drafts WHERE status = 'pending'`).get() as { n: number }).n;
}

export function setDraftStatus(ids: number[], status: 'pending' | 'applied') {
  const stmt = db.prepare('UPDATE drafts SET status = ?, applied_at = ?, updated_at = ? WHERE id = ?');
  const now = Date.now();
  for (const id of ids) stmt.run(status, status === 'applied' ? now : null, now, id);
}

export function deleteDraft(id: number) {
  db.prepare('DELETE FROM drafts WHERE id = ?').run(id);
}
