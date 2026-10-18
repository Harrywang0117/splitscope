import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ProbeTarget } from '../shared/types.ts';
import { curatedLists } from './analyze/curated.ts';
import { getAnalysis, getJob, listAnalyses, deleteAnalysis, startJob } from './analyze/jobs.ts';
import {
  classifyInput,
  expandCandidates,
  reverseCandidates,
  searchCandidates,
  targetFromInput,
} from './analyze/sources.ts';
import { config } from './config.ts';
import { probeReadiness } from './analyze/probe.ts';
import { acquireInstance } from './instance.ts';
import { makeBackup, restoreBackup, type Backup } from './backup.ts';
import { addDrafts, deleteDraft, draftsCovering, listDrafts, pendingDraftCount, setDraftStatus, type DraftInput } from './history/drafts.ts';
import { canEdit, clientIp, guardWrites } from './access.ts';
import { discoverDevices, listDevices, onDevicesChanged, refreshDevices, saveAlias } from './enrich/device.ts';
import { identifyHost, identifyIp, providerOf } from './enrich/service.ts';
import { initIntel, intel, intelChangelog, onIntelChanged, updateIntel } from './enrich/intel.ts';
import { liveEvents, liveState, recentSourceIps, startLive } from './mihomo/connStore.ts';
import { getLastChange, getSnapshot, onSnapshot, refreshSnapshot } from './mihomo/snapshot.ts';
import { daily, scheduleInfo, startScheduler } from './scheduler.ts';
import { favicon, lastDelays, testDelays } from './extras.ts';
import { healthReport, startHealth } from './history/health.ts';
import { checkup, deviceDetail, flow, isDim, nodes, parseRange, regions, summary, top, trend } from './history/queries.ts';
import { historyStatus, startHistory } from './history/store.ts';
import { dropRelayHistory } from './history/relayCleanup.ts';
import { CONN_COLUMNS, getSettings, iterateConnLog, queryConnLog, saveSettings, startConnLog, storageStats, type ConnQuery } from './history/connlog.ts';
import { addExpectations, caseConnections, deleteExpectation, listCases, listExpectations, updateCases, type CaseRow } from './history/cases.ts';

const app = new Hono();
app.use('/api/*', guardWrites);
const MAX_TARGETS = 2000;

/* ---------- status & refresh ---------- */

function snapshotMeta() {
  const s = getSnapshot();
  return s
    ? {
        takenAt: s.takenAt,
        trigger: s.trigger,
        version: s.version,
        configPath: s.configPath,
        configName: path.basename(s.configPath || ''),
        rules: s.running.rules.length,
        diskRules: s.disk?.rules.length ?? null,
        customRules: s.customRules.length,
        groups: s.groups.length,
        providers: s.providers.length,
        drift: s.drift,
        lastChange: getLastChange(),
      }
    : null;
}

app.get('/api/status', (c) =>
  c.json({
    access: { ip: clientIp(c), canEdit: canEdit(clientIp(c)), editNets: config.editNets },
    drafts: { pending: pendingDraftCount() },
    live: { connected: liveState().connected },
    snapshot: snapshotMeta(),
    intel: intel.status,
    schedule: scheduleInfo(),
    history: historyStatus(),
  }),
);

/* ---------- history ---------- */

const range = (c: { req: { query: (k: string) => string | undefined } }) => parseRange(c.req.query('range'));

app.get('/api/history/summary', (c) => c.json(summary(range(c))));
app.get('/api/history/trend', (c) => c.json(trend(range(c), c.req.query('by') === 'group' ? 'group' : 'direct')));
app.get('/api/history/top', (c) => {
  const dim = c.req.query('dim') ?? 'service';
  if (!isDim(dim)) return c.json({ error: 'bad dim' }, 400);
  return c.json(
    top(range(c), dim, {
      limit: Number(c.req.query('limit') ?? 20),
      offset: Number(c.req.query('offset') ?? 0),
      sort: c.req.query('sort'),
      order: c.req.query('order'),
      src: c.req.query('src') || undefined,
      q: c.req.query('q') || undefined,
    }),
  );
});
app.get('/api/history/device/:ip', (c) => c.json(deviceDetail(range(c), c.req.param('ip'))));
app.get('/api/history/flow', (c) => c.json(flow(range(c), c.req.query('left') === 'service' ? 'service' : 'device')));
app.get('/api/checkup', (c) => c.json(checkup(range(c))));
app.get('/api/regions', (c) => c.json(regions(range(c))));
app.get('/api/nodes', (c) => c.json({ nodes: nodes(range(c)), delays: lastDelays(), providers: getSnapshot()?.providerInfo ?? [] }));
app.post('/api/nodes/delay', async (c) => {
  const { names } = (await c.req.json()) as { names?: string[] };
  return c.json({ results: await testDelays((names ?? []).map(String)) });
});
app.get('/api/health', (c) => c.json(healthReport(range(c))));

