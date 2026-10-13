import { config } from '../config.ts';
import { db } from '../db.ts';
import { intel } from '../enrich/intel.ts';
import { getSnapshot } from '../mihomo/snapshot.ts';

const HOUR = 3_600_000;
const MIN = 60_000;

export type Range = '1h' | '24h' | '7d' | '30d';
const RANGE_MS: Record<Range, number> = { '1h': HOUR, '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR };

export function parseRange(v: string | undefined): Range {
  return v === '1h' || v === '7d' || v === '30d' ? v : '24h';
}

const sinceHour = (r: Range) => Math.floor((Date.now() - RANGE_MS[r]) / HOUR);
const sinceMinute = (r: Range) => Math.floor((Date.now() - RANGE_MS[r]) / MIN);

type Row = Record<string, string | number | null>;
const all = (sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as Row[];
const one = (sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as Row;

/* ---------- groups the checkup suggests ---------- */

/** Domestic / foreign target groups as the running rules define them (China / Proxy-style rule sets). */
export function homeGroups(): { domestic: string; foreign: string } {
  const rules = getSnapshot()?.running.rules ?? [];
  const find = (re: RegExp) => rules.find((r) => r.type === 'RuleSet' && re.test(r.payload))?.target;
  const match = rules.find((r) => r.type === 'Match')?.target ?? '';
  return {
    domestic: find(/^(china|cn|direct|domestic)\b/i) ?? 'DIRECT',
    foreign: find(/^(proxy|globe|global|gfw|foreign)\b/i) ?? match,
  };
}

/* ---------- overview ---------- */

export function summary(range: Range) {
  const m =
    range === '30d'
      ? one(`SELECT sum(up) up, sum(down) down, sum(conns) conns, sum(CASE WHEN direct = 0 THEN up + down ELSE 0 END) proxied FROM traffic_hour WHERE hour >= ?`, sinceHour(range))
      : one(`SELECT sum(up) up, sum(down) down, sum(conns) conns, sum(CASE WHEN direct = 0 THEN up + down ELSE 0 END) proxied FROM traffic_min WHERE minute >= ?`, sinceMinute(range));
  const h = one(
    `SELECT count(DISTINCT src) devices, count(DISTINCT CASE WHEN service <> '' THEN service END) services, count(DISTINCT host) hosts,
            sum(CASE WHEN fallback <> '' THEN conns ELSE 0 END) fallbackConns
       FROM traffic_hour WHERE hour >= ?`,
    sinceHour(range),
  );
  const up = Number(m.up ?? 0);
  const down = Number(m.down ?? 0);
  return {
    up,
    down,
    conns: Number(m.conns ?? 0),
    proxyShare: up + down ? Number(m.proxied ?? 0) / (up + down) : 0,
    devices: Number(h.devices ?? 0),
    services: Number(h.services ?? 0),
    hosts: Number(h.hosts ?? 0),
    fallbackConns: Number(h.fallbackConns ?? 0),
  };
}

/* ---------- trend ---------- */

export function trend(range: Range, by: 'direct' | 'group') {
  const now = Date.now();
  let bucketMs: number;
  let rows: Row[];
  if (range === '30d') {
    bucketMs = 6 * HOUR;
    rows = all(`SELECT (hour * ${HOUR} / ${bucketMs}) b, grp, direct, sum(up + down) bytes FROM traffic_hour WHERE hour >= ? GROUP BY b, grp, direct`, sinceHour(range));
  } else {
    bucketMs = range === '1h' ? MIN : range === '24h' ? 15 * MIN : HOUR;
    rows = all(`SELECT (minute * ${MIN} / ${bucketMs}) b, grp, direct, sum(up + down) bytes FROM traffic_min WHERE minute >= ? GROUP BY b, grp, direct`, sinceMinute(range));
  }
  const first = Math.floor((now - RANGE_MS[range]) / bucketMs) + 1;
  const last = Math.floor(now / bucketMs);
  const n = last - first + 1;
  const series = new Map<string, number[]>();
  const add = (name: string, b: number, v: number) => {
    let arr = series.get(name);
    if (!arr) series.set(name, (arr = new Array(n).fill(0)));
    const i = b - first;
    if (i >= 0 && i < n) arr[i] += v;
  };
  if (by === 'direct') {
    for (const r of rows) add(Number(r.direct) ? '直连' : '代理', Number(r.b), Number(r.bytes));
  } else {
    const totals = new Map<string, number>();
    for (const r of rows) totals.set(String(r.grp), (totals.get(String(r.grp)) ?? 0) + Number(r.bytes));
    const top = new Set([...totals].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([g]) => g));
    for (const r of rows) add(top.has(String(r.grp)) ? String(r.grp) : '其他组', Number(r.b), Number(r.bytes));
  }
  const ordered = [...series].sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0));
  return {
    bucketMs,
    start: first * bucketMs,
    points: n,
    series: ordered.map(([name, values]) => ({ name, values })),
  };
}

