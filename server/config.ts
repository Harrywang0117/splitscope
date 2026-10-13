import path from 'node:path';

function env(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const clashApi = env('CLASH_API', 'http://127.0.0.1:9090').replace(/\/+$/, '');
const apiHost = new URL(clashApi).hostname;
const isLoopback = (h: string) => h === 'localhost' || h.startsWith('127.') || h === '::1' || h === '[::1]';

/** the router's own LAN addresses; defaults to the API host when that is a LAN address */
const routerIps = list(env('ROUTER_IPS', isLoopback(apiHost) ? '' : apiHost));
/** "a.b.c.d" -> "a.b.c.0/24" */
const lan24 = (ip: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? `${ip.split('.').slice(0, 3).join('.')}.0/24` : '');

export const config = {
  clashApi,
  clashSecret: env('CLASH_SECRET'),
  /** http://host:port of the mihomo mixed port (HTTP + SOCKS5) */
  mixedProxy: env('MIXED_PROXY') || `http://${apiHost}:7893`,
  hostFiles: env('HOST_FILES', '/host'),
  routerIps,
  port: Number(env('PORT', '8686')),
  /**
   * Networks whose devices may change things (expectations, cases, names, settings); everyone else
   * only looks. Defaults to the router's /24. The machine running the site can always edit.
   */
  editNets: list(env('EDIT_NETS', routerIps[0] ? lan24(routerIps[0]) : '')),
  /** fake-ip ranges besides the one read from the config (mihomo's default is 198.18.0.0/15) */
  fakeIpRanges: list(env('FAKE_IP_RANGE', '198.18.0.0/15')),
  /** node name fragment -> exit region, for nodes whose names carry no flag or place ("Tunnel-A=US,Box=JP") */
  nodeRegions: Object.fromEntries(
    list(env('NODE_REGIONS'))
      .map((p) => p.split('=').map((s) => s.trim()))
      .filter(([k, v]) => k && v)
      .map(([k, v]) => [k, v.toUpperCase()]),
  ) as Record<string, string>,
  /** ask LAN devices their names over mDNS / SSDP (off in the demo, which must not list real devices) */
  discovery: env('DISCOVERY', '1') !== '0',
  /** LAN address to send mDNS/SSDP multicast from (the router's LAN IP when running on it) */
  mdnsInterface: env('MDNS_INTERFACE') || (env('HOST_FILES', '/host').startsWith('ssh:') ? '' : (routerIps[0] ?? '')),
  dataDir: path.resolve(env('DATA_DIR', './data/cache')),
  /** bundled static data (services.json) */
  staticDataDir: path.resolve(env('STATIC_DATA_DIR', './data')),
  webDir: path.resolve(env('WEB_DIR', './dist/web')),
};

export const mixedProxyUrl = new URL(config.mixedProxy);
