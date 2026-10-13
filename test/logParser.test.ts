import { describe, expect, it } from 'vitest';
import { parseLogLine, splitRule, splitUsing } from '../server/mihomo/logParser.ts';

describe('parseLogLine', () => {
  it('parses a successful match line', () => {
    const r = parseLogLine(
      '[TCP] 192.168.1.123:62874 --> www.baidu.com:443 match RuleSet(Direct / Domain) using 国内[直连]',
    );
    expect(r).toMatchObject({
      network: 'TCP',
      srcIp: '192.168.1.123',
      srcPort: 62874,
      dstHost: 'www.baidu.com',
      dstPort: 443,
      ruleType: 'RuleSet',
      rulePayload: 'Direct / Domain',
      group: '国内',
      node: '直连',
    });
  });

  it('parses Match and IPCIDR rules and nested brackets in node names', () => {
    expect(
      parseLogLine('[TCP] 192.168.1.123:62866 --> nonexist.com:443 match Match using 其他[US-Tunnel-02]'),
    ).toMatchObject({ ruleType: 'Match', rulePayload: '', group: '其他', node: 'US-Tunnel-02' });
    expect(
      parseLogLine(
        '[TCP] 192.168.1.123:61804 --> 194.221.250.50:5222 match IPCIDR(194.221.250.50/32) using Telegram[🇨🇳 台湾高级 IEPL 专线 1]',
      ),
    ).toMatchObject({ ruleType: 'IPCIDR', rulePayload: '194.221.250.50/32', group: 'Telegram', dstPort: 5222 });
  });

  it('parses a dial error line with rule info', () => {
    const r = parseLogLine(
      "[TCP] dial 国内 (match RuleSet/Direct / Domain) 192.168.1.123:62865 --> nonexist-zzqq1.baidu.com:443 error: dns resolve failed: couldn't find ip",
    );
    expect(r).toMatchObject({
      group: '国内',
      ruleType: 'RuleSet',
      rulePayload: 'Direct / Domain',
      srcPort: 62865,
      dstHost: 'nonexist-zzqq1.baidu.com',
      error: "dns resolve failed: couldn't find ip",
    });
  });

  it('parses a multi-line dial error (one line per tried IP)', () => {
    const r = parseLogLine(
      '[TCP] dial 国内 (match RuleSet/China / Domain) 192.168.1.123:62415 --> alipay.net:443 error: dial tcp 110.75.129.5:443: i/o timeout\ndial tcp 110.75.139.5:443: i/o timeout',
    );
    expect(r).toMatchObject({ group: '国内', ruleType: 'RuleSet', rulePayload: 'China / Domain', srcPort: 62415, dstHost: 'alipay.net' });
    expect(r?.error).toContain('110.75.139.5');
  });

  it('tolerates a process suffix on the source', () => {
    expect(
      parseLogLine('[UDP] 127.0.0.1:5000(curl) --> 1.1.1.1:53 match Network(udp) using 国外[x]'),
    ).toMatchObject({ srcPort: 5000, ruleType: 'Network', rulePayload: 'udp' });
  });

  it('returns null for unrelated lines', () => {
    expect(parseLogLine('[Provider] Google / Domain updated')).toBeNull();
  });
});

describe('helpers', () => {
  it('splitRule / splitUsing', () => {
    expect(splitRule('DomainSuffix(meta.com)')).toEqual(['DomainSuffix', 'meta.com']);
    expect(splitUsing('DIRECT')).toEqual(['DIRECT', '']);
  });
});
