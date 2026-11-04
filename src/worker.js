// Detached child that runs one [source] command and stores the result.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { writeAtomic } from './fsutil.js';

const MAX_OUTPUT = 64 * 1024;
const job = JSON.parse(process.argv[2]);
try {
  const r = spawnSync(job.command, {
    shell: true,
    cwd: job.cwd,
    encoding: 'utf8',
    timeout: job.timeout * 1000,
    maxBuffer: 4 * MAX_OUTPUT,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  const out = (r.stdout ?? '').slice(0, MAX_OUTPUT);
  writeAtomic(job.file, JSON.stringify({ at: Date.now() / 1000, code: r.error ? 1 : r.status ?? 1, out }));
} finally {
  try { fs.unlinkSync(job.lock); } catch { /* gone already */ }
}
