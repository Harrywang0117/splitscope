import { beforeAll, describe, expect, it } from 'vitest';
import type { LiveConn } from '../shared/types.ts';

const conn = (over: Partial<LiveConn>): LiveConn => ({
  id: Math.random().toString(36).slice(2),
  start: Date.now(),
  network: 'tcp',
  inbound: 'Redir',
  srcIp: '192.168.1.10',
  srcPort: 50000,
  host: 'example.com',
  dstIp: '',
  dstPort: 443,
  rule: 'RuleSet',
  rulePayload: 'Globe / Domain',
  ruleIndex: 81,
  fallback: '',
  chain: ['国外', 'node-us'],
  group: '国外',
  node: 'node-us',
  nodeProvider: 'sub',
  direct: false,
  service: null,
  target: null,
  targetApprox: false,
  up: 0,
  down: 0,
  upSpeed: 0,
  downSpeed: 0,
  ...over,
});

let mod: {
  store: typeof import('../server/history/store.ts');
  q: typeof import('../server/history/queries.ts');
  intel: typeof import('../server/enrich/intel.ts');
};

beforeAll(async () => {
  mod = {
    store: await import('../server/history/store.ts'),
    q: await import('../server/history/queries.ts'),
    intel: await import('../server/enrich/intel.ts'),
  };
  mod.intel.intel.services.nodeRegions = { 'Tunnel-01': 'US' };
  const { recordDelta, flushHistory } = mod.store;
  // a proxied foreign service, a domestic IP sent through a proxy, and a fallback hit
  recordDelta(conn({ host: 'claude.ai', service: { id: 'geosite:anthropic', name: 'Claude', source: 'geosite', also: [] } }), 1000, 9000, true);
  recordDelta(conn({ host: '', dstIp: '110.76.6.92', target: { ip: '110.76.6.92', country: 'CN', tags: [] }, rule: 'Match', rulePayload: '', fallback: 'match', group: '其他', node: 'US-Tunnel-01' }), 10, 20, true);
  recordDelta(conn({ host: 'www.baidu.com', direct: true, group: '国内', node: '直连', rulePayload: 'Direct / Domain', target: { ip: '183.2.172.177', country: 'CN', tags: [] } }), 500, 500, true);
  // probes never count
  recordDelta(conn({ host: 'probe.test', probe: true }), 999, 999, true);
  expect(flushHistory()).toBe(3);
});

describe('history', () => {
  it('summarises totals and proxy share', () => {
    const s = mod.q.summary('24h');
    expect(s.up + s.down).toBe(11030);
    expect(s.conns).toBe(3);
    expect(s.proxyShare).toBeCloseTo(10030 / 11030, 5);
    expect(s.fallbackConns).toBe(1);
  });

  it('ranks by bytes with a per-group split', () => {
    const t = mod.q.top('24h', 'host', { limit: 10 });
    expect(t.total).toBe(3);
    expect(t.rows[0]).toMatchObject({ key: 'claude.ai', bytes: 10000 });
    expect(t.rows[0].groups).toEqual([{ group: '国外', bytes: 10000 }]);
  });

  it('checkup finds the domestic IP that went through a proxy and the fallback hit', () => {
    const c = mod.q.checkup('24h') as Record<string, { host: string; intentional: boolean }[]>;
    expect(c.cn_proxy.map((i) => i.host)).toEqual(['110.76.6.92']);
    expect(c.fallback.map((i) => i.host)).toEqual(['110.76.6.92']);
    expect(c.intl_direct).toEqual([]);
  });

  it('maps exits to regions (flag words beat a wrong flag, configured names, direct = LOCAL)', () => {
    expect(mod.q.nodeRegion('🇨🇳 台湾高级 IEPL 专线 1', false)).toBe('TW');
    expect(mod.q.nodeRegion('🇭🇰 香港实验性 IEPL 专线 1', false)).toBe('HK');
    expect(mod.q.nodeRegion('US-Tunnel-01', false)).toBe('US');
    expect(mod.q.nodeRegion('直连', true)).toBe('LOCAL');
    const r = mod.q.regions('24h');
    expect(r.exits.find((e) => e.region === 'LOCAL')?.bytes).toBe(1000);
  });
});