/* ---------- connection log, cases, expectations ---------- */

function connQuery(c: { req: { query: (k: string) => string | undefined } }): ConnQuery {
  const n = (k: string) => (c.req.query(k) ? Number(c.req.query(k)) : undefined);
  return {
    from: n('from'),
    to: n('to'),
    src: c.req.query('src') || undefined,
    group: c.req.query('group') || undefined,
    q: c.req.query('q') || undefined,
    fallback: c.req.query('fallback') === '1',
    anomaly: c.req.query('anomaly') === '1',
    limit: n('limit'),
    offset: n('offset'),
  };
}

const csvCell = (v: unknown) => {
  const t = v == null ? '' : String(v);
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const localFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: process.env.TIMEZONE || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
/** "2026-10-13 09:41:07" in the household's time zone */
const iso = (ms: unknown) => (ms ? localFmt.format(new Date(Number(ms))) : '');

/** Streams rows as CSV (Excel-friendly BOM) or a JSON array, without holding them all in memory. */
function streamRows(format: string, name: string, columns: readonly (readonly [string, string])[], rows: Iterable<Record<string, unknown>>, map: (r: Record<string, unknown>) => Record<string, unknown>) {
  const enc = new TextEncoder();
  const it = rows[Symbol.iterator]();
  let first = true;
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      let chunk = '';
      if (first) chunk += format === 'json' ? '[\n' : '\ufeff' + columns.map(([, label]) => csvCell(label)).join(',') + '\n';
      for (let i = 0; i < 500; i++) {
        const n = it.next();
        if (n.done) {
          if (format === 'json') chunk += '\n]\n';
          ctrl.enqueue(enc.encode(chunk));
          ctrl.close();
          return;
        }
        const r = map(n.value);
        chunk += format === 'json' ? `${first && i === 0 ? '' : ',\n'}${JSON.stringify(r)}` : columns.map(([k]) => csvCell(r[k])).join(',') + '\n';
      }
      first = false;
      ctrl.enqueue(enc.encode(chunk));
    },
  });
  return new Response(body, {
    headers: {
      'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.${format === 'json' ? 'json' : 'csv'}`,
    },
  });
}

app.get('/api/connlog', (c) => c.json(queryConnLog(connQuery(c))));
app.get('/api/connlog/export', (c) => {
  const f = connQuery(c);
  const names = new Map(listDevices(recentSourceIps()).map((d) => [d.ip, d.label]));
  const cols = [['start', '开始时间'], ['end', '结束时间'], ['device', '设备'], ...CONN_COLUMNS.filter(([k]) => k !== 'start' && k !== 'end')] as const;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
  return streamRows(c.req.query('format') ?? 'csv', `连接记录-${stamp}`, cols, iterateConnLog(f), (r) => ({ ...r, start: iso(r.start), end: iso(r.end), device: names.get(String(r.src)) ?? r.src }));
});

