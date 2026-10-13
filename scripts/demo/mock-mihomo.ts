/**
 * A stand-in for a mihomo kernel, for trying Splitscope (and taking screenshots) without a router.
 * It serves the parts of the external-controller API the app uses, streams made-up connections
 * from a few made-up devices, and runs a mixed port: SOCKS5 CONNECTs (the app's probes) are
 * answered from the rule list below and logged like mihomo does; HTTP proxy requests (rule data
 * downloads, DoH, favicons, health checks) are passed straight through to the internet.
 */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';

/* ---------- config: rules, groups, nodes ---------- */

type Rule = { type: string; payload: string; proxy: string };

export const RULES: Rule[] = [
  { type: 'DomainSuffix', payload: 'openai.com', proxy: 'AI' },
  { type: 'DomainSuffix', payload: 'chatgpt.com', proxy: 'AI' },
  { type: 'DomainSuffix', payload: 'claude.ai', proxy: 'AI' },
  { type: 'DomainSuffix', payload: 'anthropic.com', proxy: 'AI' },
  { type: 'RuleSet', payload: 'Apple / Domain', proxy: 'Apple' },
  { type: 'RuleSet', payload: 'Telegram / Domain', proxy: 'Telegram' },
  { type: 'RuleSet', payload: 'Google / Domain', proxy: '国外' },
  { type: 'RuleSet', payload: 'Netflix / Domain', proxy: '流媒体' },
  { type: 'RuleSet', payload: 'GitHub / Domain', proxy: '国外' },
  { type: 'RuleSet', payload: 'Direct / Domain', proxy: '国内' },
  { type: 'RuleSet', payload: 'Telegram / IP', proxy: 'Telegram' },
  { type: 'GeoIP', payload: 'CN', proxy: '国内' },
  { type: 'RuleSet', payload: 'Globe / Domain', proxy: '国外' },
  { type: 'Network', payload: 'udp', proxy: '国外' },
  { type: 'Match', payload: '', proxy: '其他' },
];

const SETS: Record<string, string[]> = {
  'Apple / Domain': ['apple.com', 'icloud.com', 'mzstatic.com', 'apple-dns.net', 'cdn-apple.com'],
  'Telegram / Domain': ['telegram.org', 't.me'],
  'Google / Domain': ['google.com', 'googleapis.com', 'gstatic.com', 'youtube.com', 'ytimg.com', 'googlevideo.com'],
  'Netflix / Domain': ['netflix.com', 'nflxvideo.net', 'nflximg.net'],
  'GitHub / Domain': ['github.com', 'githubusercontent.com', 'githubassets.com'],
  'Direct / Domain': ['baidu.com', 'qq.com', 'weixin.qq.com', '163.com', 'alipay.com', 'bilibili.com', 'mi.com', 'aliyun.com', 'taobao.com', 'jd.com'],
  'Globe / Domain': ['instagram.com', 'twitter.com', 'x.com', 'reddit.com', 'wikipedia.org', 'microsoft.com', 'playstation.net', 'playstation.com'],
};
const SET_NETS: Record<string, string[]> = { 'Telegram / IP': ['91.108.0.0/16', '149.154.160.0/20'] };
/** rough stand-in for GEOIP,CN */
const CN_NETS = ['110.0.0.0/7', '112.0.0.0/5', '120.0.0.0/6', '180.76.0.0/16', '183.0.0.0/8', '220.181.0.0/16', '223.0.0.0/8'];

