import { db, kvGet, kvSet } from '../db.ts';
import { ipToInt } from '../enrich/geoip.ts';
import { proxyJson, proxyText } from '../net.ts';

/**
 * blackmatrix7/ios_rule_script (rule/Clash) — ~670 per-app rule lists with Chinese display names.
 * Synced incrementally: a dir is re-downloaded only when its git tree SHA changes.
 */

const REPO = 'blackmatrix7/ios_rule_script';
const RAW = `https://raw.githubusercontent.com/${REPO}/master/rule/Clash`;
const API = `https://api.github.com/repos/${REPO}/git/trees`;

/** Aggregate lists: huge and say nothing about which service a domain belongs to. */
const SKIP_DIR =
  /^(Advertising.*|China(Max.*|NoMedia|IPs.*|ASN|Media|Test.*)?|Global(Media)?|Proxy(Lite)?|Direct|Lan|Download|Hijacking|Privacy|PrivateTracker|BlockHttpDNS|Domestic|Game|Cloud|Scholar|Developer|Reject.*|AdGuardSDNSFilter|EasyPrivacy|EasyList.*)$/i;
const MAX_RULES = 20000;

export type Bm7Rule = [type: string, value: string];

export interface Bm7Dir {
  dir: string;
  sha: string;
  name: string;
  category: string;
  rules: Bm7Rule[];
  count: number;
}

export interface Bm7Meta {
  dir: string;
  name: string;
  category: string;
  count: number;
}

interface SyncState {
  clashSha: string;
  readmeSha: string;
  names: Record<string, { name: string; category: string }>;
  syncedAt: number;
}

export interface Bm7SyncResult {
  changed: boolean;
  added: string[];
  updated: string[];
  removed: string[];
  failed: string[];
}

/** Parses the category tables in rule/Clash/README.md into dir -> display name/category. */
export function parseReadme(md: string): Record<string, { name: string; category: string }> {
  const out: Record<string, { name: string; category: string }> = {};
  let category = '';
  for (const line of md.split('\n')) {
    const head = /^\|([^|[\]]+)\|\s*\|/.exec(line);
    if (head && !line.includes('](')) {
      category = head[1].replace(/^[^\p{L}\p{N}]+/u, '').trim();
      continue;
    }
    for (const m of line.matchAll(/\[([^\]]+)\]\(https:\/\/github\.com\/blackmatrix7\/ios_rule_script\/tree\/master\/rule\/Clash\/([^)]+)\)/g)) {
      const dir = decodeURIComponent(m[2]);
      if (!out[dir]) out[dir] = { name: m[1].trim(), category };
    }
  }
  return out;
}

export function parsePayload(text: string): Bm7Rule[] {
  const rules: Bm7Rule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*-\s*/, '').trim();
    if (!line || line.startsWith('#') || line === 'payload:') continue;
    const [type, value] = line.split(',');
    if (type && value && /^[A-Z0-9-]+$/.test(type)) rules.push([type, value.trim()]);
  }
  return rules;
}

async function fetchRules(dir: string): Promise<Bm7Rule[]> {
  const enc = encodeURIComponent(dir);
  let onlyMissing = true;
  for (const file of [`${enc}.yaml`, `${enc}_Classical.yaml`, `${enc}.list`]) {
    try {
      return parsePayload(await proxyText(`${RAW}/${enc}/${file}`, 20000));
    } catch (e) {
      if (!/HTTP 404/.test((e as Error).message)) onlyMissing = false;
    }
  }
  // some dirs only group sub-dirs (e.g. "Assassin'sCreed"); keep them as empty entries
  if (onlyMissing) return [];
  throw new Error(`no rule file for ${dir}`);
}

async function treeOf(sha: string) {
  return proxyJson<{ tree: { path: string; type: string; sha: string }[] }>(`${API}/${sha}`, {
    accept: 'application/vnd.github+json',
  });
}