app.get('/api/cases', (c) => {
  const res = listCases({
    status: c.req.query('status') ?? 'open',
    reason: c.req.query('reason') || undefined,
    q: c.req.query('q') || undefined,
    sort: c.req.query('sort'),
    limit: Number(c.req.query('limit') ?? 100),
    offset: Number(c.req.query('offset') ?? 0),
  });
  // mark cases whose host a drafted rule already covers
  const marks = draftsCovering(res.rows.map((r) => r.host));
  return c.json({ ...res, rows: res.rows.map((r) => ({ ...r, draft: marks.get(r.host.toLowerCase()) ?? null })) });
});
app.patch('/api/cases', async (c) => {
  const body = (await c.req.json()) as { keys?: string[]; status?: string; note?: string };
  updateCases((body.keys ?? []).map(String), { status: body.status, note: body.note });
  return c.json({ ok: true });
});
app.get('/api/cases/conns', (c) => c.json(caseConnections(c.req.query('key') ?? '')));
app.get('/api/cases/export', (c) => {
  const { rows } = listCases({ status: c.req.query('status') ?? 'all', reason: c.req.query('reason') || undefined, q: c.req.query('q') || undefined, limit: 500 });
  const names = new Map(listDevices(recentSourceIps()).map((d) => [d.ip, d.label]));
  const REASON: Record<string, string> = { expect: '违反预期', cn_proxy: '国内走代理', intl_direct: '境外走直连', fallback: '落到兜底', udp_fallback: 'UDP 兜底' };
  const STATUS: Record<string, string> = { open: '待处理', fixed: '已修复', ignored: '已忽略' };
  const cols = [
    ['reason', '异常'], ['status', '状态'], ['host', '域名/IP'], ['service', '服务'], ['grp', '实际策略组'], ['expected', '期望策略组'],
    ['rule', '规则类型'], ['rule_payload', '规则内容'], ['rule_index', '规则序号'], ['chain', '线路'], ['node', '节点'],
    ['scope', '国内/境外'], ['country', '国家'], ['target_ip', '目标 IP'], ['org', '运营商'], ['network', '网络'],
    ['count', '次数'], ['devices', '设备'], ['first_seen', '首次'], ['last_seen', '最近'], ['regressed', '复发'], ['note', '备注'],
  ] as const;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
  return streamRows(c.req.query('format') ?? 'csv', `异常案例-${stamp}`, cols, rows as unknown as Record<string, unknown>[], (r) => {
    const x = r as unknown as CaseRow;
    return {
      ...x,
      reason: REASON[x.reason] ?? x.reason,
      status: STATUS[x.status] ?? x.status,
      devices: (JSON.parse(x.devices) as string[]).map((ip) => names.get(ip) ?? ip).join(' / '),
      first_seen: iso(x.first_seen),
      last_seen: iso(x.last_seen),
      regressed: x.regressed ? '是' : '',
    };
  });
});

app.get('/api/expectations', (c) => c.json(listExpectations()));
app.post('/api/expectations', async (c) => {
  const body = (await c.req.json()) as { items?: { kind: 'domain' | 'suffix' | 'keyword' | 'ip' | 'cidr'; value: string; grp: string; note?: string; source?: string }[] };
  return c.json({ added: addExpectations(body.items ?? []) });
});
app.delete('/api/expectations/:id', (c) => {
  deleteExpectation(Number(c.req.param('id')));
  return c.json({ ok: true });
});