const NODES: Record<string, string> = { '香港 01': 'Trojan', '香港 02': 'Trojan', '日本 01': 'Vmess', '新加坡 01': 'Shadowsocks', '美国 01': 'Vless' };
const GROUPS: Record<string, { type: string; all: string[]; now: string }> = {
  节点选择: { type: 'Selector', all: ['香港 01', '香港 02', '日本 01', '新加坡 01', '美国 01', 'DIRECT'], now: '香港 01' },
  AI: { type: 'Selector', all: ['美国 01', '日本 01'], now: '美国 01' },
  国外: { type: 'Selector', all: ['节点选择', '香港 01', '日本 01'], now: '节点选择' },
  流媒体: { type: 'URLTest', all: ['香港 02', '新加坡 01'], now: '新加坡 01' },
  Telegram: { type: 'Selector', all: ['新加坡 01', '节点选择'], now: '新加坡 01' },
  Apple: { type: 'Selector', all: ['DIRECT', '节点选择'], now: 'DIRECT' },
  国内: { type: 'Selector', all: ['DIRECT'], now: 'DIRECT' },
  其他: { type: 'Selector', all: ['节点选择', 'DIRECT'], now: '节点选择' },
};

/** mihomo order: actual outbound first, the rule's group last */
function chainOf(group: string): string[] {
  const out = [group];
  for (let cur = group; GROUPS[cur]; ) {
    cur = GROUPS[cur].now;
    out.push(cur);
  }
  return out.reverse();
}

/* ---------- matching ---------- */

const ipToInt = (ip: string) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0) >>> 0;
const inNet = (ip: string, cidr: string) => {
  const [base, bits] = cidr.split('/');
  const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(base) & mask) >>> 0);
};
const isIp = (s: string) => /^\d+\.\d+\.\d+\.\d+$/.test(s);
const hit = (host: string, list: string[]) => list.some((d) => host === d || host.endsWith(`.${d}`));

const hits = RULES.map(() => ({ count: 0, at: '' }));

export function route(host: string, ip: string, network: 'tcp' | 'udp') {
  const h = host.toLowerCase();
  const index = RULES.findIndex((r) => {
    switch (r.type) {
      case 'DomainSuffix':
        return !!h && hit(h, [r.payload]);
      case 'RuleSet':
        if (SETS[r.payload]) return !!h && hit(h, SETS[r.payload]);
        return !!ip && isIp(ip) && SET_NETS[r.payload].some((n) => inNet(ip, n));
      case 'GeoIP':
        return !!ip && isIp(ip) && CN_NETS.some((n) => inNet(ip, n));
      case 'Network':
        return network === r.payload;
      default:
        return true;
    }
  });
  hits[index].count++;
  hits[index].at = new Date().toISOString();
  const rule = RULES[index];
  return { index, rule, chains: chainOf(rule.proxy) };
}

/* ---------- made-up household traffic ---------- */