describe('cases & expectations', () => {
  it('matches the most specific expectation and honours @direct / @proxy', async () => {
    const cases = await import('../server/history/cases.ts');
    cases.addExpectations([
      { kind: 'suffix', value: 'alipay.com', grp: '国内' },
      { kind: 'domain', value: 'intl.alipay.com', grp: '@direct' },
      { kind: 'cidr', value: '47.235.16.0/20', grp: '国内' },
    ]);
    expect(cases.expectationFor('mobilegw.alipay.com', '')?.value).toBe('alipay.com');
    expect(cases.expectationFor('intl.alipay.com', '')?.grp).toBe('@direct');
    expect(cases.expectationFor('', '47.235.24.194')?.kind).toBe('cidr');
    expect(cases.expectationFor('alipay.com.evil.net', '')).toBeUndefined();
    expect(cases.satisfies({ group: 'Apple', direct: true }, '@direct')).toBe(true);
    expect(cases.satisfies({ group: '国外', direct: false }, '国内')).toBe(false);
  });

  it('records a violated expectation and nothing else; a met expectation silences the heuristics', async () => {
    const cases = await import('../server/history/cases.ts');
    const { db } = await import('../server/db.ts');
    // violated: alipay went through the foreign group
    expect(cases.detectAnomalies(conn({ host: 'mobilegw.alipay.com', group: '其他', rule: 'Match', rulePayload: '', fallback: 'match' }))).toEqual(['expect']);
    // met: the CIDR expectation says 国内 and it went 国内, so no cn/fallback report
    expect(cases.detectAnomalies(conn({ host: '', dstIp: '47.235.24.194', group: '国内', direct: true, rule: 'Match', rulePayload: '', fallback: 'match' }))).toEqual([]);
    db.exec('BEGIN');
    cases.flushCases();
    db.exec('COMMIT');
    const { rows } = cases.listCases({ status: 'open' });
    expect(rows.map((r) => [r.reason, r.host, r.grp, r.expected])).toEqual([['expect', 'mobilegw.alipay.com', '其他', '国内']]);
  });

  it('reopens a fixed case as regressed when it happens again', async () => {
    const cases = await import('../server/history/cases.ts');
    const { db } = await import('../server/db.ts');
    const key = cases.listCases({ status: 'open' }).rows[0].key;
    cases.updateCases([key], { status: 'fixed' });
    expect(cases.listCases({ status: 'open' }).total).toBe(0);
    cases.detectAnomalies(conn({ host: 'mobilegw.alipay.com', group: '其他', rule: 'Match', rulePayload: '', fallback: 'match', srcIp: '192.168.1.20' }));
    db.exec('BEGIN');
    cases.flushCases();
    db.exec('COMMIT');
    const again = cases.listCases({ status: 'open' }).rows[0];
    expect(again).toMatchObject({ key, regressed: 1, count: 2 });
    expect(JSON.parse(again.devices)).toEqual(['192.168.1.10', '192.168.1.20']);
  });
});

describe('connection log', () => {
  it('folds repeats within a minute into one row and keeps other routes apart', async () => {
    const log = await import('../server/history/connlog.ts');
    const { db } = await import('../server/db.ts');
    const t0 = Date.now();
    const a = conn({ host: 'fold.test', start: t0, srcPort: 1 });
    const b = conn({ host: 'fold.test', start: t0 + 1_000, srcPort: 2 });
    const later = conn({ host: 'fold.test', start: t0 + 61_000, srcPort: 3 });
    const other = conn({ host: 'fold.test', start: t0 + 2_000, srcPort: 4, group: 'Google', node: 'node-hk' });
    for (const c of [a, b, later, other]) log.logOpen(c);
    log.flushConnLog();
    a.up = 10;
    b.up = 20;
    for (const c of [a, b]) {
      c.closedAt = Date.now();
      log.logClose(c);
    }
    log.flushConnLog();
    const rows = db.prepare(`SELECT grp, n, up, end IS NOT NULL AS ended FROM conn_log WHERE host = 'fold.test' ORDER BY start`).all();
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { grp: '国外', n: 2, up: 30, ended: 1 },
      { grp: 'Google', n: 1, up: 0, ended: 0 },
      { grp: '国外', n: 1, up: 0, ended: 0 },
    ]);
    expect(log.queryConnLog({ q: 'fold.test', from: t0 - 1, to: t0 + 120_000 })).toMatchObject({ total: 3, conns: 4 });
  });

  it("never logs this site's own traffic", async () => {
    const log = await import('../server/history/connlog.ts');
    const { db } = await import('../server/db.ts');
    log.logOpen(conn({ host: 'self.test', self: true }));
    log.flushConnLog();
    expect(db.prepare(`SELECT count(*) n FROM conn_log WHERE host = 'self.test'`).get()).toEqual({ n: 0 });
  });
});