app.get('/api/drafts', (c) => {
  const st = c.req.query('status');
  return c.json(listDrafts(st === 'applied' || st === 'all' ? st : 'pending'));
});
app.post('/api/drafts', async (c) => {
  const body = await c.req.json<{ items?: DraftInput[]; expect?: boolean }>();
  return c.json(addDrafts(Array.isArray(body.items) ? body.items.slice(0, 2000) : [], body.expect !== false));
});
app.patch('/api/drafts', async (c) => {
  const body = await c.req.json<{ ids?: number[]; status?: string }>();
  if (!Array.isArray(body.ids) || (body.status !== 'pending' && body.status !== 'applied')) return c.json({ error: 'bad request' }, 400);
  setDraftStatus(body.ids.map(Number), body.status);
  return c.json({ ok: true });
});
app.delete('/api/drafts/:id', (c) => {
  deleteDraft(Number(c.req.param('id')));
  return c.json({ ok: true });
});
app.get('/api/backup', (c) => {
  const stamp = localFmt.format(new Date()).replace(/[-: ]/g, '').slice(0, 12);
  c.header('content-disposition', `attachment; filename="splitscope-backup-${stamp}.json"`);
  return c.json(makeBackup());
});
app.post('/api/restore', async (c) => {
  try {
    return c.json({ ok: true, restored: restoreBackup(await c.req.json<Backup>()) });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
app.get('/api/settings', (c) => c.json({ settings: getSettings(), storage: storageStats() }));
app.put('/api/settings', async (c) => c.json({ settings: saveSettings((await c.req.json()) as Record<string, number>), storage: storageStats() }));
app.get('/api/favicon/:site', async (c) => {
  const icon = await favicon(c.req.param('site'));
  if (!icon) return c.body(null, 404, { 'cache-control': 'public, max-age=86400' });
  return c.body(new Uint8Array(icon.buf), 200, { 'content-type': icon.type, 'cache-control': 'public, max-age=604800' });
});

app.get('/api/snapshot', (c) => c.json({ meta: snapshotMeta(), snapshot: getSnapshot() }));

app.post('/api/snapshot/refresh', async (c) => {
  try {
    await refreshSnapshot('manual');
    return c.json({ ok: true, meta: snapshotMeta() });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 502);
  }
});

app.get('/api/intel', (c) => c.json({ status: intel.status, changelog: intelChangelog() }));

app.post('/api/intel/refresh', (c) => {
  void updateIntel('manual').catch(() => undefined);
  return c.json({ ok: true, status: intel.status });
});

/* ---------- live connections ---------- */

app.get('/api/live', (c) =>
  streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
    await send('init', { ...liveState(), devices: listDevices(recentSourceIps()) });
    const onTick = (t: unknown) => void send('tick', t);
    const onStatus = (up: boolean) => void send('status', { connected: up });
    const onMeta = () => void send('meta', {});
    const offDevices = onDevicesChanged(() => void send('devices', listDevices(recentSourceIps())));
    liveEvents.on('tick', onTick);
    liveEvents.on('status', onStatus);
    liveEvents.on('snapshot', onMeta);
    liveEvents.on('intel', onMeta);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    liveEvents.off('tick', onTick);
    liveEvents.off('status', onStatus);
    liveEvents.off('snapshot', onMeta);
    liveEvents.off('intel', onMeta);
    offDevices();
  }),
);

/* ---------- devices ---------- */

app.get('/api/devices', (c) => c.json(listDevices(recentSourceIps())));

app.put('/api/devices/:key', async (c) => {
  const body = (await c.req.json()) as { name?: string; kind?: string; note?: string };
  saveAlias(decodeURIComponent(c.req.param('key')), {
    name: String(body.name ?? '').slice(0, 60),
    kind: String(body.kind ?? '').slice(0, 20),
    note: String(body.note ?? '').slice(0, 200),
  });
  return c.json({ ok: true });
});

/* ---------- analyzer ---------- */

app.get('/api/search', (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (!q) return c.json({ input: null, candidates: [], reverse: [] });
  const direct = /^(geosite|bm7):(.+)$/.exec(q);
  if (direct) {
    const hit = searchCandidates(direct[2]).filter((x) => x.id.toLowerCase() === q.toLowerCase());
    return c.json({ input: { kind: 'name', value: q }, candidates: hit, reverse: [] });
  }
  const input = classifyInput(q);
  if (input.kind === 'name') return c.json({ input, candidates: searchCandidates(input.value), reverse: [] });
  const info =
    input.kind === 'domain'
      ? { service: identifyHost(input.value) }
      : { service: identifyIp(input.value.split('/')[0]), provider: providerOf(input.value.split('/')[0]) };
  return c.json({ input, target: targetFromInput(input.kind, input.value), info, candidates: [], reverse: reverseCandidates(input.kind, input.value) });
});

app.get('/api/curated', (c) => c.json(curatedLists().map(({ entries, ...meta }) => ({ ...meta, count: entries.length }))));

app.post('/api/expand', async (c) => {
  const { ids } = (await c.req.json()) as { ids: string[] };
  return c.json({ targets: expandCandidates((ids ?? []).slice(0, 20)) });
});

