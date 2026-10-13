import crypto from 'node:crypto';
import os from 'node:os';
import { db } from './db.ts';

/**
 * Only one process may write a given database: two would each add the same traffic deltas and
 * case counts. The owner keeps a heartbeat row; a second process sees a fresh heartbeat that is
 * not its own and stops before starting any background work. A clean shutdown clears the row so a
 * redeploy can start at once; after a crash the next start waits until the heartbeat goes stale.
 */

const BEAT = 15_000;
const STALE = 45_000;
const KEY = 'instance';
const me = { id: crypto.randomUUID(), pid: process.pid, host: os.hostname(), port: Number(process.env.PORT ?? 0) };

type Owner = typeof me & { beat: number };

function readOwner(): Owner | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(KEY) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as Owner) : null;
}

function writeOwner() {
  db.prepare(
    'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(KEY, JSON.stringify({ ...me, beat: Date.now() }), Date.now());
}

const describe = (o: Owner) => `pid ${o.pid} on ${o.host}${o.port ? ` (port ${o.port})` : ''}`;

/** Takes ownership of the database, waiting up to `waitMs` for another owner's heartbeat to go stale. */
export async function acquireInstance(waitMs = STALE + BEAT): Promise<void> {
  const deadline = Date.now() + waitMs;
  let told = false;
  for (;;) {
    db.exec('BEGIN IMMEDIATE');
    let other: Owner | null = null;
    try {
      const cur = readOwner();
      if (cur && cur.id !== me.id && Date.now() - cur.beat < STALE) other = cur;
      else writeOwner();
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    if (!other) break;
    if (Date.now() > deadline) {
      console.error(`[instance] another splitscope (${describe(other)}) is writing this database; exiting`);
      process.exit(1);
    }
    if (!told) console.warn(`[instance] waiting for ${describe(other)} to stop…`);
    told = true;
    await new Promise((r) => setTimeout(r, 5_000));
  }

  setInterval(() => {
    const cur = readOwner();
    // someone took over while this process was suspended (e.g. the Mac slept): step aside
    if (cur && cur.id !== me.id && Date.now() - cur.beat < STALE) {
      console.error(`[instance] database taken over by ${describe(cur)}; exiting`);
      process.exit(1);
    }
    writeOwner();
  }, BEAT).unref();
}

const hooks: (() => void)[] = [];

/** Work to finish on SIGINT / SIGTERM before the process exits (flushing buffers). */
export function onShutdown(fn: () => void) {
  hooks.push(fn);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    for (const fn of hooks) {
      try {
        fn();
      } catch (e) {
        console.error('[shutdown]', (e as Error).message);
      }
    }
    try {
      if (readOwner()?.id === me.id) db.prepare('DELETE FROM kv WHERE key = ?').run(KEY);
    } finally {
      process.exit(0);
    }
  });
}
