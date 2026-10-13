import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { kvGet, kvSet } from '../db.ts';
import { readHostFiles } from '../hostFiles.ts';
import { mihomo, type RawRule } from './client.ts';

/**
 * Snapshot of the OpenClash configuration: what the kernel is running (API) and what the active
 * yaml on disk says. Overwritten on every refresh; only a short "what changed" summary is kept.
 * Secrets (proxies / proxy-providers) are never read into the snapshot.
 */

export interface SnapshotRule {
  index: number;
  type: string;
  payload: string;
  target: string;
  hitCount?: number;
}

export interface SnapshotGroup {
  name: string;
  type: string;
  now?: string;
  all: string[];
}

export interface SnapshotProvider {
  name: string;
  behavior: string;
  format: string;
  count: number;
  updatedAt?: string;
  url?: string;
}

export interface Snapshot {
  takenAt: number;
  trigger: 'auto' | 'manual' | 'startup' | 'detected';
  version: string;
  configPath: string;
  yamlHash: string;
  running: { rules: SnapshotRule[]; hash: string };
  disk: { rules: SnapshotRule[]; hash: string } | null;
  groups: SnapshotGroup[];
  providers: SnapshotProvider[];
  /** name -> proxy type for every proxy/group (to tell DIRECT-like outbounds apart) */
  proxyTypes: Record<string, string>;
  /** real nodes from subscription / inline proxy providers: name -> provider + protocol */
  providerNodes?: Record<string, { provider: string; type: string }>;
  /** per subscription: info pseudo-nodes ("Traffic: …", "Expire: …") and usage numbers */
  providerInfo?: { name: string; vehicle: string; nodes: number; notes: string[]; used?: number; total?: number; expire?: number; updatedAt?: string }[];
  /** rules injected at runtime from OpenClash's custom rule lists (ruleKey form) */
  customRules: string[];
  /** running config differs from the yaml on disk (uploaded but not yet applied?) */
  drift: { onlyRunning: string[]; onlyDisk: string[] } | null;
  /** dns.fake-ip-range from the yaml, when set */
  fakeIpRange?: string;
}

export interface SnapshotChange {
  at: number;
  configChanged: boolean;
  fromPath?: string;
  toPath?: string;
  added: string[];
  removed: string[];
  groupsAdded: string[];
  groupsRemoved: string[];
}

const YAML_TYPE: Record<string, string> = {
  DOMAIN: 'Domain',
  'DOMAIN-SUFFIX': 'DomainSuffix',
  'DOMAIN-KEYWORD': 'DomainKeyword',
  'DOMAIN-REGEX': 'DomainRegex',
  'DOMAIN-WILDCARD': 'DomainWildcard',
  GEOSITE: 'GeoSite',
  GEOIP: 'GeoIP',
  'IP-CIDR': 'IPCIDR',
  'IP-CIDR6': 'IPCIDR',
  'IP-SUFFIX': 'IPSuffix',
  'IP-ASN': 'IPASN',
  'SRC-IP-CIDR': 'SrcIPCIDR',
  'SRC-PORT': 'SrcPort',
  'DST-PORT': 'DstPort',
  'IN-PORT': 'InPort',
  'PROCESS-NAME': 'Process',
  'PROCESS-PATH': 'ProcessPath',
  'RULE-SET': 'RuleSet',
  NETWORK: 'Network',
  MATCH: 'Match',
  AND: 'AND',
  OR: 'OR',
  NOT: 'NOT',
  'SUB-RULE': 'SubRules',
};

const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay', 'Smart']);

export const ruleKey = (r: Pick<SnapshotRule, 'type' | 'payload' | 'target'>) =>
  `${r.type},${r.payload},${r.target}`;

const hashOf = (rules: SnapshotRule[]) =>
  createHash('sha1').update(rules.map((r) => ruleKey(r).toLowerCase()).join('\n')).digest('hex');

export function parseYamlRule(line: string, index: number): SnapshotRule | null {
  const s = line.trim();
  // logical rules carry commas inside parentheses: AND,((DOMAIN,a),(NETWORK,UDP)),target
  const logical = /^(AND|OR|NOT),(\(.*\)),([^,]+)/.exec(s);
  if (logical) return { index, type: logical[1], payload: logical[2], target: logical[3] };
  const parts = s.split(',').map((p) => p.trim());
  const yt = parts[0]?.toUpperCase();
  if (!yt) return null;
  if (yt === 'MATCH') return { index, type: 'Match', payload: '', target: parts[1] ?? '' };
  if (parts.length < 3) return null;
  let payload = parts[1];
  if (yt === 'NETWORK') payload = payload.toLowerCase();
  return { index, type: YAML_TYPE[yt] ?? yt, payload, target: parts[2] };
}