export async function syncBm7(onProgress?: (done: number, total: number) => void): Promise<Bm7SyncResult> {
  const state = kvGet<SyncState>('bm7:state')?.value ?? { clashSha: '', readmeSha: '', names: {}, syncedAt: 0 };
  const root = await treeOf('master');
  const ruleSha = root.tree.find((t) => t.path === 'rule')?.sha;
  if (!ruleSha) throw new Error('blackmatrix7: rule/ not found');
  const clashSha = (await treeOf(ruleSha)).tree.find((t) => t.path === 'Clash')?.sha;
  if (!clashSha) throw new Error('blackmatrix7: rule/Clash not found');

  const existing = new Map(
    (db.prepare('SELECT dir, sha FROM bm7').all() as { dir: string; sha: string }[]).map((r) => [r.dir, r.sha]),
  );
  const result: Bm7SyncResult = { changed: false, added: [], updated: [], removed: [], failed: [] };
  if (clashSha === state.clashSha && existing.size) {
    kvSet('bm7:state', { ...state, syncedAt: Date.now() });
    return result;
  }

  const clash = await treeOf(clashSha);
  const readme = clash.tree.find((t) => t.path === 'README.md');
  if (readme && readme.sha !== state.readmeSha) {
    state.names = parseReadme(await proxyText(`${RAW}/README.md`));
    state.readmeSha = readme.sha;
  }

  const dirs = clash.tree.filter((t) => t.type === 'tree');
  const wanted = new Set(dirs.map((d) => d.path));
  for (const dir of existing.keys()) {
    if (!wanted.has(dir)) {
      db.prepare('DELETE FROM bm7 WHERE dir = ?').run(dir);
      result.removed.push(dir);
    }
  }

  const todo = dirs.filter((d) => existing.get(d.path) !== d.sha);
  let done = 0;
  const upsert = db.prepare(
    `INSERT INTO bm7 (dir, sha, name, category, rules, count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dir) DO UPDATE SET sha = excluded.sha, name = excluded.name, category = excluded.category,
       rules = excluded.rules, count = excluded.count, updated_at = excluded.updated_at`,
  );
  const queue = [...todo];
  const worker = async () => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      const meta = state.names[d.path] ?? { name: d.path, category: '' };
      try {
        const skip = SKIP_DIR.test(d.path) || meta.category === 'Advertising' || meta.category === 'Reject';
        let rules = skip ? [] : await fetchRules(d.path);
        const count = rules.length;
        if (count > MAX_RULES) rules = [];
        upsert.run(d.path, d.sha, meta.name, meta.category, JSON.stringify(rules), count, Date.now());
        (existing.has(d.path) ? result.updated : result.added).push(d.path);
      } catch {
        result.failed.push(d.path);
      }
      onProgress?.(++done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  // keep display names fresh even for dirs whose content did not change
  const rename = db.prepare('UPDATE bm7 SET name = ?, category = ? WHERE dir = ?');
  for (const [dir, m] of Object.entries(state.names)) rename.run(m.name, m.category, dir);

  // only advance the tree SHA once everything came down, so failures are retried next run
  kvSet('bm7:state', { ...state, clashSha: result.failed.length ? state.clashSha : clashSha, syncedAt: Date.now() });
  result.changed = result.added.length + result.updated.length + result.removed.length > 0;
  return result;
}

/* ---------- in-memory index ---------- */

const maskOf = (bits: number) => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);

export class Bm7Index {
  meta = new Map<string, Bm7Meta>();
  private full = new Map<string, string[]>();
  private suffix = new Map<string, string[]>();
  private cidr = new Map<number, Map<number, string[]>>();
  private asn = new Map<number, string[]>();

  static load(): Bm7Index {
    const idx = new Bm7Index();
    const rows = db.prepare('SELECT dir, name, category, rules, count FROM bm7').all() as {
      dir: string;
      name: string;
      category: string;
      rules: string;
      count: number;
    }[];
    const add = (map: Map<string, string[]>, k: string, dir: string) => {
      const l = map.get(k);
      if (!l) map.set(k, [dir]);
      else if (!l.includes(dir)) l.push(dir);
    };
    for (const r of rows) {
      idx.meta.set(r.dir, { dir: r.dir, name: r.name, category: r.category, count: r.count });
      for (const [type, value] of JSON.parse(r.rules) as Bm7Rule[]) {
        const v = value.toLowerCase();
        if (type === 'DOMAIN') add(idx.full, v, r.dir);
        else if (type === 'DOMAIN-SUFFIX') add(idx.suffix, v, r.dir);
        else if (type === 'IP-CIDR') {
          const [ip, b] = v.split('/');
          const n = ipToInt(ip);
          const bits = Number(b);
          if (n < 0 || !Number.isInteger(bits)) continue;
          let m = idx.cidr.get(bits);
          if (!m) idx.cidr.set(bits, (m = new Map()));
          const net = (n & maskOf(bits)) >>> 0;
          const l = m.get(net);
          if (!l) m.set(net, [r.dir]);
          else if (!l.includes(r.dir)) l.push(r.dir);
        } else if (type === 'IP-ASN') {
          const a = Number(v);
          const l = idx.asn.get(a);
          if (!l) idx.asn.set(a, [r.dir]);
          else if (!l.includes(r.dir)) l.push(r.dir);
        }
      }
    }
    return idx;
  }

  rules(dir: string): Bm7Rule[] {
    const row = db.prepare('SELECT rules FROM bm7 WHERE dir = ?').get(dir) as { rules: string } | undefined;
    return row ? (JSON.parse(row.rules) as Bm7Rule[]) : [];
  }

  /** Dirs containing host, most specific suffix first. */
  matchHost(host: string): { matched: string; dirs: string[] }[] {
    const h = host.toLowerCase().replace(/\.$/, '');
    const out: { matched: string; dirs: string[] }[] = [];
    const full = this.full.get(h);
    let cur = h;
    let first = true;
    for (;;) {
      const set = new Set<string>(first ? (full ?? []) : []);
      if (cur.includes('.') || first) for (const d of this.suffix.get(cur) ?? []) set.add(d);
      if (set.size) out.push({ matched: cur, dirs: [...set] });
      first = false;
      const dot = cur.indexOf('.');
      if (dot < 0) break;
      cur = cur.slice(dot + 1);
    }
    return out;
  }

  matchIp(ip: string): string[] {
    const n = ipToInt(ip);
    if (n < 0) return [];
    const out: string[] = [];
    for (const [bits, m] of [...this.cidr].sort((a, b) => b[0] - a[0])) {
      for (const d of m.get((n & maskOf(bits)) >>> 0) ?? []) if (!out.includes(d)) out.push(d);
    }
    return out;
  }

  matchAsn(asn: number): string[] {
    return this.asn.get(asn) ?? [];
  }
}