type Pick = { host: string; ip: string; port?: number; udp?: boolean; heavy?: boolean };
export const DEVICES: { ip: string; rate: number; picks: Pick[] }[] = [
  {
    ip: '192.168.1.20', // MacBook
    rate: 0.9,
    picks: [
      { host: 'chatgpt.com', ip: '104.18.32.47' },
      { host: 'claude.ai', ip: '160.79.104.10' },
      { host: 'api.github.com', ip: '20.205.243.168' },
      { host: 'github.com', ip: '20.205.243.166' },
      { host: 'www.google.com', ip: '142.250.196.196' },
      { host: 'fonts.gstatic.com', ip: '142.250.199.67' },
      { host: 'stackoverflow.com', ip: '104.18.32.7' },
      { host: 'www.baidu.com', ip: '110.242.68.66' },
      { host: 'cdn.jsdelivr.net', ip: '151.101.1.229' },
      { host: 'www.zhihu.com', ip: '118.89.204.198' },
    ],
  },
  {
    ip: '192.168.1.21', // iPhone
    rate: 0.7,
    picks: [
      { host: 'weixin.qq.com', ip: '121.51.73.100' },
      { host: 'api.telegram.org', ip: '149.154.167.220' },
      { host: '', ip: '91.108.56.130', port: 5222 },
      { host: 'gateway.icloud.com', ip: '17.248.211.66' },
      { host: 'music.163.com', ip: '59.111.181.35' },
      { host: 'mobilegw.alipay.com', ip: '110.76.12.22' },
      { host: 'www.instagram.com', ip: '157.240.22.174' },
      { host: 'www.youtube.com', ip: '142.250.196.206', udp: true },
    ],
  },
  {
    ip: '192.168.1.30', // TV
    rate: 0.25,
    picks: [
      { host: 'www.netflix.com', ip: '54.155.178.5' },
      { host: 'ipv4-c012-hkg001-ix.1.oca.nflxvideo.net', ip: '45.57.90.1', heavy: true },
      { host: 'rr2---sn-i3b7kn7s.googlevideo.com', ip: '74.125.12.71', heavy: true, udp: true },
      { host: 'api.bilibili.com', ip: '139.159.241.37' },
    ],
  },
  {
    ip: '192.168.1.40', // PS5
    rate: 0.15,
    picks: [
      { host: 'ps5.np.playstation.net', ip: '23.52.40.70' },
      { host: 'store.playstation.com', ip: '23.52.40.75' },
      { host: 'gs2.ww.prod.dl.playstation.net', ip: '23.37.53.12', heavy: true },
    ],
  },
  {
    ip: '192.168.1.50', // smart-home gateway
    rate: 0.2,
    picks: [
      { host: 'iot.mi.com', ip: '120.92.65.12' },
      { host: 'ntp.aliyun.com', ip: '203.107.6.88', port: 123, udp: true },
      { host: '', ip: '120.92.96.31', port: 8883 },
    ],
  },
  {
    ip: '192.168.1.60', // Windows PC
    rate: 0.5,
    picks: [
      { host: 'www.bilibili.com', ip: '139.159.241.37' },
      { host: 'api.steampowered.com', ip: '23.62.226.11' },
      { host: 'update.microsoft.com', ip: '13.107.4.50' },
      { host: 'www.reddit.com', ip: '151.101.1.140' },
      { host: 'en.wikipedia.org', ip: '103.102.166.224' },
      { host: 'discord.com', ip: '162.159.128.233' },
    ],
  },
];

type Conn = {
  id: string;
  metadata: Record<string, string>;
  upload: number;
  download: number;
  start: string;
  chains: string[];
  providerChains: string[];
  rule: string;
  rulePayload: string;
  until: number;
  rate: number;
};

const conns = new Map<string, Conn>();
let totals = { up: 0, down: 0 };
let fake = 1;
let port = 50000;

function open(src: string, p: Pick) {
  const network = p.udp && Math.random() < 0.6 ? 'udp' : 'tcp';
  const r = route(p.host, p.ip, network);
  const direct = r.chains[0] === 'DIRECT';
  const id = crypto.randomUUID();
  conns.set(id, {
    id,
    metadata: {
      network,
      type: 'Redir',
      sourceIP: src,
      destinationIP: p.host && !direct ? `198.18.0.${(fake = (fake % 250) + 1)}` : p.ip,
      sourcePort: String((port = port >= 65000 ? 50000 : port + 1)),
      destinationPort: String(p.port ?? 443),
      host: p.host,
      dnsMode: p.host ? 'fake-ip' : 'normal',
      remoteDestination: direct ? p.ip : '203.0.113.10',
    },
    upload: 0,
    download: 0,
    start: new Date().toISOString(),
    chains: r.chains,
    providerChains: direct ? [] : ['demo-sub'],
    rule: r.rule.type,
    rulePayload: r.rule.payload,
    until: Date.now() + (p.heavy ? 60_000 + Math.random() * 120_000 : 3_000 + Math.random() * 40_000),
    rate: p.heavy ? 40_000 + Math.random() * 360_000 : 300 + Math.random() * 12_000,
  });
}

function tick() {
  const now = Date.now();
  // evenings are busier: a slow wave makes the trend chart look like a day
  const wave = 0.6 + 0.4 * Math.sin(now / 600_000);
  for (const d of DEVICES) {
    if (Math.random() < d.rate * wave) open(d.ip, d.picks[Math.floor(Math.random() * d.picks.length)]);
  }
  for (const c of conns.values()) {
    if (c.until < now || (c.metadata.sourceIP === '127.0.0.1' && c.until < now)) {
      conns.delete(c.id);
      continue;
    }
    const down = Math.round(c.rate * (0.5 + Math.random()));
    const up = Math.round(down * (0.03 + Math.random() * 0.1));
    c.download += down;
    c.upload += up;
    totals.down += down;
    totals.up += up;
  }
}

