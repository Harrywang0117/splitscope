import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../server/config.ts';
import { streamWs } from '../server/mihomo/client.ts';

/**
 * A stand-in for the kernel's streaming endpoint. Each handshake takes the next mode:
 * reject = answer 503, hang = accept the connection and never answer, accept = upgrade and send
 * one frame ({ n }), then stay quiet.
 */
type Mode = 'reject' | 'hang' | 'accept';

const servers: http.Server[] = [];
const sockets: Socket[] = [];
const streams: { close: () => void }[] = [];

async function fakeKernel(modes: Mode[]) {
  let n = 0;
  const server = http.createServer();
  server.on('upgrade', (req, socket: Socket) => {
    sockets.push(socket);
    const mode = modes[Math.min(n++, modes.length - 1)];
    if (mode === 'hang') return;
    if (mode === 'reject') {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const payload = Buffer.from(JSON.stringify({ n }));
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  config.clashApi = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function watch(opts?: Parameters<typeof streamWs>[3]) {
  const messages: unknown[] = [];
  const status: boolean[] = [];
  streams.push(streamWs('/connections', (m) => messages.push(m), (up) => status.push(up), opts));
  return { messages, status };
}

async function until(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

afterEach(() => {
  for (const s of streams.splice(0)) s.close();
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) s.close();
});

describe('streamWs', () => {
  it('reconnects after a failed handshake', async () => {
    await fakeKernel(['reject', 'accept']);
    const w = watch();
    await until(() => w.messages.length > 0, 4000);
    expect(w.messages).toEqual([{ n: 2 }]);
    expect(w.status).toEqual([true]);
  });

  it('gives up on a handshake that never completes', async () => {
    await fakeKernel(['hang', 'accept']);
    const w = watch({ connectTimeoutMs: 1000 });
    await until(() => w.messages.length > 0, 6000);
    expect(w.messages).toEqual([{ n: 2 }]);
  }, 10_000);

  it('replaces an open stream that goes quiet', async () => {
    await fakeKernel(['accept', 'accept']);
    const w = watch({ staleMs: 1000 });
    await until(() => w.messages.length > 1, 6000);
    expect(w.messages).toEqual([{ n: 1 }, { n: 2 }]);
    expect(w.status).toEqual([true, false, true]);
  }, 10_000);
});
