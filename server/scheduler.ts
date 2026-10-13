import { kvGet, kvSet } from './db.ts';

const TZ = process.env.TIMEZONE || 'Asia/Shanghai';
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function nowParts() {
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}` };
}

export interface DailyJob {
  name: string;
  /** "HH:MM" in TIMEZONE */
  at: string;
  run: () => Promise<unknown>;
}

const jobs: DailyJob[] = [];

/** Runs each job once per day at or after its time (catches up after a restart past that time). */
export function daily(job: DailyJob) {
  jobs.push(job);
}

export function startScheduler() {
  const tick = async () => {
    const { date, hhmm } = nowParts();
    for (const j of jobs) {
      const key = `sched:${j.name}`;
      if (hhmm < j.at || kvGet<string>(key)?.value === date) continue;
      kvSet(key, date);
      try {
        await j.run();
      } catch (e) {
        console.error(`[scheduler] ${j.name} failed:`, (e as Error).message);
      }
    }
  };
  setInterval(() => void tick(), 30_000);
  void tick();
}

export function scheduleInfo() {
  return jobs.map((j) => ({ name: j.name, at: j.at, lastRunDate: kvGet<string>(`sched:${j.name}`)?.value ?? null, tz: TZ }));
}
