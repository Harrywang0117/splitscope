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
 */
export function streamWs(
  pathname: string,
  onMessage: (data: unknown) => void,
  onStatus?: (up: boolean) => void,
): { close: () => void } {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 1000;
  const base = config.clashApi.replace(/^http/, 'ws');
  const sep = pathname.includes('?') ? '&' : '?';
  const url = `${base}${pathname}${config.clashSecret ? `${sep}token=${encodeURIComponent(config.clashSecret)}` : ''}`;

  const open = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      delay = 1000;
      onStatus?.(true);
    };
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)));
      } catch {
        /* ignore malformed frame */
      }
    };
    const sock = ws;
    let retried = false;
    sock.onclose = () => {
      onStatus?.(false);
      if (closed || retried) return;
      retried = true;
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 30000);
    };
    // Do not call close() here: closing a socket that failed while connecting fires another
    // error event, which recursed until the stack overflowed. The close event follows an error
    // anyway and schedules the reconnect.
    sock.onerror = () => undefined;
  };
  open();
  return {
    close: () => {
      closed = true;
      ws?.close();
    },
  };
}
