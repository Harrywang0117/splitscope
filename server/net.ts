import fs from 'node:fs/promises';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { config } from './config.ts';

// Router-originated traffic is not transparently proxied, so outbound fetches (GitHub, DoH)
// go explicitly through the mihomo mixed port.
const agent = new ProxyAgent(config.mixedProxy);

export async function proxyFetch(url: string, init: { headers?: Record<string, string>; timeoutMs?: number } = {}) {
  const res = await undiciFetch(url, {
    dispatcher: agent,
    headers: { 'user-agent': 'splitscope/1.0', ...init.headers },
    signal: AbortSignal.timeout(init.timeoutMs ?? 30000),
  });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res;
}

export async function proxyText(url: string, timeoutMs?: number): Promise<string> {
  return (await proxyFetch(url, { timeoutMs })).text();
}

export async function proxyJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  return (await (await proxyFetch(url, { headers })).json()) as T;
}

/** Downloads to a temp file and renames, so readers never see a half-written file. */
export async function downloadFile(url: string, dest: string, timeoutMs = 180000): Promise<number> {
  const res = await proxyFetch(url, { timeoutMs });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error(`download ${url}: suspiciously small (${buf.length} bytes)`);
  await fs.writeFile(`${dest}.tmp`, buf);
  await fs.rename(`${dest}.tmp`, dest);
  return buf.length;
}
