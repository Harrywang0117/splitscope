import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { config } from '../config.ts';
import { db } from '../db.ts';
import { intel } from '../enrich/intel.ts';
import { mihomo } from '../mihomo/client.ts';
import { liveState } from '../mihomo/connStore.ts';
import { getSnapshot } from '../mihomo/snapshot.ts';
import type { Range } from './queries.ts';
import { historyStatus } from './store.ts';

/**
 * Once a minute: is the kernel API up and how fast, does its DNS answer, and how long does a tiny
 * request take through the direct path and through a proxy. -1 = failed. Kept 8 days.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS health (
    ts INTEGER PRIMARY KEY,
    api_ms INTEGER,
    dns_ms INTEGER,
    direct_ms INTEGER,
    proxy_ms INTEGER,
    live INTEGER NOT NULL,
    conns INTEGER NOT NULL
  );
`);

const DIRECT_URL = 'http://connect.rom.miui.com/generate_204';
const PROXY_URL = 'http://www.gstatic.com/generate_204';
const agent = new ProxyAgent(config.mixedProxy);

async function timed(fn: () => Promise<unknown>, timeout = 8000): Promise<number> {
  const t0 = performance.now();
  try {
    await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeout))]);
    return Math.round(performance.now() - t0);
  } catch {
    return -1;
  }
}

async function viaProxy(url: string) {
  const res = await undiciFetch(url, { dispatcher: agent, method: 'GET', signal: AbortSignal.timeout(8000) });
  await res.arrayBuffer();
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
}

export async function sampleHealth() {
  const [api, dns, direct, proxy] = await Promise.all([
    timed(() => mihomo.version()),
    timed(async () => {
      const r = await mihomo.dnsQuery('www.baidu.com');
      if (!r.Answer?.length) throw new Error('no answer');
    }),
    timed(() => viaProxy(DIRECT_URL)),
    timed(() => viaProxy(PROXY_URL)),
  ]);
  const live = liveState();
  db.prepare('INSERT OR REPLACE INTO health (ts, api_ms, dns_ms, direct_ms, proxy_ms, live, conns) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    Date.now(),
    api,
    dns,
    direct,
    proxy,
    live.connected ? 1 : 0,
    live.active.length,
  );
}

export function startHealth() {
  const run = () => void sampleHealth().catch((e) => console.error('[health]', (e as Error).message));
  setTimeout(run, 5000);
  setInterval(run, 60_000);
  setInterval(() => db.prepare('DELETE FROM health WHERE ts < ?').run(Date.now() - 8 * 24 * 3_600_000), 3_600_000);
}

const RANGE_MS: Record<Range, number> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

export function healthReport(range: Range) {
  const since = Date.now() - Math.min(RANGE_MS[range], 8 * 86_400_000);
  const rows = db.prepare('SELECT ts, api_ms, dns_ms, direct_ms, proxy_ms, live, conns FROM health WHERE ts >= ? ORDER BY ts').all(since) as {
    ts: number;
    api_ms: number;
    dns_ms: number;
    direct_ms: number;
    proxy_ms: number;
    live: number;
    conns: number;
  }[];
  // downsample to at most ~240 points so a 7-day chart stays light
  const step = Math.max(1, Math.ceil(rows.length / 240));
  const points: typeof rows = [];
  for (let i = 0; i < rows.length; i += step) {
    const chunk = rows.slice(i, i + step);
    const avg = (k: 'api_ms' | 'dns_ms' | 'direct_ms' | 'proxy_ms') => {
      const ok = chunk.filter((r) => r[k] >= 0);
      // a chunk where every sample failed stays a failure (-1)
      return ok.length ? Math.round(ok.reduce((s, r) => s + r[k], 0) / ok.length) : -1;
    };
    points.push({ ts: chunk[0].ts, api_ms: avg('api_ms'), dns_ms: avg('dns_ms'), direct_ms: avg('direct_ms'), proxy_ms: avg('proxy_ms'), live: Math.min(...chunk.map((r) => r.live)), conns: chunk[chunk.length - 1].conns });
  }
  const stat = (k: 'api_ms' | 'dns_ms' | 'direct_ms' | 'proxy_ms') => {
    const ok = rows.filter((r) => r[k] >= 0).map((r) => r[k]);
    const sorted = [...ok].sort((a, b) => a - b);
    return {
      uptime: rows.length ? ok.length / rows.length : 0,
      avg: ok.length ? Math.round(ok.reduce((s, v) => s + v, 0) / ok.length) : null,
      p95: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : null,
      last: rows.length ? rows[rows.length - 1][k] : null,
      failures: rows.length - ok.length,
    };
  };
  // gaps: minutes with no sample at all (this site itself was down)
  let gaps = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i].ts - rows[i - 1].ts > 150_000) gaps++;
  const snap = getSnapshot();
  return {
    samples: rows.length,
    gaps,
    points,
    api: stat('api_ms'),
    dns: stat('dns_ms'),
    direct: stat('direct_ms'),
    proxy: stat('proxy_ms'),
    targets: { direct: DIRECT_URL, proxy: PROXY_URL },
    jobs: {
      snapshot: { at: snap?.takenAt ?? 0, trigger: snap?.trigger ?? '', drift: !!snap?.drift },
      intel: { at: intel.status.lastRunAt, running: intel.status.running, errors: Object.values(intel.status.assets).filter((a) => a.error).length + (intel.status.bm7.error ? 1 : 0) },
      history: historyStatus().lastFlush,
    },
  };
}
