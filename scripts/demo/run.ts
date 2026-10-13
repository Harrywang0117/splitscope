/**
 * `npm run demo`: Splitscope against a made-up kernel and a made-up home network, on
 * http://localhost:8687. Nothing here talks to a real router; rule data and favicons are still
 * downloaded from the internet (directly), and the demo keeps its data in data/demo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DEVICES, RULES, route, startMock } from './mock-mihomo.ts';

const root = path.resolve(import.meta.dirname, '../..');
const dataDir = path.join(root, 'data/demo');
const host = path.join(dataDir, 'host');
const API_PORT = 19090;
const MIXED_PORT = 17893;

// router files the app would read on OpenWrt: DHCP leases, a static host, OpenClash's config
const files: Record<string, string> = {
  'tmp/dhcp.leases': [
    '1999999999 a4:83:e7:2c:51:0a 192.168.1.20 MacBook-Pro 01:a4:83:e7:2c:51:0a',
    '1999999999 3e:91:2a:77:10:02 192.168.1.21 iPhone 01:3e:91:2a:77:10:02',
    '1999999999 10:4f:a8:6e:31:9d 192.168.1.30 Sony-Bravia-TV *',
    '1999999999 04:cf:8c:a1:22:7b 192.168.1.50 lumi-gateway-v3 *',
    '1999999999 3c:58:c2:90:4e:11 192.168.1.60 DESKTOP-7H2K9QF 01:3c:58:c2:90:4e:11',
  ].join('\n'),
  'etc/config/dhcp': "config dnsmasq\n\toption domain 'lan'\n\nconfig host\n\toption name 'PS5'\n\toption mac '70:9e:29:4a:2b:1c'\n\toption ip '192.168.1.40'\n",
  'etc/config/openclash': "config openclash 'config'\n\toption config_path '/etc/openclash/config/demo.yaml'\n\toption enable_custom_clash_rules '0'\n",
  'etc/openclash/config/demo.yaml': [
    'mixed-port: 7893',
    'mode: rule',
    'log-level: info',
    'dns:',
    '  enhanced-mode: fake-ip',
    '  fake-ip-range: 198.18.0.1/16',
    'rules:',
    ...RULES.map((r) => {
      const t = { DomainSuffix: 'DOMAIN-SUFFIX', RuleSet: 'RULE-SET', GeoIP: 'GEOIP', Network: 'NETWORK', Match: 'MATCH' }[r.type];
      return r.type === 'Match' ? `  - MATCH,${r.proxy}` : `  - ${t},${r.type === 'Network' ? r.payload.toUpperCase() : r.payload},${r.proxy}`;
    }),
  ].join('\n'),
};
for (const [p, text] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(host, p)), { recursive: true });
  fs.writeFileSync(path.join(host, p), text + '\n');
}

// reuse rule data a normal run already downloaded, so the demo starts identifying at once
const intel = path.join(root, 'data/cache/intel');
if (fs.existsSync(intel) && !fs.existsSync(path.join(dataDir, 'intel'))) fs.cpSync(intel, path.join(dataDir, 'intel'), { recursive: true });

Object.assign(process.env, {
  CLASH_API: `http://127.0.0.1:${API_PORT}`,
  CLASH_SECRET: '',
  MIXED_PROXY: `http://127.0.0.1:${MIXED_PORT}`,
  HOST_FILES: host,
  ROUTER_IPS: '192.168.1.1',
  EDIT_NETS: '192.168.1.0/24',
  DISCOVERY: '0',
  DATA_DIR: dataDir,
  PORT: process.env.PORT ?? '8687',
});

await startMock(API_PORT, MIXED_PORT);
console.log(`mock kernel on :${API_PORT} (mixed port :${MIXED_PORT})`);
await import('../../server/index.ts');
await seedHistory();

/**
 * A past day of traffic on first start, so the trend chart and the rankings are not empty: an
 * evening peak, streaming at night, AI tools in working hours, a little of everything else.
 */
