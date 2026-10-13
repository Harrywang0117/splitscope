import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, Next } from 'hono';
import { config } from './config.ts';
import { ipToInt } from './enrich/geoip.ts';

/**
 * The site has no login. Anyone on the LAN may look; only devices in EDIT_NETS (and the machine it
 * runs on) may change things: expectations, case status, device names, retention, probes, refreshes.
 */

const nets = config.editNets.map((s) => {
  const [ip, bits = '32'] = s.split('/');
  const b = Number(bits);
  const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
  return { base: (ipToInt(ip) & mask) >>> 0, mask };
});

export function clientIp(c: Context): string {
  return (getConnInfo(c).remote.address ?? '').replace(/^::ffff:/, '');
}

export function canEdit(ip: string): boolean {
  if (ip === '::1' || ip.startsWith('127.')) return true;
  const n = ipToInt(ip);
  return n >= 0 && nets.some((x) => ((n & x.mask) >>> 0) === x.base);
}

/** POSTs that only compute and change nothing */
const READ_POSTS = new Set(['/api/expand']);

export async function guardWrites(c: Context, next: Next) {
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || READ_POSTS.has(c.req.path)) return next();
  const ip = clientIp(c);
  if (canEdit(ip)) return next();
  return c.json({ error: `这台设备（${ip}）只能查看；只有 ${config.editNets.join('、')} 里的设备能修改`, code: 'readonly' }, 403);
}
