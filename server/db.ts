import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

fs.mkdirSync(config.dataDir, { recursive: true });

const file = path.join(config.dataDir, 'splitscope.db');
// the project used to be called route-lens: carry an old database over (with its WAL) on first start
const legacy = path.join(config.dataDir, 'route-lens.db');
if (!fs.existsSync(file) && fs.existsSync(legacy)) {
  for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(legacy + ext)) fs.renameSync(legacy + ext, file + ext);
}

export const db = new DatabaseSync(file);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS devices (
    key TEXT PRIMARY KEY,          -- lowercase MAC, or "ip:<addr>" for MAC-less sources
    name TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bm7 (
    dir TEXT PRIMARY KEY,
    sha TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    rules TEXT NOT NULL,           -- JSON [[type, value], ...]
    count INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    query TEXT NOT NULL,
    summary TEXT NOT NULL,
    results TEXT NOT NULL
  );
`);

export function kvGet<T>(key: string): { value: T; updatedAt: number } | null {
  const row = db.prepare('SELECT value, updated_at FROM kv WHERE key = ?').get(key) as
    | { value: string; updated_at: number }
    | undefined;
  return row ? { value: JSON.parse(row.value) as T, updatedAt: row.updated_at } : null;
}

export function kvSet(key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, JSON.stringify(value), Date.now());
}
