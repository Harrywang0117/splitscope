import { useCallback, useEffect, useRef, useState } from 'react';
import type { Device, LiveConn, LiveTick } from '../../shared/types.ts';

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export async function sendJson<T>(url: string, method: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string; code?: string };
  // read-only device: one shared notice instead of every caller handling it
  if (r.status === 403 && data.code === 'readonly') window.dispatchEvent(new CustomEvent('splitscope:readonly', { detail: data.error }));
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

export interface SnapshotMeta {
  takenAt: number;
  trigger: string;
  version: string;
  configPath: string;
  configName: string;
  rules: number;
  diskRules: number | null;
  customRules: number;
  groups: number;
  providers: number;
  drift: { onlyRunning: string[]; onlyDisk: string[] } | null;
  lastChange: {
    at: number;
    configChanged: boolean;
    fromPath?: string;
    toPath?: string;
    added: string[];
    removed: string[];
    groupsAdded: string[];
    groupsRemoved: string[];
  } | null;
}

export interface AssetState {
  version: string;
  size: number;
  updatedAt: number;
  checkedAt: number;
  error?: string;
}

export interface IntelStatus {
  running: boolean;
  phase: string;
  lastRunAt: number;
  assets: Record<string, AssetState>;
  bm7: { dirs: number; syncedAt: number; progress?: string; error?: string };
  geosite: { categories: number; domains: number } | null;
}

/** Tell the shell the rule drafts changed (refreshes the sidebar count). */
export const draftsChanged = () => window.dispatchEvent(new Event('splitscope:drafts'));

export interface Status {
  access?: { ip: string; canEdit: boolean; editNets: string[] };
  drafts?: { pending: number };
  live: { connected: boolean };
  snapshot: SnapshotMeta | null;
  intel: IntelStatus;
  schedule: { name: string; at: string; lastRunDate: string | null; tz: string }[];
}

export interface LiveData {
  connected: boolean;
  active: Map<string, LiveConn>;
  closed: LiveConn[];
  devices: Map<string, Device>;
  totals: LiveTick['totals'];
  version: number;
  metaVersion: number;
}

const CLOSED_KEEP = 3000;

/** One EventSource for the whole app; state lives in refs and a version counter triggers renders. */
export function useLive(): LiveData {
  const active = useRef(new Map<string, LiveConn>());
  const closed = useRef<LiveConn[]>([]);
  const devices = useRef(new Map<string, Device>());
  const totals = useRef<LiveTick['totals']>({ up: 0, down: 0, upSpeed: 0, downSpeed: 0, active: 0 });
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState(0);
  const [metaVersion, setMetaVersion] = useState(0);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout>;
    const setDevices = (list: Device[]) => {
      devices.current = new Map(list.map((d) => [d.ip, d]));
    };
    const open = () => {
      es = new EventSource('/api/live');
      es.addEventListener('init', (e) => {
        const d = JSON.parse((e as MessageEvent).data) as {
          connected: boolean;
          active: LiveConn[];
          closed: LiveConn[];
          totals: LiveTick['totals'];
          devices: Device[];
        };
        active.current = new Map(d.active.map((c) => [c.id, c]));
        closed.current = d.closed;
        totals.current = d.totals;
        setDevices(d.devices);
        setConnected(d.connected);
        setVersion((v) => v + 1);
      });
      es.addEventListener('tick', (e) => {
        const t = JSON.parse((e as MessageEvent).data) as LiveTick;
        for (const c of t.added) active.current.set(c.id, { ...c, _new: true } as LiveConn);
        for (const [id, up, down, us, ds] of t.updated) {
          const c = active.current.get(id);
          if (c) Object.assign(c, { up, down, upSpeed: us, downSpeed: ds });
        }
        for (const p of t.patches) {
          const c = active.current.get(p.id);
          if (c) Object.assign(c, { target: p.target, targetApprox: p.targetApprox, service: p.service });
        }
        for (const [id, at] of t.closed) {
          const c = active.current.get(id);
          if (!c) continue;
          active.current.delete(id);
          closed.current.push({ ...c, closedAt: at, upSpeed: 0, downSpeed: 0 });
        }
        if (closed.current.length > CLOSED_KEEP * 1.2) closed.current = closed.current.slice(-CLOSED_KEEP);
        totals.current = t.totals;
        setVersion((v) => v + 1);
      });
      es.addEventListener('devices', (e) => {
        setDevices(JSON.parse((e as MessageEvent).data));
        setVersion((v) => v + 1);
      });
      es.addEventListener('status', (e) => setConnected(JSON.parse((e as MessageEvent).data).connected));
      es.addEventListener('meta', () => setMetaVersion((v) => v + 1));
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retry = setTimeout(open, 3000);
      };
    };
    open();
    return () => {
      clearTimeout(retry);
      es?.close();
    };
  }, []);

  return {
    connected,
    active: active.current,
    closed: closed.current,
    devices: devices.current,
    totals: totals.current,
    version,
    metaVersion,
  };
}

export function useStatus(metaVersion: number) {
  const [status, setStatus] = useState<Status | null>(null);
  const load = useCallback(() => {
    getJson<Status>('/api/status').then(setStatus).catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load, metaVersion]);
  return { status, reload: load };
}

export type Range = '1h' | '24h' | '7d' | '30d';

/** Fetches JSON and refetches when the url changes or every `refreshMs`; keeps the last data while loading. */
export function useData<T>(url: string | null, refreshMs = 60_000) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    setLoading(true);
    getJson<T>(url)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError('');
      })
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    const t = refreshMs ? setTimeout(() => setTick((x) => x + 1), refreshMs) : undefined;
    return () => {
      alive = false;
      if (t) clearTimeout(t);
    };
  }, [url, tick, refreshMs]);
  return { data, loading, error, reload: () => setTick((x) => x + 1) };
}