app.post('/api/analyze', async (c) => {
  const body = (await c.req.json()) as { query?: string; targets?: ProbeTarget[]; lines?: string[]; port?: number };
  const targets: ProbeTarget[] = [...(body.targets ?? [])];
  for (const line of body.lines ?? []) {
    const input = classifyInput(line);
    if (input.kind !== 'name') targets.push(targetFromInput(input.kind, input.value));
  }
  if (!targets.length) return c.json({ error: '没有可测试的目标' }, 400);
  const ready = await probeReadiness().catch(() => null);
  if (!ready) return c.json({ error: '连不上内核 API，没法测试' }, 503);
  if (!ready.ok) return c.json({ error: ready.problem }, 409);
  const port = Number(body.port) > 0 && Number(body.port) < 65536 ? Number(body.port) : 443;
  const job = startJob(String(body.query ?? '').slice(0, 200), targets.slice(0, MAX_TARGETS), port);
  return c.json({ jobId: job.id, total: job.targets.length });
});

app.get('/api/analyze/:id/stream', (c) => {
  const job = getJob(c.req.param('id'));
  if (!job) return c.json({ error: 'job not found' }, 404);
  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
    await send('init', { query: job.query, targets: job.targets, results: job.results, configPath: job.configPath });
    if (job.done) {
      await send('done', { summary: job.summary, savedId: job.savedId });
      return;
    }
    const onResult = (d: unknown) => void send('result', d);
    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));
    const onDone = (d: unknown) => void send('done', d).then(finish);
    job.events.on('result', onResult);
    job.events.once('done', onDone);
    stream.onAbort(() => finish());
    await finished;
    job.events.off('result', onResult);
    job.events.off('done', onDone);
  });
});

app.get('/api/probe/ready', async (c) => c.json(await probeReadiness().catch(() => ({ ok: false, logLevel: '', mode: '', problem: '连不上内核 API，没法测试' }))));
app.get('/api/analyses', (c) => c.json(listAnalyses()));
app.get('/api/analyses/:id', (c) => {
  const a = getAnalysis(Number(c.req.param('id')));
  return a ? c.json(a) : c.json({ error: 'not found' }, 404);
});
app.delete('/api/analyses/:id', (c) => {
  deleteAnalysis(Number(c.req.param('id')));
  return c.json({ ok: true });
});

/* ---------- static web ---------- */

if (fs.existsSync(config.webDir)) {
  const root = path.relative(process.cwd(), config.webDir) || '.';
  app.use('/assets/*', serveStatic({ root }));
  app.get('*', serveStatic({ root, path: 'index.html' }));
}

/* ---------- boot ---------- */

async function boot() {
  // before anything writes: a second copy on the same database would double-count traffic
  await acquireInstance();
  await initIntel();
  await refreshSnapshot('startup').catch((e) => console.error('[snapshot]', e.message));
  await refreshDevices().catch((e) => console.error('[devices]', e.message));
  try {
    const dropped = dropRelayHistory();
    if (dropped) console.log('[history] dropped relay hops recorded as traffic:', dropped);
  } catch (e) {
    console.error('[history] relay cleanup failed:', (e as Error).message);
  }
  startLive();
  startHistory();
  startConnLog();
  startHealth();
  setInterval(() => void refreshDevices().catch(() => undefined), 30_000);
  // ask devices their names (mDNS / SSDP); phones answer only when awake, so keep asking
  if (config.discovery) {
    const discover = () => void discoverDevices().catch((e) => console.error('[discover]', e.message));
    setTimeout(discover, 3_000);
    setInterval(discover, 3 * 60_000);
  }
  // pick up config reloads between the daily runs (cheap: rule list hash only)
  setInterval(() => {
    void import('./mihomo/snapshot.ts').then((m) => m.ensureFreshSnapshot()).catch(() => undefined);
  }, 5 * 60_000);

  daily({ name: 'snapshot', at: '04:30', run: () => refreshSnapshot('auto') });
  daily({ name: 'intel', at: '05:00', run: () => updateIntel('auto') });
  startScheduler();

  onSnapshot(() => liveEvents.emit('snapshot'));
  onIntelChanged(() => liveEvents.emit('intel'));

  serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
    console.log(`splitscope listening on http://0.0.0.0:${info.port}`);
  });
}

void boot();