const snapshot = () => ({
  downloadTotal: totals.down,
  uploadTotal: totals.up,
  connections: [...conns.values()].map(({ until: _u, rate: _r, ...c }) => c),
});

/* ---------- minimal WebSocket (server -> client text frames only) ---------- */

type Ws = { send: (s: string) => void; closed: boolean };

function upgrade(req: http.IncomingMessage, socket: net.Socket): Ws {
  const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const ws: Ws = {
    closed: false,
    send(s) {
      if (ws.closed) return;
      const body = Buffer.from(s);
      const head =
        body.length < 126
          ? Buffer.from([0x81, body.length])
          : body.length < 65536
            ? Buffer.from([0x81, 126, body.length >> 8, body.length & 255])
            : Buffer.concat([Buffer.from([0x81, 127, 0, 0, 0, 0]), Buffer.from([(body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255])]);
      socket.write(Buffer.concat([head, body]));
    },
  };
  // a close frame (opcode 8) or a dropped socket ends it; other client frames are ignored
  socket.on('data', (b) => {
    if ((b[0] & 0x0f) === 8) socket.end();
  });
  socket.on('close', () => (ws.closed = true));
  socket.on('error', () => (ws.closed = true));
  return ws;
}

const logListeners = new Set<Ws>();
const logLine = (payload: string) => {
  const msg = JSON.stringify({ type: 'info', payload });
  for (const ws of logListeners) ws.send(msg);
};

/* ---------- external controller ---------- */

function api(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const json = (o: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  switch (url.pathname) {
    case '/version':
      return json({ meta: true, version: 'demo-1.19' });
    case '/configs':
      return json({ mode: 'rule', 'log-level': 'info', 'mixed-port': 7893, 'allow-lan': true });
    case '/rules':
      return json({ rules: RULES.map((r, i) => ({ index: i, ...r, size: -1, extra: { disabled: false, hitCount: hits[i].count, hitAt: hits[i].at } })) });
    case '/proxies': {
      const proxies: Record<string, unknown> = {
        DIRECT: { name: 'DIRECT', type: 'Direct', udp: true },
        REJECT: { name: 'REJECT', type: 'Reject', udp: true },
      };
      for (const [name, type] of Object.entries(NODES)) proxies[name] = { name, type, udp: true };
      for (const [name, g] of Object.entries(GROUPS)) proxies[name] = { name, ...g, udp: true };
      return json({ proxies });
    }
    case '/providers/proxies':
      return json({
        providers: {
          'demo-sub': {
            name: 'demo-sub',
            vehicleType: 'HTTP',
            updatedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
            proxies: Object.entries(NODES).map(([name, type]) => ({ name, type })),
            subscriptionInfo: { Upload: 4.1e9, Download: 61.7e9, Total: 200e9, Expire: Math.floor(Date.now() / 1000) + 41 * 86400 },
          },
        },
      });
    case '/providers/rules':
      return json({
        providers: Object.fromEntries(
          [...Object.keys(SETS), ...Object.keys(SET_NETS)].map((k) => [k, { name: k, behavior: k.endsWith('IP') ? 'ipcidr' : 'domain', format: 'MrsRule', ruleCount: (SETS[k] ?? SET_NETS[k]).length * 97, updatedAt: new Date().toISOString() }]),
        ),
      });
    case '/connections':
      return json(snapshot());
    case '/dns/query': {
      const name = url.searchParams.get('name') ?? '';
      dns
        .resolve4(name)
        .then((ips) => json({ Status: 0, Answer: ips.map((data) => ({ type: 1, data, TTL: 600 })) }))
        .catch(() => json({ Status: 3 }));
      return;
    }
    default:
      res.writeHead(404);
      res.end();
  }
}

/* ---------- mixed port ---------- */

function mixed(sock: net.Socket) {
  sock.once('data', (first) => {
    if (first[0] === 0x05) return socks(sock, first);
    const head = first.toString('latin1');
    const line = head.slice(0, head.indexOf('\r\n'));
    const [method, target] = line.split(' ');
    if (method === 'CONNECT') {
      const [host, p] = target.split(':');
      const up = net.connect(Number(p), host, () => {
        sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
        up.pipe(sock);
        sock.pipe(up);
      });
      up.on('error', () => sock.destroy());
      sock.on('error', () => up.destroy());
      return;
    }
    // plain http through the proxy: rewrite to origin form and pass it on
    try {
      const u = new URL(target);
      if (u.pathname === '/generate_204') {
        sock.end('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const up = net.connect(Number(u.port || 80), u.hostname, () => {
        up.write(Buffer.from(head.replace(line, `${method} ${u.pathname}${u.search} HTTP/1.1`), 'latin1'));
        up.pipe(sock);
        sock.pipe(up);
      });
      up.on('error', () => sock.destroy());
      sock.on('error', () => up.destroy());
    } catch {
      sock.destroy();
    }
  });
  sock.on('error', () => undefined);
}

/** SOCKS5 CONNECT: the app's probes. Answer, log the decision like mihomo, keep it listed briefly. */
function socks(sock: net.Socket, greeting: Buffer) {
  void greeting;
  sock.write(Buffer.from([5, 0]));
  sock.once('data', (req) => {
    let host = '';
    let off = 4;
    if (req[3] === 1) {
      host = [...req.subarray(4, 8)].join('.');
      off = 8;
    } else if (req[3] === 3) {
      host = req.subarray(5, 5 + req[4]).toString();
      off = 5 + req[4];
    }
    const dport = req.readUInt16BE(off);
    sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
    const ip = isIp(host) ? host : '';
    const r = route(isIp(host) ? '' : host, ip, 'tcp');
    const src = `${(sock.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/, '')}:${sock.remotePort}`;
    const what = r.rule.type === 'Match' ? 'Match' : `${r.rule.type}(${r.rule.payload})`;
    // mihomo logs direct connections when the dial finishes; a short delay looks the same to the app
    setTimeout(() => logLine(`[TCP] ${src} --> ${host}:${dport} match ${what} using ${r.rule.proxy}[${r.chains[0]}]`), 30 + Math.random() * 120);
    const id = crypto.randomUUID();
    conns.set(id, {
      id,
      metadata: { network: 'tcp', type: 'Socks5', sourceIP: src.split(':')[0], destinationIP: ip, sourcePort: String(sock.remotePort), destinationPort: String(dport), host: ip ? '' : host, remoteDestination: '' },
      upload: 0,
      download: 0,
      start: new Date().toISOString(),
      chains: r.chains,
      providerChains: [],
      rule: r.rule.type,
      rulePayload: r.rule.payload,
      until: Date.now() + 3000,
      rate: 0,
    });
    sock.on('close', () => conns.delete(id));
  });
  sock.on('error', () => undefined);
}

/* ---------- start ---------- */

export function startMock(apiPort: number, mixedPort: number): Promise<void> {
  setInterval(tick, 1000);
  for (let i = 0; i < 25; i++) tick();

  const server = http.createServer(api);
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const ws = upgrade(req, socket as net.Socket);
    if (url.pathname === '/connections') {
      const t = setInterval(() => (ws.closed ? clearInterval(t) : ws.send(JSON.stringify(snapshot()))), Number(url.searchParams.get('interval') ?? 1000));
    } else if (url.pathname === '/logs') {
      logListeners.add(ws);
      socket.on('close', () => logListeners.delete(ws));
    } else socket.destroy();
  });
  return new Promise((resolve) => {
    let ready = 0;
    const done = () => ++ready === 2 && resolve();
    server.listen(apiPort, '127.0.0.1', done);
    net.createServer(mixed).listen(mixedPort, '127.0.0.1', done);
  });
}
