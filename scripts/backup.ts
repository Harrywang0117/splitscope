// Prints this machine's backup (device names, expectations, cases, analyses, settings) as JSON.
// Reads the database directly, so the local server does not need to be running.
// Usage: node --env-file=.env --import tsx scripts/backup.ts > backup.json
import { makeBackup } from '../server/backup.ts';

const b = makeBackup();
process.stdout.write(JSON.stringify(b));
const counts = Object.entries(b.tables).map(([t, rows]) => `${t} ${rows?.length ?? 0}`);
process.stderr.write(`backup: ${counts.join(', ')}\n`);