async function seedHistory() {
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const { db } = await import('../../server/db.ts');
  const now = Date.now();
  const old = db.prepare('SELECT count(*) n FROM traffic_min WHERE minute < ?').get(Math.floor(now / MIN) - 90) as { n: number };
  if (old.n) return;
  // wait until the rule data is loaded, so services get their names
  const { intel } = await import('../../server/enrich/intel.ts');
  for (let i = 0; i < 120 && !intel.geosite; i++) await new Promise((r) => setTimeout(r, 500));
  const { identifyHost, identifyIp, providerOf } = await import('../../server/enrich/service.ts');
  const { scopeOf } = await import('../../server/enrich/scope.ts');

  const hourOf = (t: number) => new Date(t).getHours() + new Date(t).getMinutes() / 60;
  const bell = (h: number, peak: number, width: number) => Math.exp(-(((((h - peak + 36) % 24) - 12) / width) ** 2));
  const shape: Record<string, (h: number) => number> = {
    流媒体: (h) => 3_000_000 * bell(h, 21.5, 2.2),
    国外: (h) => 260_000 * (0.25 + bell(h, 15, 4) + 0.8 * bell(h, 22, 2)),
    AI: (h) => 90_000 * bell(h, 14, 3.5),
    国内: (h) => 120_000 * (0.3 + bell(h, 12.5, 4) + bell(h, 21, 2.5)),
    Apple: (h) => 20_000 * (0.4 + bell(h, 8, 2)),
    Telegram: (h) => 15_000 * (0.3 + bell(h, 22, 3)),
    其他: (h) => 30_000 * (0.3 + bell(h, 16, 5)),
  };
  const directGroups = new Set(['国内', 'Apple']);
  const insMin = db.prepare('INSERT OR IGNORE INTO traffic_min (minute, grp, direct, up, down, conns) VALUES (?, ?, ?, ?, ?, ?)');
  const insHour = db.prepare(
    `INSERT OR IGNORE INTO traffic_hour (hour, src, host, grp, node, rule, network, service, svc_name, provider, fallback, direct, scope, country, up, down, conns, last)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  for (let t = now - 24 * HOUR; t < now - 2 * MIN; t += MIN) {
    const h = hourOf(t);
    for (const [grp, f] of Object.entries(shape)) {
      const down = Math.round(f(h) * 60 * (0.6 + Math.random() * 0.8));
      if (down < 1000) continue;
      insMin.run(Math.floor(t / MIN), grp, directGroups.has(grp) ? 1 : 0, Math.round(down * 0.06), down, Math.max(1, Math.round(down / 400_000)));
    }
  }
  for (let t = now - 24 * HOUR; t < now - HOUR; t += HOUR) {
    const h = hourOf(t);
    for (const d of DEVICES) {
      for (const p of d.picks) {
        if (Math.random() > d.rate * (0.3 + bell(h, 20, 5))) continue;
        const r = route(p.host, p.ip, 'tcp');
        const prov = providerOf(p.ip);
        const svc = p.host ? identifyHost(p.host) : identifyIp(p.ip, prov);
        const down = Math.round((p.heavy ? 400_000_000 : 3_000_000) * Math.random() * (0.3 + bell(h, 21, 3)));
        const fb = r.rule.type === 'Match' ? 'match' : r.rule.type === 'Network' ? 'udp' : '';
        insHour.run(
          Math.floor(t / HOUR), d.ip, p.host || p.ip, r.rule.proxy, r.chains[0], `${r.rule.type}|${r.rule.payload}`, 'tcp',
          svc?.id ?? '', svc?.name ?? '', prov?.brand ?? prov?.org ?? '', fb, r.chains[0] === 'DIRECT' ? 1 : 0,
          scopeOf(p.host, p.ip, prov?.country ?? ''), prov?.country ?? '', Math.round(down * 0.05), down, 1 + Math.floor(Math.random() * 30), t + HOUR - 1,
        );
      }
    }
  }
  db.exec('COMMIT');
  console.log('seeded a day of demo history');
}
