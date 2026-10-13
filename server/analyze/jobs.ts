import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AnalysisSummary, ProbeResult, ProbeTarget } from '../../shared/types.ts';
import { db } from '../db.ts';
import { recordProbeHits } from '../history/drafts.ts';
import { isDirectNode } from '../mihomo/connStore.ts';
import { ensureFreshSnapshot } from '../mihomo/snapshot.ts';
import { annotate, probeOne } from './probe.ts';
import { summarize } from './report.ts';

export interface Job {
  id: string;
  query: string;
  createdAt: number;
  targets: ProbeTarget[];
  results: (ProbeResult | null)[];
  done: boolean;
  summary?: AnalysisSummary;
  savedId?: number;
  configPath?: string;
  events: EventEmitter;
}

const jobs = new Map<string, Job>();
const CONCURRENCY = 8;

export function getJob(id: string) {
  return jobs.get(id);
}

export function startJob(query: string, targets: ProbeTarget[], port = 443): Job {
  const job: Job = {
    id: randomUUID(),
    query,
    createdAt: Date.now(),
    targets,
    results: targets.map(() => null),
    done: false,
    events: new EventEmitter(),
  };
  job.events.setMaxListeners(20);
  jobs.set(job.id, job);
  // drop finished jobs after an hour
  for (const [id, j] of jobs) if (j.done && Date.now() - j.createdAt > 3600_000) jobs.delete(id);

  void (async () => {
    try {
      const snap = await ensureFreshSnapshot();
      job.configPath = snap.configPath;
      let next = 0;
      const worker = async () => {
        for (let i = next++; i < targets.length; i = next++) {
          const r = await probeOne(targets[i], snap, port);
          const node = r.chain?.[r.chain.length - 1] ?? '';
          await annotate(r, isDirectNode(node));
          job.results[i] = r;
          job.events.emit('result', { i, result: r });
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
    } catch (e) {
      for (let i = 0; i < targets.length; i++) {
        job.results[i] ??= { target: targets[i], status: 'error', error: (e as Error).message };
      }
    }
    const results = job.results.map((r, i) => r ?? { target: targets[i], status: 'error' as const });
    job.summary = summarize(query, results);
    try {
      recordProbeHits(results);
    } catch (e) {
      console.error('[drafts]', (e as Error).message);
    }
    const info = db
      .prepare('INSERT INTO analyses (created_at, query, summary, results) VALUES (?, ?, ?, ?)')
      .run(job.createdAt, query, JSON.stringify(job.summary), JSON.stringify(results));
    job.savedId = Number(info.lastInsertRowid);
    job.done = true;
    job.events.emit('done', { summary: job.summary, savedId: job.savedId });
  })();
  return job;
}

export function listAnalyses(limit = 50) {
  const rows = db
    .prepare('SELECT id, created_at, query, summary FROM analyses ORDER BY id DESC LIMIT ?')
    .all(limit) as { id: number; created_at: number; query: string; summary: string }[];
  return rows.map((r) => ({ id: r.id, createdAt: r.created_at, query: r.query, summary: JSON.parse(r.summary) as AnalysisSummary }));
}

export function getAnalysis(id: number) {
  const r = db.prepare('SELECT * FROM analyses WHERE id = ?').get(id) as
    | { id: number; created_at: number; query: string; summary: string; results: string }
    | undefined;
  return r
    ? {
        id: r.id,
        createdAt: r.created_at,
        query: r.query,
        summary: JSON.parse(r.summary) as AnalysisSummary,
        results: JSON.parse(r.results) as ProbeResult[],
      }
    : null;
}

export function deleteAnalysis(id: number) {
  db.prepare('DELETE FROM analyses WHERE id = ?').run(id);
}
