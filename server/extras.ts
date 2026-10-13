import fs from 'node:fs';
import path from 'node:path';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { config } from './config.ts';
import { kvGet, kvSet } from './db.ts';

/* ---------- node latency (mihomo delay test) ---------- */

export interface DelayResult {
  name: string;
  delay: number; // ms, -1 = timeout / error
  at: number;
}

const delays = new Map<string, DelayResult>(Object.entries(kvGet<Record<string, DelayResult>>('nodes:delay')?.value ?? {}));

export function lastDelays() {
  return Object.fromEntries(delays);
}

export async function testDelays(names: string[]): Promise<DelayResult[]> {
  const queue = [...new Set(names)].slice(0, 120);
  const out: DelayResult[] = [];
  const worker = async () => {
    for (let n = queue.shift(); n; n = queue.shift()) {
      let delay = -1;
      try {
        const res = await fetch(
          `${config.clashApi}/proxies/${encodeURIComponent(n)}/delay?timeout=5000&url=${encodeURIComponent('http://www.gstatic.com/generate_204')}`,
          { headers: config.clashSecret ? { Authorization: `Bearer ${config.clashSecret}` } : {}, signal: AbortSignal.timeout(7000) },
        );
        const j = (await res.json()) as { delay?: number };
        delay = res.ok && typeof j.delay === 'number' ? j.delay : -1;
      } catch {
        delay = -1;
      }
      const r = { name: n, delay, at: Date.now() };
      delays.set(n, r);
      out.push(r);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  kvSet('nodes:delay', Object.fromEntries(delays));
  return out;
}

/* ---------- favicons ---------- */

/*
 * Fetched from the site itself (https://<site>/favicon.ico) through the mihomo mixed port, so the
 * request follows the same routing as the household's own traffic and no third-party icon service
 * learns which sites are visited. Cached on disk; misses are remembered for a week.
 */

const agent = new ProxyAgent(config.mixedProxy);
const dir = () => path.join(config.dataDir, 'favicons');
const MISS_TTL = 7 * 24 * 3_600_000;
const inflight = new Map<string, Promise<{ buf: Buffer; type: string } | null>>();
let active = 0;
const waiters: (() => void)[] = [];

const SITE_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

function sniffType(buf: Buffer, header: string): string | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'image/x-icon';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 4).toString() === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString() === 'RIFF') return 'image/webp';
  const head = buf.subarray(0, 200).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return header.startsWith('image/') && !header.includes('html') ? header : null;
}

async function fetchIcon(site: string): Promise<{ buf: Buffer; type: string } | null> {
  for (const host of [site, `www.${site}`]) {
    try {
      const res = await undiciFetch(`https://${host}/favicon.ico`, {
        dispatcher: agent,
        headers: { 'user-agent': 'Mozilla/5.0 splitscope favicon', accept: 'image/*' },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 256 * 1024) continue;
      const type = sniffType(buf, res.headers.get('content-type') ?? '');
      if (type) return { buf, type };
    } catch {
      /* try the next host */
    }
  }
  return null;
}

export async function favicon(siteRaw: string): Promise<{ buf: Buffer; type: string } | null> {
  const site = siteRaw.toLowerCase();
  if (!SITE_RE.test(site)) return null;
  fs.mkdirSync(dir(), { recursive: true });
  const meta = path.join(dir(), `${site}.json`);
  const file = path.join(dir(), `${site}.bin`);
  if (fs.existsSync(meta)) {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8')) as { type: string | null; at: number };
    if (m.type && fs.existsSync(file)) return { buf: fs.readFileSync(file), type: m.type };
    if (!m.type && Date.now() - m.at < MISS_TTL) return null;
  }
  let p = inflight.get(site);
  if (!p) {
    p = (async () => {
      if (active >= 4) await new Promise<void>((r) => waiters.push(r));
      active++;
      try {
        const got = await fetchIcon(site);
        if (got) fs.writeFileSync(file, got.buf);
        fs.writeFileSync(meta, JSON.stringify({ type: got?.type ?? null, at: Date.now() }));
        return got;
      } finally {
        active--;
        waiters.shift()?.();
        inflight.delete(site);
      }
    })();
    inflight.set(site, p);
  }
  return p;
}