describe('backup', () => {
  it('restores what is missing, keeps newer local edits, and adds nothing the second time', async () => {
    const { makeBackup, restoreBackup } = await import('../server/backup.ts');
    const cases = await import('../server/history/cases.ts');
    const b = makeBackup();
    expect(b.tables.expectations).toHaveLength(3);
    expect(Object.values(restoreBackup(b)).every((n) => n === 0)).toBe(true);

    const exp = cases.listExpectations().find((e) => e.value === 'intl.alipay.com')!;
    cases.deleteExpectation(exp.id);
    const key = cases.listCases({ status: 'all' }).rows[0].key;
    cases.updateCases([key], { status: 'ignored', note: 'checked by hand' });
    expect(restoreBackup(b)).toMatchObject({ expectations: 1, cases: 0 });
    expect(cases.expectationFor('intl.alipay.com', '')?.grp).toBe('@direct');
    expect(cases.listCases({ status: 'all' }).rows.find((r) => r.key === key)).toMatchObject({ status: 'ignored', note: 'checked by hand' });
    expect(() => restoreBackup({ app: 'other' } as never)).toThrow();
  });
});

describe('fallback suggestions', () => {
  it('judges each target on its own: expectation, then same service, then China, else no guess', async () => {
    const { summarize } = await import('../server/analyze/report.ts');
    const fb = { status: 'ok', rule: { type: 'Match', payload: '', index: 89, target: '其他' }, group: '其他' };
    const ntp = { id: 'geosite:ntp', name: 'NTP', source: 'geosite', also: [] };
    const r = (value: string, kind: string, over: object = {}, test = value) => ({ target: { value, kind, test, from: [] }, ...fb, ...over });
    const s = summarize('mixed list', [
      r('mobilegw.alipay.com', 'domain'),
      r('intl.alipay.com', 'domain'),
      r('47.235.16.0/20', 'cidr', {}, '47.235.16.1'),
      r('47.235.24.194', 'ip'),
      r('pool.ntp.org', 'suffix', { rule: { type: 'RuleSet', payload: 'Globe / Domain', index: 81, target: '国外' }, group: '国外', service: ntp }),
      r('time.ntp.org', 'domain', { service: ntp }),
      r('110.76.6.92', 'ip', { resolved: [{ ip: '110.76.6.92', country: 'CN', tags: [] }] }),
      r('example.org', 'domain', { resolved: [{ ip: '93.184.215.14', country: 'US', tags: [] }] }),
    ] as never);
    const by = Object.fromEntries((s.suggested ?? []).map((x) => [x.value, [x.basis, x.group]]));
    expect(by).toEqual({
      'mobilegw.alipay.com': ['expect', '国内'],
      // @direct expectation -> the domestic group (no snapshot in tests, so DIRECT)
      'intl.alipay.com': ['expect', 'DIRECT'],
      '47.235.16.0/20': ['expect', '国内'],
      'time.ntp.org': ['sibling', '国外'],
      '110.76.6.92': ['cn', 'DIRECT'],
      'example.org': ['none', ''],
    });
    // the IP inside the suggested CIDR gets no line of its own, and an unknown target gets no line at all
    expect(s.suggestions).toEqual([
      'DOMAIN,mobilegw.alipay.com,国内',
      'DOMAIN,intl.alipay.com,DIRECT',
      'IP-CIDR,47.235.16.0/20,国内,no-resolve',
      'DOMAIN,time.ntp.org,国外',
      'IP-CIDR,110.76.6.92/32,DIRECT,no-resolve',
    ]);
  });
});

describe('draft marks on cases', () => {
  it('finds the drafted rule that covers a host or IP, preferring pending and the most specific', async () => {
    const drafts = await import('../server/history/drafts.ts');
    drafts.addDrafts(
      [
        { kind: 'suffix', value: 'alipaylog.com', grp: '国内' },
        { kind: 'domain', value: 'www.alipaylog.com', grp: 'DIRECT' },
        { kind: 'cidr', value: '47.235.16.0/20', grp: '国内' },
      ],
      false,
    );
    const m = drafts.draftsCovering(['WWW.alipaylog.com', 'mdap.alipaylog.com', '47.235.24.194', 'alipaylog.com.evil.net', '47.236.0.1']);
    expect(m.get('www.alipaylog.com')).toMatchObject({ kind: 'domain', grp: 'DIRECT', status: 'pending' });
    expect(m.get('mdap.alipaylog.com')).toMatchObject({ kind: 'suffix', value: 'alipaylog.com' });
    expect(m.get('47.235.24.194')).toMatchObject({ kind: 'cidr' });
    expect(m.has('alipaylog.com.evil.net')).toBe(false);
    expect(m.has('47.236.0.1')).toBe(false);
    expect(drafts.pendingDraftCount()).toBe(3);
  });
});
