import { config } from '../config.ts';

export interface ConnMetadata {
  network: string;
  type: string;
  sourceIP: string;
  destinationIP: string;
  sourcePort: string;
  destinationPort: string;
  inboundName?: string;
  host: string;
  dnsMode?: string;
  process?: string;
  processPath?: string;
  remoteDestination?: string;
  sniffHost?: string;
}

export interface RawConnection {
  id: string;
  metadata: ConnMetadata;
  upload: number;
  download: number;
  start: string;
  chains: string[];
  providerChains?: string[];
  rule: string;
  rulePayload: string;
}

export interface RawRule {
  index?: number;
  type: string;
  payload: string;
  proxy: string;
  extra?: { disabled?: boolean; hitCount?: number; hitAt?: string };
}

export interface RawProxy {
  name: string;
  type: string;
  now?: string;
  all?: string[];
  udp?: boolean;
}

function authHeaders(): Record<string, string> {
  return config.clashSecret ? { Authorization: `Bearer ${config.clashSecret}` } : {};
}

export async function api<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(config.clashApi + pathname, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers as Record<string, string>) },
    signal: init.signal ?? AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`mihomo ${pathname} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const mihomo = {
  version: () => api<{ meta?: boolean; version: string }>('/version'),
  configs: () => api<Record<string, unknown>>('/configs'),
  rules: async () => (await api<{ rules: RawRule[] }>('/rules')).rules,
  proxies: async () => (await api<{ proxies: Record<string, RawProxy> }>('/proxies')).proxies,
  ruleProviders: async () =>
    (
      await api<{
        providers: Record<string, { behavior: string; format: string; ruleCount: number; updatedAt?: string }>;
      }>('/providers/rules')
    ).providers,
  proxyProviders: async () =>
    (
      await api<{
        providers: Record<string, { vehicleType: string; updatedAt?: string; proxies?: { name: string; type: string }[]; subscriptionInfo?: { Upload?: number; Download?: number; Total?: number; Expire?: number } }>;
      }>('/providers/proxies')
    ).providers,
  connections: async () =>
    (await api<{ connections: RawConnection[] | null }>('/connections')).connections ?? [],
  dnsQuery: (name: string, type = 'A') =>
    api<{ Status: number; Answer?: { type: number; data: string; TTL: number }[] }>(
      `/dns/query?name=${encodeURIComponent(name)}&type=${type}`,
    ),
};

/**
 * Keeps a WebSocket to a mihomo streaming endpoint open, reconnecting with backoff.
 *
 * Node's WebSocket (undici 6) fires only `error`, never `close`, when the handshake fails (port
 * closed, non-101 answer), and nothing at all when the peer accepts the connection but never
 * answers. Waiting for `close` alone once left the live view dead for two days after OpenClash's
 * 03:00 geo update reloaded the kernel. So error, close, a handshake slower than `connectTimeoutMs`
 * and (with `staleMs`) an open stream that goes quiet all replace the socket.
 */
export function streamWs(
  pathname: string,
  onMessage: (data: unknown) => void,
  onStatus?: (up: boolean) => void,
  opts: { staleMs?: number; connectTimeoutMs?: number } = {},
): { close: () => void } {
  const { staleMs = 0, connectTimeoutMs = 10_000 } = opts;
  let closed = false;
  let up = false;
  let delay = 1000;
  let retry: NodeJS.Timeout | undefined;
  let stop: () => void = () => {};
  const base = config.clashApi.replace(/^http/, 'ws');
  const sep = pathname.includes('?') ? '&' : '?';
  const url = `${base}${pathname}${config.clashSecret ? `${sep}token=${encodeURIComponent(config.clashSecret)}` : ''}`;

  const setUp = (v: boolean) => {
    if (up === v) return;
    up = v;
    onStatus?.(v);
  };

  const open = () => {
    if (closed) return;
    const sock = new WebSocket(url);
    let last = Date.now();
    let done = false;
    const watch = setInterval(() => {
      const quiet = Date.now() - last;
      if (sock.readyState === WebSocket.CONNECTING ? quiet > connectTimeoutMs : staleMs > 0 && quiet > staleMs) drop();
    }, 1000);
    // Handlers come off before close(): closing a socket that failed while connecting fires another
    // error event, which used to recurse until the stack overflowed. The reconnect does not wait for
    // a close event either, since mihomo never answers a close frame.
    const drop = () => {
      if (done) return;
      done = true;
      clearInterval(watch);
      sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null;
      if (sock.readyState !== WebSocket.CLOSED) sock.close();
      setUp(false);
      if (closed) return;
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, 30_000);
    };
    stop = drop;
    sock.onopen = () => {
      last = Date.now();
      delay = 1000;
      setUp(true);
    };
    sock.onmessage = (ev) => {
      last = Date.now();
      try {
        onMessage(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)));
      } catch {
        /* ignore malformed frame */
      }
    };
    sock.onerror = drop;
    sock.onclose = drop;
  };
  open();
  return {
    close: () => {
      closed = true;
      clearTimeout(retry);
      stop();
    },
  };
}
