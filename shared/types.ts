/** Types shared by the server and the web UI. */

export interface ServiceInfo {
  id: string;
  name: string;
  /** broad category when only a category list matched (name is then the site) */
  category?: string;
  source: 'geosite' | 'bm7' | 'geoip' | 'asn' | 'site';
  matched?: string;
  site?: string;
  also: string[];
}

export interface ProviderInfo {
  ip: string;
  asn?: number;
  org?: string;
  brand?: string;
  country?: string;
  tags: string[];
}

export type FallbackKind = '' | 'match' | 'udp';

export interface LiveConn {
  id: string;
  start: number;
  network: string;
  inbound: string;
  srcIp: string;
  srcPort: number;
  host: string;
  dstIp: string;
  dstPort: number;
  rule: string;
  rulePayload: string;
  ruleIndex: number;
  fallback: FallbackKind;
  /** policy group first, node last */
  chain: string[];
  group: string;
  node: string;
  /** subscription / provider the node came from */
  nodeProvider: string;
  direct: boolean;
  service: ServiceInfo | null;
  target: ProviderInfo | null;
  /** target IP came from a reference DNS lookup, not from the connection itself */
  targetApprox: boolean;
  up: number;
  down: number;
  upSpeed: number;
  downSpeed: number;
  closedAt?: number;
  /** when this site first saw the connection, on its own clock (start comes from the kernel's clock) */
  seenAt?: number;
  probe?: boolean;
  /** this site's own background traffic (health checks, downloads, favicons) */
  self?: boolean;
}

export interface LiveTick {
  added: LiveConn[];
  /** [id, up, down, upSpeed, downSpeed] */
  updated: [string, number, number, number, number][];
  closed: [string, number][];
  patches: { id: string; target: ProviderInfo | null; targetApprox: boolean; service: ServiceInfo | null }[];
  totals: { up: number; down: number; upSpeed: number; downSpeed: number; active: number };
}

export interface Device {
  key: string;
  ip: string;
  mac: string;
  hostname: string;
  staticName: string;
  vendor: string;
  randomMac: boolean;
  alias: string;
  kind: string;
  note: string;
  special: '' | 'router' | 'docker' | 'wan';
  online: boolean;
  leaseExpires: number;
  label: string;
  /** where the label came from */
  labelSource: 'alias' | 'friendly' | 'static' | 'dhcp' | 'mdns' | 'model' | 'hint' | 'vendor' | 'special' | 'unknown';
  /** name the device announces itself (Bonjour / UPnP) */
  friendly?: string;
  mdnsHost?: string;
  model?: string;
  manufacturer?: string;
  /** traffic-based guess, e.g. "苹果设备" */
  hint?: string;
}

export type TargetKind = 'domain' | 'suffix' | 'keyword' | 'regex' | 'ip' | 'cidr' | 'asn' | 'process' | 'other';

export interface ProbeTarget {
  /** original rule value, e.g. "alipay.com" for DOMAIN-SUFFIX */
  value: string;
  kind: TargetKind;
  /** host or IP actually dialed; empty when the entry cannot be probed */
  test: string;
  from: string[];
  note?: string;
}

export interface RuleRef {
  type: string;
  payload: string;
  index: number;
  target: string;
}

export interface ProbeResult {
  target: ProbeTarget;
  status: 'ok' | 'dial-error' | 'timeout' | 'skipped' | 'error';
  rule?: RuleRef;
  group?: string;
  chain?: string[];
  nodeProvider?: string;
  /** how UDP (QUIC) to the same target would be routed, when it differs from TCP */
  udp?: RuleRef & { group: string };
  error?: string;
  ms?: number;
  service?: ServiceInfo | null;
  resolved?: ProviderInfo[];
}

export interface Candidate {
  /** "geosite:alibaba" | "bm7:AliPay" | "curated:alipay" */
  id: string;
  source: 'geosite' | 'bm7' | 'curated';
  key: string;
  name: string;
  category?: string;
  count: number;
  reason: string;
}

export interface AnalysisSummary {
  query: string;
  total: number;
  tested: number;
  byGroup: { group: string; count: number }[];
  fallback: number;
  udpDiffers: number;
  warnings: string[];
  suggestions: string[];
  /**
   * Per fallback target: the group it probably belongs in and why. Empty group = no good guess.
   * Missing on analyses saved before 2026-10-13.
   */
  suggested?: Suggestion[];
}

export interface Suggestion {
  kind: TargetKind;
  value: string;
  group: string;
  /** 'expect' = the user's expectation, 'sibling' = same service routed by a rule, 'cn' = target in China */
  basis: 'expect' | 'sibling' | 'cn' | 'none';
  why: string;
  line: string | null;
}
