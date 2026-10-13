import { describe, expect, it } from 'vitest';
import { cidrSample, classifyInput } from '../server/analyze/sources.ts';
import { parsePayload, parseReadme } from '../server/analyze/bm7.ts';
import { summarize } from '../server/analyze/report.ts';
import { parseArp, parseLeases, parseUciHosts } from '../server/enrich/device.ts';
import { GeoSite } from '../server/enrich/geosite.ts';
import { isRandomMac } from '../server/enrich/oui.ts';
import { parseYamlRule, udpCatchAll, type SnapshotRule } from '../server/mihomo/snapshot.ts';
import type { ProbeResult } from '../shared/types.ts';

/* ---- tiny protobuf writer to build geosite fixtures ---- */
const varint = (n: number) => {
  const out: number[] = [];
  while (n > 127) {
    out.push((n & 127) | 128);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
};
const field = (no: number, bytes: number[]) => [...varint(no * 8 + 2), ...varint(bytes.length), ...bytes];
const str = (no: number, s: string) => field(no, [...new TextEncoder().encode(s)]);
const num = (no: number, n: number) => [...varint(no * 8), ...varint(n)];
const domain = (type: number, v: string) => field(2, [...num(1, type), ...str(2, v)]);
const site = (code: string, ...domains: number[][]) => field(1, [...str(1, code), ...domains.flat()]);

describe('GeoSite', () => {
  const buf = new Uint8Array([
    ...site('GOOGLE', domain(2, 'google.com'), domain(2, 'ytimg.com'), domain(3, 'www.gstatic.com')),
    ...site('YOUTUBE', domain(2, 'ytimg.com'), domain(2, 'youtube.com')),
    ...site('GEOLOCATION-!CN', domain(2, 'google.com'), domain(2, 'example.org')),
    ...site('CATEGORY-ADS', domain(2, 'ads.example.org')),
  ]);
  const g = GeoSite.parse(buf);

  it('decodes categories and entries', () => {
    expect([...g.categories.keys()]).toEqual(['google', 'youtube', 'geolocation-!cn', 'category-ads']);
    expect(g.stats()).toEqual({ categories: 4, domains: 8 });
  });

  it('prefers the most specific suffix, then the smaller category', () => {
    expect(g.match('i.ytimg.com')?.key).toBe('youtube');
    expect(g.match('www.gstatic.com')?.key).toBe('google');
    expect(g.match('mail.google.com')?.key).toBe('google');
  });

  it('never picks aggregate lists when a specific one exists, falls back to category-*', () => {
    expect(g.match('foo.example.org')).toBeNull();
    expect(g.match('x.ads.example.org')?.key).toBe('category-ads');
  });
});

describe('devices', () => {
  it('detects randomized MACs', () => {
    expect(isRandomMac('ae:67:ed:00:00:01')).toBe(true);
    expect(isRandomMac('f4:64:12:f9:68:05')).toBe(false);
  });

  it('parses leases, uci hosts and arp', () => {
    expect(parseLeases('1791846379 AE:67:ED:11:22:33 192.168.1.249 * 01:ae\n')).toEqual([
      { expires: 1791846379000, mac: 'ae:67:ed:11:22:33', ip: '192.168.1.249', hostname: '' },
    ]);
    const hosts = parseUciHosts(
      "config dnsmasq\n\toption domain 'lan'\n\nconfig host\n\toption name 'PS5'\n\toption mac 'f4:64:12:f9:68:05'\n\toption ip '192.168.1.246'\n",
    );
    expect(hosts).toEqual([{ name: 'PS5', macs: ['f4:64:12:f9:68:05'], ip: '192.168.1.246' }]);
    const arp = parseArp(
      'IP address HW type Flags HW address Mask Device\n192.168.1.116 0x1 0x2 2e:07:35:b1:18:f9 * br-lan\n172.20.1.22 0x1 0x0 00:00:00:00:00:00 * br-x\n',
    );
    expect(arp).toEqual([{ ip: '192.168.1.116', mac: '2e:07:35:b1:18:f9', online: true, dev: 'br-lan' }]);
  });
});

describe('input & targets', () => {
  it('classifies input', () => {
    expect(classifyInput('https://claude.ai/new?x=1')).toEqual({ kind: 'domain', value: 'claude.ai' });
    expect(classifyInput('WWW.Google.com')).toEqual({ kind: 'domain', value: 'www.google.com' });
    expect(classifyInput('91.108.56.132')).toEqual({ kind: 'ip', value: '91.108.56.132' });
    expect(classifyInput('91.108.4.0/22')).toEqual({ kind: 'cidr', value: '91.108.4.0/22' });
    expect(classifyInput('支付宝')).toEqual({ kind: 'name', value: '支付宝' });
    expect(classifyInput('Netflix')).toEqual({ kind: 'name', value: 'Netflix' });
  });

  it('samples the first host of a CIDR', () => {
    expect(cidrSample('91.108.4.0/22')).toBe('91.108.4.1');
    expect(cidrSample('194.221.250.50/32')).toBe('194.221.250.50');
    expect(cidrSample('10.0.0.7/24')).toBe('10.0.0.1');
  });

  it('parses blackmatrix7 payloads and README tables', () => {
    expect(parsePayload('# NAME: AliPay\npayload:\n  - DOMAIN-SUFFIX,alipay.com\n  - IP-CIDR,1.2.3.0/24,no-resolve\n')).toEqual([
      ['DOMAIN-SUFFIX', 'alipay.com'],
      ['IP-CIDR', '1.2.3.0/24'],
    ]);
    const md =
      '|🇨🇳Mainland|  |  |\n| ---- | ---- | ---- |\n|[支付宝](https://github.com/blackmatrix7/ios_rule_script/tree/master/rule/Clash/AliPay) |[微信](https://github.com/blackmatrix7/ios_rule_script/tree/master/rule/Clash/WeChat) |\n';
    expect(parseReadme(md)).toEqual({
      AliPay: { name: '支付宝', category: 'Mainland' },
      WeChat: { name: '微信', category: 'Mainland' },
    });
  });
});

describe('snapshot rules', () => {
  it('maps yaml rule syntax to API rule types', () => {
    expect(parseYamlRule('RULE-SET,Google / Domain,Google', 0)).toMatchObject({ type: 'RuleSet', payload: 'Google / Domain', target: 'Google' });
    expect(parseYamlRule('IP-CIDR,194.221.250.50/32,Telegram,no-resolve', 1)).toMatchObject({ type: 'IPCIDR', target: 'Telegram' });
    expect(parseYamlRule('NETWORK,UDP,国外', 2)).toMatchObject({ type: 'Network', payload: 'udp', target: '国外' });
    expect(parseYamlRule('MATCH,其他', 3)).toMatchObject({ type: 'Match', payload: '', target: '其他' });
    expect(parseYamlRule('AND,((DOMAIN,a.com),(NETWORK,UDP)),REJECT', 4)).toMatchObject({ type: 'AND', target: 'REJECT' });
  });

  it('finds the UDP catch-all', () => {
    const rules: SnapshotRule[] = [
      { index: 0, type: 'RuleSet', payload: 'Google / Domain', target: 'Google' },
      { index: 1, type: 'Network', payload: 'udp', target: '国外' },
      { index: 2, type: 'Network', payload: 'udp', target: 'REJECT' },
      { index: 3, type: 'Match', payload: '', target: '其他' },
    ];
    expect(udpCatchAll(rules)?.index).toBe(1);
  });
});

describe('summarize', () => {
  const res = (value: string, group: string, type = 'RuleSet'): ProbeResult => ({
    target: { value, kind: 'suffix', test: value, from: [] },
    status: 'ok',
    rule: { type, payload: '', index: type === 'Match' ? 89 : 83, target: group },
    group,
    chain: [group],
    udp: type === 'Match' ? { type: 'Network', payload: 'udp', index: 87, target: '国外', group: '国外' } : undefined,
    service: { id: value.startsWith('alipay') ? 'bm7:AliPay' : value, name: value.startsWith('alipay') ? '支付宝' : value, source: 'bm7', also: [] },
  });

  it('counts groups, flags fallback and suggests the group other targets of the same service went to', () => {
    const s = summarize('支付宝', [res('alipay.com', '国内'), res('alipay.cn', '国内'), res('alipaylog.com', '其他', 'Match')]);
    expect(s.byGroup).toEqual([
      { group: '国内', count: 2 },
      { group: '其他', count: 1 },
    ]);
    expect(s.fallback).toBe(1);
    expect(s.udpDiffers).toBe(1);
    expect(s.suggestions).toEqual(['DOMAIN-SUFFIX,alipaylog.com,国内']);
    expect(s.suggested?.[0]).toMatchObject({ basis: 'sibling', group: '国内' });
  });

  it('does not suggest rules for targets that hit a specific rule in another group', () => {
    const s = summarize('x', [res('a.com', '国内'), res('b.com', '国内'), res('gs-loc.apple.com', 'Apple')]);
    expect(s.suggestions).toEqual([]);
    expect(s.warnings.some((w) => w.includes('Apple'))).toBe(true);
  });
});

describe('adjustment plan', async () => {
  const { buildRules, ruleFor, yamlItem } = await import('../web/src/lib/rules.ts');
  const t = (value: string, kind: 'domain' | 'suffix' | 'ip' | 'cidr' | 'keyword') => ({ value, kind, test: value, from: [] });

  it('writes the rule type that matches how the target was tested', () => {
    expect(ruleFor(t('alipaylog.com', 'suffix'), '国内')).toBe('DOMAIN-SUFFIX,alipaylog.com,国内');
    expect(ruleFor(t('www.x.com', 'domain'), '国内')).toBe('DOMAIN,www.x.com,国内');
    expect(ruleFor(t('www.x.com', 'domain'), '国内', true)).toBe('DOMAIN-SUFFIX,www.x.com,国内');
    expect(ruleFor(t('1.2.3.4', 'ip'), 'DIRECT')).toBe('IP-CIDR,1.2.3.4/32,DIRECT,no-resolve');
    expect(ruleFor(t('47.235.16.0/20', 'cidr'), '国内')).toBe('IP-CIDR,47.235.16.0/20,国内,no-resolve');
  });

  it('drops entries covered by another adjustment to the same group', () => {
    const adj = (target: ReturnType<typeof t>, to: string) => ({ target, from: '其他', to, hitIndex: 89 });
    const { lines, skipped } = buildRules([
      adj(t('alipaylog.com', 'suffix'), '国内'),
      adj(t('www.alipaylog.com', 'domain'), '国内'),
      adj(t('47.235.16.0/20', 'cidr'), '国内'),
      adj(t('47.235.24.194', 'ip'), '国内'),
      adj(t('47.52.123.84', 'ip'), '国内'),
      adj(t('api.alipaylog.com', 'domain'), 'Google'),
    ]);
    expect(lines).toEqual([
      'DOMAIN-SUFFIX,alipaylog.com,国内',
      'IP-CIDR,47.235.16.0/20,国内,no-resolve',
      'IP-CIDR,47.52.123.84/32,国内,no-resolve',
      'DOMAIN,api.alipaylog.com,Google',
    ]);
    expect(skipped).toBe(2);
  });

  it('quotes yaml items only when needed', () => {
    expect(yamlItem('DOMAIN,a.com,X / Twitter')).toBe('  - DOMAIN,a.com,X / Twitter');
    expect(yamlItem('DOMAIN,a.com,组 #1')).toBe("  - 'DOMAIN,a.com,组 #1'");
  });
});

describe('edit access', () => {
  it('lets the LAN edit, everyone else only look', async () => {
    // as if EDIT_NETS=192.168.1.0/24 (read when access.ts loads)
    const { config } = await import('../server/config.ts');
    config.editNets = ['192.168.1.0/24'];
    const { canEdit } = await import('../server/access.ts');
    expect(canEdit('192.168.1.123')).toBe(true);
    expect(canEdit('127.0.0.1')).toBe(true);
    expect(canEdit('::1')).toBe(true);
    expect(canEdit('10.0.0.20')).toBe(false);
    expect(canEdit('172.18.0.5')).toBe(false);
    expect(canEdit('')).toBe(false);
  });
});

describe('rule drafts placement', () => {
  it('puts each line before the rule its targets stop at, and a covering line before the earliest it covers', async () => {
    const { planBlocks } = await import('../web/src/lib/rules.ts');
    const t = (kind: 'domain' | 'suffix' | 'ip' | 'cidr', value: string) => ({ kind, value, test: value, from: [] });
    const { blocks, skipped } = planBlocks([
      { target: t('suffix', 'alipaylog.com'), from: '其他', to: '国内', hitIndex: 89 },
      { target: t('domain', 'www.alipaylog.com'), from: 'Globe', to: '国内', hitIndex: 40 },
      { target: t('cidr', '47.235.16.0/20'), from: '其他', to: '国内', hitIndex: 89 },
      { target: t('ip', '47.235.24.194'), from: '其他', to: '国内', hitIndex: 89 },
      { target: t('domain', 'device.moorgen.com'), from: '其他', to: '国内', hitIndex: -1 },
    ]);
    expect(skipped).toBe(2);
    expect(blocks).toEqual([
      { before: -1, lines: ['DOMAIN,device.moorgen.com,国内'] },
      { before: 40, lines: ['DOMAIN-SUFFIX,alipaylog.com,国内'] },
      { before: 89, lines: ['IP-CIDR,47.235.16.0/20,国内,no-resolve'] },
    ]);
  });
});

describe('write guard', () => {
  it('refuses changes from outside EDIT_NETS but still serves reads', async () => {
    const { Hono } = await import('hono');
    const { guardWrites } = await import('../server/access.ts');
    const app = new Hono();
    app.use('/api/*', guardWrites);
    app.get('/api/x', (c) => c.text('read'));
    app.put('/api/x', (c) => c.text('written'));
    const from = (ip: string) => ({ incoming: { socket: { remoteAddress: ip, remotePort: 1, remoteFamily: 'IPv4' } } });
    expect((await app.request('/api/x', {}, from('10.0.0.9'))).status).toBe(200);
    const denied = await app.request('/api/x', { method: 'PUT' }, from('10.0.0.9'));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'readonly' });
    expect((await app.request('/api/x', { method: 'PUT' }, from('::ffff:192.168.1.42'))).status).toBe(200);
  });
});

describe('config defaults', () => {
  it('derives the router address and the editing network from the API address', async () => {
    const before = { ...process.env };
    process.env.CLASH_API = 'http://192.168.31.1:9090';
    delete process.env.ROUTER_IPS;
    delete process.env.EDIT_NETS;
    process.env.NODE_REGIONS = 'Tunnel-A=us, Box=JP';
    const { config } = await import('../server/config.ts?defaults' as string);
    expect(config.routerIps).toEqual(['192.168.31.1']);
    expect(config.editNets).toEqual(['192.168.31.0/24']);
    expect(config.mixedProxy).toBe('http://192.168.31.1:7893');
    expect(config.nodeRegions).toEqual({ 'Tunnel-A': 'US', Box: 'JP' });
    process.env = before;
  });
});
