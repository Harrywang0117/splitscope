import { db, kvGet, kvSet } from '../db.ts';
// the tables below are created when these load
import './store.ts';
import './connlog.ts';

/**
 * Relay hops (see isRelay in mihomo/connStore.ts) were counted as traffic of their own until
 * 2026-10, doubling every chained connection. This takes them out of what was already recorded,
 * once: they are the only rows without a rule, and in the hourly table the only ones without a
 * source as well. The minute table has no such columns, so each policy group's minutes keep the
 * non-relay share of that hour (exact for groups that only ever carried relays, like a
 * dialer-proxy group, and close for the rest).
 */
export function dropRelayHistory(): { connLog: number; hours: number; minutes: number; cases: number } | null {
  const KEY = 'cleanup:relay';
  if (kvGet(KEY)) return null;
  db.exec('BEGIN');
  try {
    const minutes = db
      .prepare(
        `UPDATE traffic_min SET
           up = CAST(round(traffic_min.up * s.fu) AS INTEGER),
           down = CAST(round(traffic_min.down * s.fd) AS INTEGER),
           conns = CAST(round(traffic_min.conns * s.fc) AS INTEGER)
         FROM (
           SELECT hour, grp,
             coalesce(sum(CASE WHEN src = '' AND rule = '' THEN 0 ELSE up END) * 1.0 / nullif(sum(up), 0), 0) AS fu,
             coalesce(sum(CASE WHEN src = '' AND rule = '' THEN 0 ELSE down END) * 1.0 / nullif(sum(down), 0), 0) AS fd,
             coalesce(sum(CASE WHEN src = '' AND rule = '' THEN 0 ELSE conns END) * 1.0 / nullif(sum(conns), 0), 0) AS fc
           FROM traffic_hour GROUP BY hour, grp HAVING max(src = '' AND rule = '') = 1
         ) AS s
         WHERE traffic_min.minute / 60 = s.hour AND traffic_min.grp = s.grp`,
      )
      .run().changes;
    db.exec('DELETE FROM traffic_min WHERE up = 0 AND down = 0 AND conns = 0');
    const hours = db.prepare(`DELETE FROM traffic_hour WHERE src = '' AND rule = ''`).run().changes;
    const connLog = db.prepare(`DELETE FROM conn_log WHERE inbound = 'Inner' AND rule = ''`).run().changes;
    const cases = db.prepare(`DELETE FROM cases WHERE rule = ''`).run().changes;
    kvSet(KEY, { at: Date.now(), connLog, hours, minutes, cases });
    db.exec('COMMIT');
    return { connLog: Number(connLog), hours: Number(hours), minutes: Number(minutes), cases: Number(cases) };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
