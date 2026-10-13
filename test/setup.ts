import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// every test file gets an empty data directory: tests must never read or write a real database
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'splitscope-test-'));
