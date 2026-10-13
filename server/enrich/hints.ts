/**
 * Guesses what a device is from the hosts it talks to, for devices that announce nothing
 * (random MAC, no DHCP hostname, no mDNS/SSDP). Each rule needs a few distinct hosts before it counts.
 */

interface HintRule {
  label: string;
  kind: string;
  re: RegExp;
  /** distinct matching hosts needed */
  min: number;
}

const RULES: HintRule[] = [
  { label: '苹果设备', kind: '', re: /(^|\.)(push\.apple\.com|icloud\.com|apple\.com|mzstatic\.com|aaplimg\.com|apple-cloudkit\.com|icloud-content\.com)$/, min: 2 },
  // only Android itself calls these (desktop Chrome also talks to mtalk / play.googleapis.com)
  { label: '安卓设备', kind: 'phone', re: /(^|\.)(connectivitycheck\.(gstatic|android)\.com|android\.clients\.google\.com|android\.googleapis\.com)$/, min: 1 },
  { label: 'TP-Link 摄像头 / 智能设备', kind: 'camera', re: /(^|\.)(tplinkcloud\.com(\.cn)?|tp-link\.com\.cn|tplinkdns\.com|tapo\.(com|cn))$/, min: 1 },
  { label: '小米设备', kind: '', re: /(^|\.)(xiaomi\.(com|net|cn)|mi\.com|miui\.com|mi-img\.com|io\.mi\.com|miwifi\.com)$/, min: 2 },
  { label: '华为设备', kind: '', re: /(^|\.)(hicloud\.com|huawei\.com|dbankcloud\.(com|cn)|vmall\.com)$/, min: 2 },
  { label: 'OPPO / 一加设备', kind: 'phone', re: /(^|\.)(heytapmobi\.com|heytapmobile\.com|oppomobile\.com|coloros\.com)$/, min: 2 },
  { label: 'vivo 设备', kind: 'phone', re: /(^|\.)(vivo\.com\.cn|vivoglobal\.com|bbktel\.com)$/, min: 2 },
  { label: '海尔家电', kind: 'iot', re: /(^|\.)(haier\.(net|com)|haieriot\.net|uhome\.haier\.net)$|uplus/, min: 1 },
  { label: '锐捷网络设备', kind: 'router', re: /(^|\.)(ruijie\.com\.cn|ruijienetworks\.com|ruijieyun\.com|reyee\.(cn|net))$/, min: 1 },
  { label: 'Windows 电脑', kind: 'computer', re: /(^|\.)(msftconnecttest\.com|msftncsi\.com|windowsupdate\.com|update\.microsoft\.com|delivery\.mp\.microsoft\.com)$/, min: 1 },
  { label: 'PlayStation', kind: 'console', re: /(^|\.)(playstation\.(net|com)|sonyentertainmentnetwork\.com|np\.dl\.playstation\.net)$/, min: 1 },
  { label: 'Nintendo Switch', kind: 'console', re: /(^|\.)(nintendo\.(net|com)|nintendowifi\.net)$/, min: 1 },
  { label: '追觅扫地机', kind: 'iot', re: /dreame/, min: 1 },
  { label: '涂鸦智能设备', kind: 'iot', re: /(^|\.)tuya(cn|us|eu|in)?\.com$/, min: 1 },
  { label: '萤石 / 海康摄像头', kind: 'camera', re: /(^|\.)(ys7\.com|ezvizlife\.com|ezviz\.com|hik-connect\.com|hikvision\.com)$/, min: 1 },
  { label: '摄像头', kind: 'camera', re: /(^|\.)(xmcsrv\.net|xmeye\.net|imoulife\.com|lechange\.(cn|com)|p2p\..+|tutk\.com|iotcplatform\.com)$/, min: 1 },
  { label: '天猫精灵', kind: 'iot', re: /aligenie|tmall-?genie/, min: 1 },
  { label: '小度音箱', kind: 'iot', re: /(^|\.)(xiaodu\.baidu\.com|dueros\.baidu\.com)$/, min: 1 },
  { label: '电视 / 盒子', kind: 'tv', re: /(^|\.)(ott\..+|cibntv\.net|gitv\.tv|aisee\.tv|dangbei\.(com|net)|mgtv\.com|tvos\..+)$/, min: 2 },
];

const seen = new Map<string, Map<number, Set<string>>>();

export function recordHost(ip: string, host: string) {
  if (!host) return;
  const h = host.toLowerCase();
  for (let i = 0; i < RULES.length; i++) {
    if (!RULES[i].re.test(h)) continue;
    let byRule = seen.get(ip);
    if (!byRule) seen.set(ip, (byRule = new Map()));
    let set = byRule.get(i);
    if (!set) byRule.set(i, (set = new Set()));
    if (set.size < 50) set.add(h);
  }
}

/** Best guess for a device, or undefined. More specific rules come first in RULES and win ties. */
export function hintFor(ip: string): { label: string; kind: string; evidence: string[] } | undefined {
  const byRule = seen.get(ip);
  if (!byRule) return undefined;
  let best: { i: number; n: number } | undefined;
  for (const [i, set] of byRule) {
    if (set.size < RULES[i].min) continue;
    // a specific phone/console rule outranks the generic vendor rule
    const score = set.size + (RULES[i].kind ? 3 : 0);
    if (!best || score > best.n || (score === best.n && i < best.i)) best = { i, n: score };
  }
  if (!best) return undefined;
  const r = RULES[best.i];
  return { label: r.label, kind: r.kind, evidence: [...byRule.get(best.i)!].slice(0, 5) };
}
