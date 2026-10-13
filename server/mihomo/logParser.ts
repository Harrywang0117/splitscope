/**
 * Parses mihomo connection log lines.
 *
 *   [TCP] 192.168.1.123:62874 --> www.baidu.com:443 match RuleSet(Direct / Domain) using 国内[直连]
 *   [TCP] dial 国内 (match RuleSet/Direct / Domain) 192.168.1.123:62865 --> x.baidu.com:443 error: dns resolve failed
 */

export interface LogMatch {
  network: 'TCP' | 'UDP';
  srcIp: string;
  srcPort: number;
  dstHost: string;
  dstPort: number;
  ruleType: string;
  rulePayload: string;
  /** top-level policy group (or DIRECT/REJECT) */
  group: string;
  /** final node shown in brackets, if any */
  node: string;
  error?: string;
}

const SRC = String.raw`(\S+?):(\d+)(?:\([^)]*\))?`;
const DST = String.raw`(.+?):(\d+)`;

const MATCH_RE = new RegExp(String.raw`^\[(TCP|UDP)\] ${SRC} --> ${DST} match (.+?) using (.+)$`);
const DIAL_ERR_RE = new RegExp(
  String.raw`^\[(TCP|UDP)\] dial (.+?) \(match (\w+)\/(.*?)\) ${SRC} --> ${DST} error: (.*)$`,
);
const DIAL_ERR_NORULE_RE = new RegExp(String.raw`^\[(TCP|UDP)\] dial (.+?) ${SRC} --> ${DST} error: (.*)$`);

/** "RuleSet(Google / Domain)" -> ["RuleSet", "Google / Domain"]; "Match" -> ["Match", ""] */
export function splitRule(s: string): [string, string] {
  const m = /^(\w+)(?:\((.*)\))?$/.exec(s.trim());
  if (!m) return [s.trim(), ''];
  return [m[1], m[2] ?? ''];
}

/** "Google[US-Tunnel-01]" -> ["Google", "US-Tunnel-01"] */
export function splitUsing(s: string): [string, string] {
  const i = s.indexOf('[');
  if (i < 0 || !s.endsWith(']')) return [s.trim(), ''];
  return [s.slice(0, i).trim(), s.slice(i + 1, -1)];
}

export function parseLogLine(payload: string): LogMatch | null {
  // a dial error to several IPs puts one "dial tcp …" per line after the first
  const [line, ...more] = payload.split('\n');
  const extra = more.length ? `\n${more.join('\n')}` : '';
  let m = MATCH_RE.exec(line);
  if (m) {
    const [ruleType, rulePayload] = splitRule(m[6]);
    const [group, node] = splitUsing(m[7]);
    return {
      network: m[1] as 'TCP' | 'UDP',
      srcIp: m[2],
      srcPort: Number(m[3]),
      dstHost: m[4],
      dstPort: Number(m[5]),
      ruleType,
      rulePayload,
      group,
      node,
    };
  }
  m = DIAL_ERR_RE.exec(line);
  if (m) {
    return {
      network: m[1] as 'TCP' | 'UDP',
      group: m[2],
      node: '',
      ruleType: m[3],
      rulePayload: m[4],
      srcIp: m[5],
      srcPort: Number(m[6]),
      dstHost: m[7],
      dstPort: Number(m[8]),
      error: m[9] + extra,
    };
  }
  m = DIAL_ERR_NORULE_RE.exec(line);
  if (m) {
    return {
      network: m[1] as 'TCP' | 'UDP',
      group: m[2],
      node: '',
      ruleType: '',
      rulePayload: '',
      srcIp: m[3],
      srcPort: Number(m[4]),
      dstHost: m[5],
      dstPort: Number(m[6]),
      error: m[7] + extra,
    };
  }
  return null;
}