function fromApi(rules: RawRule[]): SnapshotRule[] {
  return rules.map((r, i) => ({
    index: r.index ?? i,
    type: r.type,
    payload: r.type === 'Network' ? r.payload.toLowerCase() : r.payload,
    target: r.proxy,
    hitCount: r.extra?.hitCount,
  }));
}

function multisetDiff(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
  const count = new Map<string, number>();
  for (const k of b) count.set(k, (count.get(k) ?? 0) + 1);
  const onlyA: string[] = [];
  for (const k of a) {
    const n = count.get(k) ?? 0;
    if (n > 0) count.set(k, n - 1);
    else onlyA.push(k);
  }
  const onlyB: string[] = [];
  for (const [k, n] of count) for (let i = 0; i < n; i++) onlyB.push(k);
  return { onlyA, onlyB };
}

function stripQuery(url?: string) {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return undefined;
  }
}

const CUSTOM_LISTS = [
  '/etc/openclash/custom/openclash_custom_rules.list',
  '/etc/openclash/custom/openclash_custom_rules_2.list',
];

async function readDisk(): Promise<{ path: string; text: string; custom: SnapshotRule[] } | null> {
  const first = await readHostFiles(['/etc/config/openclash', ...CUSTOM_LISTS]);
  const uci = first['/etc/config/openclash'];
  const m = uci && /option\s+config_path\s+'?([^'\n]+)'?/.exec(uci);
  if (!m) return null;
  const p = m[1].trim();
  const text = (await readHostFiles([p]))[p];
  if (!text) return null;
  const custom: SnapshotRule[] = [];
  if (/option\s+enable_custom_clash_rules\s+'?1/.test(uci)) {
    for (const f of CUSTOM_LISTS) {
      for (const line of (first[f] ?? '').split('\n')) {
        const l = line.replace(/^\s*-\s*/, '').trim();
        if (!l || l.startsWith('#') || l.endsWith(':')) continue;
        const r = parseYamlRule(l, custom.length);
        if (r) custom.push(r);
      }
    }
  }
  return { path: p, text, custom };
}

let current: Snapshot | null = kvGet<Snapshot>('clash:snapshot')?.value ?? null;
const listeners = new Set<(s: Snapshot) => void>();
export const onSnapshot = (fn: (s: Snapshot) => void) => listeners.add(fn);
export const getSnapshot = () => current;
export const getLastChange = () => kvGet<SnapshotChange>('clash:lastChange')?.value ?? null;

let inflight: Promise<Snapshot> | null = null;

