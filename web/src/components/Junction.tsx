import { useEffect, useRef } from 'react';

/**
 * The live brand mark: a dithered junction where pixel particles stream in from the left and split
 * into the proxy branch (up, accent) and the direct branch (down, green). Spawn rate follows total
 * throughput, the split follows the real proxy/direct byte share. Static under reduced motion.
 */

const N = 18;
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];
const TRUNK = [1, 9, 7.5, 9];
const UP = [7.5, 9, 16.5, 2.5];
const DOWN = [7.5, 9, 16.5, 15.5];

function dist(px: number, py: number, s: number[]) {
  const [ax, ay, bx, by] = s;
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

interface Particle {
  t: number; // 0..2: 0-1 along the trunk, 1-2 along the branch
  up: boolean;
  speed: number;
}

export function Junction({ size = 60, proxyBps, directBps }: { size?: number; proxyBps: number; directBps: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ proxyBps, directBps });
  live.current = { proxyBps, directBps };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const cell = (size * dpr) / N;
    const css = getComputedStyle(document.documentElement);
    const color = (v: string, fb: string) => css.getPropertyValue(v).trim() || fb;
    const accent = color('--accent', '#00bbff');
    const go = color('--go', '#16a34a');
    const base = color('--ink-3', '#a1a1aa');

    // static dithered mark
    const mark: { x: number; y: number; a: number }[] = [];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const d = Math.min(dist(x + 0.5, y + 0.5, TRUNK), dist(x + 0.5, y + 0.5, UP), dist(x + 0.5, y + 0.5, DOWN));
        const glow = Math.max(0, 1 - d / 3.2);
        if (d < 1.05) mark.push({ x, y, a: 0.72 });
        else if (glow * 16 > BAYER[y % 4][x % 4] + 1) mark.push({ x, y, a: 0.12 + glow * 0.18 });
      }
    }
    const heat = new Float32Array(N * N); // particle trail per cell
    const hue = new Uint8Array(N * N); // 1 = proxy, 2 = direct, 0 = trunk
    const particles: Particle[] = [];
    let spawnAcc = 0;
    let raf = 0;
    let last = performance.now();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const pos = (p: Particle): [number, number] => {
      if (p.t < 1) return [TRUNK[0] + (TRUNK[2] - TRUNK[0]) * p.t, TRUNK[1]];
      const s = p.up ? UP : DOWN;
      const k = p.t - 1;
      return [s[0] + (s[2] - s[0]) * k, s[1] + (s[3] - s[1]) * k];
    };

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const m of mark) {
        const i = m.y * N + m.x;
        const h = heat[i];
        ctx.globalAlpha = Math.min(1, m.a + h);
        ctx.fillStyle = h > 0.05 ? (hue[i] === 2 ? go : accent) : m.a > 0.6 ? accent : base;
        ctx.fillRect(m.x * cell + cell * 0.07, m.y * cell + cell * 0.07, cell * 0.86, cell * 0.86);
      }
      ctx.globalAlpha = 1;
    };

    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { proxyBps: p, directBps: d } = live.current;
      const total = p + d;
      // ~0.6 particles/s when idle, up to ~14/s on a busy line (log scale)
      const rate = 0.6 + Math.min(13, Math.log10(1 + total / 2000) * 4);
      spawnAcc += rate * dt;
      while (spawnAcc >= 1 && particles.length < 40) {
        spawnAcc -= 1;
        particles.push({ t: 0, up: Math.random() < (total ? p / total : 0.5), speed: 0.9 + Math.random() * 0.5 });
      }
      for (let i = 0; i < heat.length; i++) heat[i] *= 0.86;
      for (let i = particles.length - 1; i >= 0; i--) {
        const q = particles[i];
        q.t += q.speed * dt;
        if (q.t >= 2) {
          particles.splice(i, 1);
          continue;
        }
        const [x, y] = pos(q);
        const cx = Math.floor(x);
        const cy = Math.floor(y);
        if (cx < 0 || cy < 0 || cx >= N || cy >= N) continue;
        const k = cy * N + cx;
        heat[k] = Math.min(0.9, heat[k] + 0.55);
        hue[k] = q.t < 1 ? 0 : q.up ? 1 : 2;
      }
      draw();
      raf = requestAnimationFrame(step);
    };

    if (reduced) draw();
    else raf = requestAnimationFrame(step);
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !reduced) {
        last = performance.now();
        raf = requestAnimationFrame(step);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [size]);

  const total = proxyBps + directBps;
  const share = total ? Math.round((proxyBps / total) * 100) : 0;
  return (
    <canvas
      ref={ref}
      style={{ width: size, height: size }}
      className="block"
      role="img"
      aria-label={total ? `实时流量：代理 ${share}%，直连 ${100 - share}%` : '分流镜'}
      title={total ? `上支路 = 代理 ${share}% · 下支路 = 直连 ${100 - share}%` : '上支路 = 代理 · 下支路 = 直连'}
    />
  );
}
