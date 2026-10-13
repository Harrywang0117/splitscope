export function fmtBytes(n: number): string {
  if (!n) return '0';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function fmtSpeed(n: number): string {
  return n ? `${fmtBytes(n)}/s` : '';
}

export function fmtTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function fmtDateTime(ms: number): string {
  if (!ms) return '从未';
  const d = new Date(ms);
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function fmtAgo(ms: number): string {
  if (!ms) return '从未';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/*
 * Policy groups are drawn like metro lines: each group keeps one color everywhere.
 * Domestic/direct groups use the "go" green, REJECT the "stop" red.
 */
const LINE_COLORS = [
  '#2f6bff', // blue
  '#8b5cf6', // violet
  '#e0457b', // pink
  '#0e9f9a', // teal
  '#f07a1a', // orange
  '#7a8c1c', // olive
  '#c2417f', // raspberry
  '#0ea5e9', // sky
  '#a3622d', // brown
  '#5b5bd6', // indigo
  '#13a36f', // jade
  '#d4453b', // brick
];

export function groupColor(name: string | undefined): string {
  if (!name) return 'var(--ink-3)';
  if (/^(DIRECT|直连|国内)$/i.test(name)) return 'var(--go)';
  if (/^REJECT/i.test(name)) return 'var(--stop)';
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return LINE_COLORS[h % LINE_COLORS.length];
}

export const KIND_LABEL: Record<string, string> = {
  phone: '手机',
  computer: '电脑',
  tablet: '平板',
  tv: '电视/盒子',
  console: '游戏机',
  iot: '智能家居',
  camera: '摄像头',
  router: '路由/网关',
  server: '服务器',
  other: '其他',
};

export const TARGET_KIND_LABEL: Record<string, string> = {
  domain: '域名',
  suffix: '后缀',
  keyword: '关键词',
  regex: '正则',
  ip: 'IP',
  cidr: 'IP 段',
  asn: 'ASN',
  process: '进程',
  other: '其他',
};

export function ruleText(type?: string, payload?: string): string {
  if (!type) return '—';
  return payload ? `${type}(${payload})` : type;
}

export function sourceLabel(id: string): string {
  if (id.startsWith('geosite:')) return `GeoSite · ${id.slice(8)}`;
  if (id.startsWith('bm7:')) return `bm7 · ${id.slice(4)}`;
  if (id.startsWith('geoip:')) return `GeoIP · ${id.slice(6)}`;
  if (id.startsWith('asn:')) return `AS${id.slice(4)}`;
  if (id.startsWith('site:')) return '站点';
  if (id.startsWith('curated:')) return `整理清单 · ${id.slice(8)}`;
  return id;
}