export function refreshSnapshot(trigger: Snapshot['trigger']): Promise<Snapshot> {
  inflight ??= (async () => {
    const [version, apiRules, proxies, providers, disk, proxyProviders] = await Promise.all([
      mihomo.version(),
      mihomo.rules(),
      mihomo.proxies(),
      mihomo.ruleProviders().catch(() => ({})),
      readDisk().catch(() => null),
      mihomo.proxyProviders().catch(() => ({}) as Awaited<ReturnType<typeof mihomo.proxyProviders>>),
    ]);

    // "Compatible" providers just wrap groups; HTTP / File / Inline ones hold the real nodes
    const PSEUDO = /^(traffic|expire|剩余|到期|过期|套餐|官网|流量|reset|距离|重置)/i;
    const providerNodes: Record<string, { provider: string; type: string }> = {};
    const providerInfo: NonNullable<Snapshot['providerInfo']> = [];
    for (const [name, p] of Object.entries(proxyProviders)) {
      if (p.vehicleType === 'Compatible') continue;
      const notes: string[] = [];
      let nodes = 0;
      for (const n of p.proxies ?? []) {
        if (PSEUDO.test(n.name.trim())) notes.push(n.name.trim());
        else {
          providerNodes[n.name] = { provider: name, type: n.type };
          nodes++;
        }
      }
      const si = p.subscriptionInfo;
      providerInfo.push({
        name,
        vehicle: p.vehicleType,
        nodes,
        notes,
        used: si ? (si.Upload ?? 0) + (si.Download ?? 0) : undefined,
        total: si?.Total || undefined,
        expire: si?.Expire ? si.Expire * 1000 : undefined,
        updatedAt: p.updatedAt,
      });
    }

    const running = fromApi(apiRules);
    let diskRules: SnapshotRule[] | null = null;
    let providerUrls: Record<string, string | undefined> = {};
    let yamlHash = '';
    let fakeIpRange: string | undefined;
    if (disk) {
      yamlHash = createHash('sha1').update(disk.text).digest('hex');
      const doc = parseYaml(disk.text, { uniqueKeys: false, maxAliasCount: -1 }) as {
        rules?: string[];
        'rule-providers'?: Record<string, { url?: string }>;
        dns?: { 'fake-ip-range'?: string };
      };
      fakeIpRange = doc.dns?.['fake-ip-range'] ? String(doc.dns['fake-ip-range']) : undefined;
      diskRules = (doc.rules ?? [])
        .map((r, i) => parseYamlRule(String(r), i))
        .filter((r): r is SnapshotRule => !!r);
      providerUrls = Object.fromEntries(
        Object.entries(doc['rule-providers'] ?? {}).map(([k, v]) => [k, stripQuery(v?.url)]),
      );
    }

    const groups: SnapshotGroup[] = Object.values(proxies)
      .filter((p) => GROUP_TYPES.has(p.type))
      .map((p) => ({ name: p.name, type: p.type, now: p.now, all: p.all ?? [] }));
    const proxyTypes = Object.fromEntries(Object.values(proxies).map((p) => [p.name, p.type]));

    // running = OpenClash custom rules + yaml rules; anything else means the yaml on disk is not what runs
    const customRules = (disk?.custom ?? []).map(ruleKey);
    let drift: Snapshot['drift'] = null;
    if (diskRules) {
      const custom = new Set(customRules.map((k) => k.toLowerCase()));
      const d = multisetDiff(running.map(ruleKey), diskRules.map(ruleKey));
      const onlyRunning = d.onlyA.filter((k) => !custom.has(k.toLowerCase()));
      if (onlyRunning.length || d.onlyB.length) drift = { onlyRunning, onlyDisk: d.onlyB };
    }

    const snap: Snapshot = {
      fakeIpRange,
      takenAt: Date.now(),
      trigger,
      version: version.version,
      configPath: disk?.path ?? '',
      yamlHash,
      running: { rules: running, hash: hashOf(running) },
      disk: diskRules ? { rules: diskRules, hash: hashOf(diskRules) } : null,
      groups,
      providers: Object.entries(providers).map(([name, p]) => ({
        name,
        behavior: p.behavior,
        format: p.format,
        count: p.ruleCount,
        updatedAt: p.updatedAt,
        url: providerUrls[name],
      })),
      proxyTypes,
      providerNodes,
      providerInfo,
      customRules,
      drift,
    };

    // overwrite mode: keep only a summary of what changed relative to the previous snapshot
    const prev = current;
    if (prev && (prev.running.hash !== snap.running.hash || prev.configPath !== snap.configPath)) {
      const d = multisetDiff(snap.running.rules.map(ruleKey), prev.running.rules.map(ruleKey));
      const pg = new Set(prev.groups.map((g) => g.name));
      const ng = new Set(snap.groups.map((g) => g.name));
      const change: SnapshotChange = {
        at: snap.takenAt,
        configChanged: prev.configPath !== snap.configPath,
        fromPath: prev.configPath,
        toPath: snap.configPath,
        added: d.onlyA,
        removed: d.onlyB,
        groupsAdded: [...ng].filter((g) => !pg.has(g)),
        groupsRemoved: [...pg].filter((g) => !ng.has(g)),
      };
      kvSet('clash:lastChange', change);
    }
    kvSet('clash:snapshot', snap);
    current = snap;
    for (const fn of listeners) fn(snap);
    return snap;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Cheap check that the kernel is still running what the snapshot says (rule list hash).
 * Used before each probe run and periodically; refreshes the snapshot when it drifted.
 */
export async function ensureFreshSnapshot(): Promise<Snapshot> {
  const rules = fromApi(await mihomo.rules());
  if (current && hashOf(rules) === current.running.hash) {
    // keep hit counters current without rewriting the snapshot
    current.running.rules = rules;
    return current;
  }
  return refreshSnapshot(current ? 'detected' : 'startup');
}

/** First `Network,udp` rule — unmatched UDP stops here instead of reaching MATCH. */
export function udpCatchAll(rules: SnapshotRule[]): SnapshotRule | undefined {
  return rules.find((r) => r.type === 'Network' && r.payload === 'udp');
}
