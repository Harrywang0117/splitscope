import os from 'node:os';
import { db, kvGet, kvSet } from './db.ts';

/**
 * Backup = what a person put in or would miss: device names, discovered device names,
 * expectations, cases (status and notes), rule drafts, saved analyses, retention settings. Traffic statistics,
 * the connection log and health samples describe one machine's view of the network and are left
 * out (they rebuild on their own), as are the downloaded rule/geo databases.
 */

const TABLES = ['devices', 'discovered', 'expectations', 'cases', 'analyses', 'drafts'] as const;
type Table = (typeof TABLES)[number];

export interface Backup {
  app: 'splitscope';
  format: 1;
  exportedAt: number;
  from: string;
  settings: unknown;
  tables: Partial<Record<Table, Record<string, unknown>[]>>;
}

/** in-memory caches of restored tables register here to be dropped after a restore */
const restoredHooks: (() => void)[] = [];
export const onRestored = (fn: () => void) => void restoredHooks.push(fn);

const tableExists = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

export function makeBackup(): Backup {
  const tables: Backup['tables'] = {};
  for (const t of TABLES) if (tableExists(t)) tables[t] = db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
  return { app: 'splitscope', format: 1, exportedAt: Date.now(), from: os.hostname(), settings: kvGet('settings')?.value ?? null, tables };
}

/**
 * Merges a backup into this database. Newer edits win per row, so restoring an older backup over
 * a running site does not undo changes made since; expectations merge on (kind, value) and saved
 * analyses on (created_at, query), so running it twice adds nothing.
 */
export function restoreBackup(b: Backup): Record<string, number> {
  // backups from before the rename say 'route-lens'
  if ((b?.app !== 'splitscope' && (b?.app as string) !== 'route-lens') || b.format !== 1 || typeof b.tables !== 'object') throw new Error('不是分流镜（Splitscope）的备份文件');
  const counts: Record<string, number> = {};
  const cols = (t: string) => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));

  const upsert: Record<Table, { skip?: string[]; sql: (c: string[]) => string }> = {
    devices: { sql: (c) => `INSERT INTO devices (${c}) VALUES (${c.map(() => '?')}) ON CONFLICT(key) DO UPDATE SET ${set(c, 'key')} WHERE excluded.updated_at > devices.updated_at` },
    discovered: { sql: (c) => `INSERT INTO discovered (${c}) VALUES (${c.map(() => '?')}) ON CONFLICT(key) DO UPDATE SET ${set(c, 'key')} WHERE excluded.updated_at > discovered.updated_at` },
    expectations: {
      skip: ['id'],
      sql: (c) => `INSERT INTO expectations (${c}) VALUES (${c.map(() => '?')}) ON CONFLICT(kind, value) DO UPDATE SET grp = excluded.grp, note = excluded.note WHERE excluded.created_at > expectations.created_at`,
    },
    cases: {
      sql: (c) =>
        `INSERT INTO cases (${c}) VALUES (${c.map(() => '?')}) ON CONFLICT(key) DO UPDATE SET
           status = CASE WHEN coalesce(excluded.status_at, 0) > coalesce(cases.status_at, 0) THEN excluded.status ELSE cases.status END,
           note = CASE WHEN cases.note = '' THEN excluded.note ELSE cases.note END,
           status_at = max(coalesce(excluded.status_at, 0), coalesce(cases.status_at, 0)),
           first_seen = min(excluded.first_seen, cases.first_seen)
         WHERE coalesce(excluded.status_at, 0) > coalesce(cases.status_at, 0)
            OR (cases.note = '' AND excluded.note <> '')
            OR excluded.first_seen < cases.first_seen`,
    },
    drafts: {
      skip: ['id'],
      sql: (c) => `INSERT INTO drafts (${c}) VALUES (${c.map(() => '?')}) ON CONFLICT(kind, value) DO UPDATE SET ${set(c, 'kind')} WHERE excluded.updated_at > drafts.updated_at`,
    },
    analyses: { skip: ['id'], sql: (c) => `INSERT INTO analyses (${c}) SELECT ${c.map(() => '?')} WHERE NOT EXISTS (SELECT 1 FROM analyses WHERE created_at = ? AND query = ?)` },
  };

  db.exec('BEGIN');
  try {
    for (const t of TABLES) {
      const rows = b.tables[t];
      if (!Array.isArray(rows) || !rows.length || !tableExists(t)) continue;
      const have = cols(t);
      const spec = upsert[t];
      const c = Object.keys(rows[0]).filter((k) => have.has(k) && !spec.skip?.includes(k));
      const stmt = db.prepare(spec.sql(c));
      let n = 0;
      for (const r of rows) {
        const vals = c.map((k) => (r[k] ?? null) as string | number | null);
        if (t === 'analyses') vals.push(r.created_at as number, r.query as string);
        n += Number(stmt.run(...vals).changes);
      }
      counts[t] = n;
    }
    if (b.settings && typeof b.settings === 'object' && !kvGet('settings')) kvSet('settings', b.settings);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  for (const fn of restoredHooks) fn();
  return counts;
}

function set(cols: string[], key: string) {
  return cols
    .filter((c) => c !== key)
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
}
