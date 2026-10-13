import dc from 'node:diagnostics_channel';

/**
 * This site's own outbound traffic (health checks, favicons, rule/geo downloads, DoH) shows up in
 * the kernel's connection list like anyone else's. Every HTTP connection we open goes through
 * undici (ours or Node's built-in fetch), which reports the socket on this channel, so we keep the
 * local address:port and let the connection store tag matching kernel connections as "self".
 * Probes are tracked separately in analyze/probe.ts.
 */

const TTL = 10 * 60 * 1000;
const ports = new Map<string, number>(); // "ip:port" -> expiry
let lastSweep = 0;

const norm = (ip: string) => ip.replace(/^::ffff:/, '');

export function markSelfSocket(localAddress: string | undefined, localPort: number | undefined) {
  if (!localAddress || !localPort) return;
  const now = Date.now();
  ports.set(`${norm(localAddress)}:${localPort}`, now + TTL);
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, exp] of ports) if (exp < now) ports.delete(k);
  }
}

export function isSelfConnection(srcIp: string, srcPort: number): boolean {
  const exp = ports.get(`${norm(srcIp)}:${srcPort}`);
  return !!exp && exp > Date.now();
}

dc.subscribe('undici:client:connected', (msg) => {
  const sock = (msg as { socket?: { localAddress?: string; localPort?: number } }).socket;
  markSelfSocket(sock?.localAddress, sock?.localPort);
});
