import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Writes are atomic so a cancelled render never leaves half a file behind.
// Everything limit-bar stores is private to the user.
export function writeAtomic(file, content, mode = 0o600) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, content, { mode });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export function parseDuration(v, fallback = 30) {
  if (typeof v === 'number') return v;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(String(v ?? '').trim());
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  return n * ({ ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[m[2] ?? 's']);
}
