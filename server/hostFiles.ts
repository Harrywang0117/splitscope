import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.ts';

const run = promisify(execFile);
const MARK = '@@SPLITSCOPE-FILE@@';

/**
 * Reads files that live on the router. In Docker they are bind-mounted under a prefix
 * (HOST_FILES=/host); on a dev Mac they are fetched over ssh (HOST_FILES=ssh:<alias>).
 * Missing files come back as null.
 */
export async function readHostFiles(paths: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  if (config.hostFiles.startsWith('ssh:')) {
    const host = config.hostFiles.slice(4);
    const script = paths.map((p) => `echo '${MARK} ${p}'; cat '${p}' 2>/dev/null`).join('; ');
    const { stdout } = await run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, script], {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 20000,
    });
    for (const p of paths) out[p] = null;
    for (const chunk of stdout.split(`${MARK} `).slice(1)) {
      const nl = chunk.indexOf('\n');
      const p = nl < 0 ? chunk : chunk.slice(0, nl);
      const body = nl < 0 ? '' : chunk.slice(nl + 1);
      out[p] = body.length ? body : null;
    }
    return out;
  }
  await Promise.all(
    paths.map(async (p) => {
      // /proc is the container's own view; with network_mode: host it is the router's netns
      const real = p.startsWith('/proc/') ? p : path.join(config.hostFiles, p);
      try {
        out[p] = await fs.readFile(real, 'utf8');
      } catch {
        out[p] = null;
      }
    }),
  );
  return out;
}

export async function readHostFile(p: string): Promise<string | null> {
  return (await readHostFiles([p]))[p];
}