/* ---------- rankings ---------- */

const DIMS = {
  service: { key: `CASE WHEN service <> '' THEN service ELSE 'site:' || host END`, label: `max(CASE WHEN svc_name <> '' THEN svc_name ELSE host END)` },
  host: { key: 'host', label: 'host' },
  device: { key: 'src', label: 'src' },
  group: { key: 'grp', label: 'grp' },
  node: { key: 'node', label: 'node' },
  country: { key: 'country', label: 'country' },
  rule: { key: 'rule', label: 'rule' },
} as const;
export type Dim = keyof typeof DIMS;
export const isDim = (v: string): v is Dim => v in DIMS;

const SORTS = { bytes: 'bytes', conns: 'conns', last: 'last', up: 'up', down: 'down', devices: 'devices' } as const;

export function top(range: Range, dim: Dim, opts: { limit?: number; offset?: number; sort?: string; order?: string; src?: string; q?: string } = {}) {
  const d = DIMS[dim];
  const where = ['hour >= ?'];
  const args: (string | number)[] = [sinceHour(range)];
  if (opts.src) {
    where.push('src = ?');
    args.push(opts.src);
  }
  if (opts.q) {
    where.push(`(${d.key} LIKE ? OR svc_name LIKE ? OR host LIKE ?)`);
    args.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`);
  }
  const w = where.join(' AND ');
  const sort = SORTS[(opts.sort ?? 'bytes') as keyof typeof SORTS] ?? 'bytes';
  const order = opts.order === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(500, Math.max(1, opts.limit ?? 20));
  const offset = Math.max(0, opts.offset ?? 0);
  const rows = all(
    `SELECT ${d.key} k, ${d.label} label, sum(up) up, sum(down) down, sum(up + down) bytes, sum(conns) conns,
            max(last) last, count(DISTINCT src) devices, sum(CASE WHEN fallback <> '' THEN conns ELSE 0 END) fallback,
            max(provider) provider, max(scope) scope, max(country) country, max(host) sample
       FROM traffic_hour WHERE ${w} GROUP BY k ORDER BY ${sort} ${order}, k LIMIT ? OFFSET ?`,
    ...args,
    limit,
    offset,
  );
  const total = Number(one(`SELECT count(*) n FROM (SELECT 1 FROM traffic_hour WHERE ${w} GROUP BY ${d.key})`, ...args).n ?? 0);
  // per-row split by policy group, for the colored bars
  const keys = rows.map((r) => String(r.k));
  const splits = new Map<string, { group: string; bytes: number }[]>();
  if (keys.length) {
    const ph = keys.map(() => '?').join(',');
    for (const s of all(`SELECT ${d.key} k, grp, sum(up + down) bytes FROM traffic_hour WHERE ${w} AND ${d.key} IN (${ph}) GROUP BY k, grp`, ...args, ...keys)) {
      const list = splits.get(String(s.k)) ?? [];
      list.push({ group: String(s.grp), bytes: Number(s.bytes) });
      splits.set(String(s.k), list);
    }
  }
  return {
    total,
    rows: rows.map((r) => ({
      key: String(r.k),
      label: String(r.label ?? r.k),
      up: Number(r.up),
      down: Number(r.down),
      bytes: Number(r.bytes),
      conns: Number(r.conns),
      last: Number(r.last),
      devices: Number(r.devices),
      fallback: Number(r.fallback),
      provider: String(r.provider ?? ''),
      scope: String(r.scope ?? ''),
      country: String(r.country ?? ''),
      sample: String(r.sample ?? ''),
      groups: (splits.get(String(r.k)) ?? []).sort((a, b) => b.bytes - a.bytes),
    })),
  };
}

/* ---------- one device ---------- */

export function deviceDetail(range: Range, src: string) {
  const services = top(range, 'service', { src, limit: 12 });
  const groups = top(range, 'group', { src, limit: 12 });
  const fallbacks = all(
    `SELECT host, max(svc_name) svc, grp, rule, fallback, sum(conns) conns, sum(up + down) bytes, max(last) last
       FROM traffic_hour WHERE hour >= ? AND src = ? AND fallback <> '' GROUP BY host, grp ORDER BY conns DESC LIMIT 20`,
    sinceHour(range),
    src,
  );
  const step = range === '30d' ? 24 : 1;
  const hours = all(`SELECT (hour / ${step}) b, sum(up + down) bytes, sum(CASE WHEN direct = 0 THEN up + down ELSE 0 END) proxied FROM traffic_hour WHERE hour >= ? AND src = ? GROUP BY b ORDER BY b`, sinceHour(range), src);
  return {
    services: services.rows,
    groups: groups.rows,
    fallbacks,
    series: { stepMs: step * HOUR, points: hours.map((h) => ({ t: Number(h.b) * step * HOUR, bytes: Number(h.bytes), proxied: Number(h.proxied) })) },
  };
}

/* ---------- flow (sankey) ---------- */

export function flow(range: Range, left: 'device' | 'service') {
  const leftKey = left === 'device' ? 'src' : DIMS.service.key;
  const leftLabel = left === 'device' ? 'src' : DIMS.service.label;
  const rows = all(
    `SELECT ${leftKey} l, ${leftLabel} label, grp, node, direct, sum(up + down) bytes FROM traffic_hour WHERE hour >= ? GROUP BY l, grp, node`,
    sinceHour(range),
  );
  const keepTop = (map: Map<string, number>, n: number) => new Set([...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k));
  const lTot = new Map<string, number>();
  const gTot = new Map<string, number>();
  const nTot = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const r of rows) {
    const b = Number(r.bytes);
    lTot.set(String(r.l), (lTot.get(String(r.l)) ?? 0) + b);
    gTot.set(String(r.grp), (gTot.get(String(r.grp)) ?? 0) + b);
    nTot.set(String(r.node), (nTot.get(String(r.node)) ?? 0) + b);
    labels.set(String(r.l), String(r.label ?? r.l));
  }
  const lKeep = keepTop(lTot, 12);
  const gKeep = keepTop(gTot, 12);
  const nKeep = keepTop(nTot, 12);
  const lk = (k: string) => (lKeep.has(k) ? k : '__other');
  const gk = (k: string) => (gKeep.has(k) ? k : '其他组');
  const nk = (k: string) => (nKeep.has(k) ? k : '其他节点');
  const a = new Map<string, number>();
  const b = new Map<string, number>();
  const direct = new Map<string, boolean>();
  for (const r of rows) {
    const v = Number(r.bytes);
    const k1 = `${lk(String(r.l))}\u0000${gk(String(r.grp))}`;
    const k2 = `${gk(String(r.grp))}\u0000${nk(String(r.node))}`;
    a.set(k1, (a.get(k1) ?? 0) + v);
    b.set(k2, (b.get(k2) ?? 0) + v);
    direct.set(nk(String(r.node)), Number(r.direct) === 1);
  }
  const split = (m: Map<string, number>) => [...m].map(([k, v]) => ({ from: k.split('\u0000')[0], to: k.split('\u0000')[1], bytes: v })).filter((l) => l.bytes > 0);
  return {
    left: [...lKeep].map((k) => ({ key: k, label: labels.get(k) ?? k })).concat(lTot.size > lKeep.size ? [{ key: '__other', label: '其他' }] : []),
    links1: split(a),
    links2: split(b),
    directNodes: [...direct].filter(([, d]) => d).map(([k]) => k),
  };
}

/* ---------- checkup ---------- */

export type CheckKind = 'cn_proxy' | 'intl_direct' | 'fallback' | 'udp_fallback';

const CHECK_WHERE: Record<CheckKind, string> = {
  cn_proxy: `scope = 'cn' AND direct = 0 AND node NOT LIKE 'REJECT%' AND grp NOT LIKE 'REJECT%'`,
  intl_direct: `scope = 'intl' AND direct = 1`,
  fallback: `fallback = 'match'`,
  udp_fallback: `fallback = 'udp'`,
};

export function checkup(range: Range) {
  const { domestic, foreign } = homeGroups();
  const out: Record<string, unknown> = { domestic, foreign };
  for (const kind of Object.keys(CHECK_WHERE) as CheckKind[]) {
    const items = all(
      `SELECT host, max(svc_name) svc, grp, rule, max(scope) scope, max(country) country, max(network) network,
              sum(conns) conns, sum(up + down) bytes, count(DISTINCT src) devices, max(last) last,
              group_concat(DISTINCT src) srcs
         FROM traffic_hour WHERE hour >= ? AND ${CHECK_WHERE[kind]}
        GROUP BY host, grp, rule ORDER BY conns DESC, bytes DESC LIMIT 300`,
      sinceHour(range),
    );
    out[kind] = items.map((r) => {
      const scope = String(r.scope ?? '');
      const [ruleType] = String(r.rule ?? '').split('|');
      const group = String(r.grp);
      // Suspicious only when the generic path decided it: the domestic / foreign catch-all groups or a
      // fallback rule. A service group (Apple, Microsoft …) set to direct or a hand-written single-host
      // rule is a deliberate choice, so it is listed but folded away.
      const generic = group === domestic || group === foreign || ['Match', 'Network', ''].includes(ruleType);
      const intentional = (kind === 'intl_direct' || kind === 'cn_proxy') && !generic;
      const expect = kind === 'cn_proxy' ? domestic : kind === 'intl_direct' ? foreign : scope === 'cn' ? domestic : scope === 'intl' ? foreign : '';
      return {
        host: String(r.host),
        service: String(r.svc ?? ''),
        group,
        rule: String(r.rule ?? ''),
        scope,
        country: String(r.country ?? ''),
        network: String(r.network ?? ''),
        conns: Number(r.conns),
        bytes: Number(r.bytes),
        devices: Number(r.devices),
        srcs: String(r.srcs ?? '').split(',').filter(Boolean),
        last: Number(r.last),
        intentional,
        expect,
      };
    });
  }
  return out;
}

/* ---------- regions ---------- */

const REGION_WORDS: [RegExp, string][] = [
  [/香港|\bHK\b|Hong ?Kong/i, 'HK'],
  [/台湾|\bTW\b|Taiwan/i, 'TW'],
  [/日本|东京|大阪|\bJP\b|Japan/i, 'JP'],
  [/新加坡|狮城|\bSG\b|Singapore/i, 'SG'],
  [/美国|洛杉矶|圣何塞|\bUSA?\b|United States/i, 'US'],
  [/韩国|首尔|\bKR\b|Korea/i, 'KR'],
  [/英国|伦敦|\bUK\b|\bGB\b|Britain/i, 'GB'],
  [/德国|法兰克福|\bDE\b|Germany/i, 'DE'],
  [/法国|\bFR\b|France/i, 'FR'],
  [/加拿大|\bCA\b|Canada/i, 'CA'],
  [/澳大利亚|澳洲|\bAU\b|Australia/i, 'AU'],
  [/荷兰|\bNL\b|Netherlands/i, 'NL'],
  [/俄罗斯|\bRU\b|Russia/i, 'RU'],
  [/印度|\bIN\b|India/i, 'IN'],
  [/土耳其|\bTR\b|Turkey/i, 'TR'],
  [/马来西亚|\bMY\b|Malaysia/i, 'MY'],
  [/泰国|\bTH\b|Thailand/i, 'TH'],
  [/越南|\bVN\b|Vietnam/i, 'VN'],
  [/菲律宾|\bPH\b|Philippines/i, 'PH'],
  [/阿根廷|\bAR\b|Argentina/i, 'AR'],
];

/** Where traffic leaves the internet for a given node: flag emoji, region words, or the configured map. */
export function nodeRegion(node: string, direct: boolean): string {
  if (direct) return 'LOCAL';
  const flag = /([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/u.exec(node);
  if (flag) {
    const code = String.fromCharCode(flag[1].codePointAt(0)! - 0x1f1e6 + 65, flag[2].codePointAt(0)! - 0x1f1e6 + 65);
    // providers label Taiwan nodes with the CN flag; trust the words when they disagree
    const words = REGION_WORDS.find(([re]) => re.test(node))?.[1];
    return words && words !== code ? words : code;
  }
  const custom = Object.entries({ ...intel.services.nodeRegions, ...config.nodeRegions }).find(([k]) => node.includes(k));
  if (custom) return custom[1];
  return REGION_WORDS.find(([re]) => re.test(node))?.[1] ?? '?';
}

export function regions(range: Range) {
  const rows = all(
    `SELECT country, node, direct, sum(up + down) bytes, sum(conns) conns FROM traffic_hour WHERE hour >= ? GROUP BY country, node, direct`,
    sinceHour(range),
  );
  const dest = new Map<string, { country: string; bytes: number; conns: number; direct: number; proxied: number }>();
  const exit = new Map<string, { region: string; bytes: number; conns: number; nodes: Set<string> }>();
  const matrix = new Map<string, number>();
  for (const r of rows) {
    const c = String(r.country || '?');
    const b = Number(r.bytes);
    const d = Number(r.direct) === 1;
    const region = nodeRegion(String(r.node), d);
    const x = dest.get(c) ?? { country: c, bytes: 0, conns: 0, direct: 0, proxied: 0 };
    x.bytes += b;
    x.conns += Number(r.conns);
    if (d) x.direct += b;
    else x.proxied += b;
    dest.set(c, x);
    const e = exit.get(region) ?? { region, bytes: 0, conns: 0, nodes: new Set<string>() };
    e.bytes += b;
    e.conns += Number(r.conns);
    e.nodes.add(String(r.node));
    exit.set(region, e);
    const k = `${c}\u0000${region}`;
    matrix.set(k, (matrix.get(k) ?? 0) + b);
  }
  return {
    destinations: [...dest.values()].sort((a, b) => b.bytes - a.bytes),
    exits: [...exit.values()].map((e) => ({ ...e, nodes: [...e.nodes] })).sort((a, b) => b.bytes - a.bytes),
    matrix: [...matrix].map(([k, bytes]) => ({ country: k.split('\u0000')[0], region: k.split('\u0000')[1], bytes })),
  };
}

/* ---------- nodes ---------- */

const NOT_NODES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay', 'Smart', 'Direct', 'Reject', 'RejectDrop', 'Compatible', 'Pass', 'Dns']);

export function nodes(range: Range) {
  const snap = getSnapshot();
  const traffic = new Map(top(range, 'node', { limit: 500 }).rows.map((r) => [r.key, r]));
  const svcRows = all(
    `SELECT node, ${DIMS.service.label} label, ${DIMS.service.key} k, sum(up + down) bytes FROM traffic_hour WHERE hour >= ? GROUP BY node, k ORDER BY bytes DESC`,
    sinceHour(range),
  );
  const services = new Map<string, { label: string; bytes: number }[]>();
  for (const s of svcRows) {
    const list = services.get(String(s.node)) ?? [];
    if (list.length < 4) list.push({ label: String(s.label), bytes: Number(s.bytes) });
    services.set(String(s.node), list);
  }
  // which groups currently resolve to each node
  const groups = new Map((snap?.groups ?? []).map((g) => [g.name, g]));
  const usedBy = new Map<string, string[]>();
  for (const g of snap?.groups ?? []) {
    let cur = g;
    const seen = new Set<string>();
    while (cur?.now && !seen.has(cur.name)) {
      seen.add(cur.name);
      const next = groups.get(cur.now);
      if (!next) {
        const list = usedBy.get(cur.now) ?? [];
        list.push(g.name);
        usedBy.set(cur.now, list);
        break;
      }
      cur = next;
    }
  }
  // nodes = config proxies + subscription / inline provider nodes + anything seen carrying traffic
  const types = new Map<string, string>();
  for (const [n, t] of Object.entries(snap?.proxyTypes ?? {})) if (!NOT_NODES.has(t)) types.set(n, t);
  for (const [n, p] of Object.entries(snap?.providerNodes ?? {})) types.set(n, p.type);
  for (const n of traffic.keys()) {
    const t = snap?.proxyTypes[n];
    if (!types.has(n) && !NOT_NODES.has(t ?? '') && n !== '?') types.set(n, t ?? '');
  }
  const names = [...types].map(([name, type]) => ({ name, type }));
  return names
    .map(({ name, type }) => {
      const t = traffic.get(name);
      return {
        name,
        type,
        region: nodeRegion(name, false),
        provider: snap?.providerNodes?.[name]?.provider ?? t?.provider ?? '',
        bytes: t?.bytes ?? 0,
        up: t?.up ?? 0,
        down: t?.down ?? 0,
        conns: t?.conns ?? 0,
        last: t?.last ?? 0,
        services: services.get(name) ?? [],
        usedBy: usedBy.get(name) ?? [],
      };
    })
    .sort((a, b) => b.bytes - a.bytes || b.usedBy.length - a.usedBy.length || a.name.localeCompare(b.name));
}
