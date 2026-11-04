// [source.*] tables pull in outside data: a shell command, a file, or an env var.
// Commands never run inline. The render serves the last value and, when that has
// gone stale, starts a detached worker, so a slow command can't hold up the bar.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, sha, parseDuration } from './fsutil.js';
import { cacheDir as defaultCache } from './paths.js';
import { sanitize } from './width.js';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js');
const MAX_FILE_BYTES = 256 * 1024;

export function shapeValue(text, parse) {
  const raw = String(text ?? '');
  if (parse === 'json') {
    let data = null;
    try { data = JSON.parse(raw); } catch { /* left null */ }
    return { value: typeof data === 'object' ? null : data, data };
  }
  if (parse === 'lines') {
    const lines = raw.split('\n').map((l) => sanitize(l)).filter(Boolean);
    return { value: lines[0] ?? null, data: lines };
  }
  const first = sanitize(raw.split('\n').find((l) => l.trim()) ?? '').trim();
  return { value: first || null, data: null };
}

function result(shape, extra) {
  return { value: shape.value, data: shape.data, ok: true, stale: false, age: 0, error: null, ...extra };
}

const MISSING = (error = null) => ({ value: null, data: null, ok: false, stale: false, age: null, error });

export function keyFor(def, { cwd, sessionId }) {
  const scope = def.scope ?? 'cwd';
  const where = scope === 'global' ? '' : scope === 'session' ? String(sessionId ?? '') : cwd;
  return sha(`${def.command}\0${where}`).slice(0, 32);
}

export function readSource(name, def, ctx) {
  if (!def || typeof def !== 'object') return MISSING('bad definition');
  if (def.env !== undefined) {
    const v = ctx.env?.[String(def.env)];
    return v === undefined ? MISSING() : result(shapeValue(v, def.parse));
  }
  if (def.file !== undefined) {
    try {
      const p = String(def.file).replace(/^~(?=$|\/)/, process.env.HOME ?? '');
      const stat = fs.statSync(p);
      if (stat.size > MAX_FILE_BYTES) return MISSING('file too large');
      return result(shapeValue(fs.readFileSync(p, 'utf8'), def.parse), { age: ctx.now - stat.mtimeMs / 1000 });
    } catch {
      return MISSING();
    }
  }
  if (def.command === undefined) return MISSING('needs command, file or env');

  const dir = path.join(ctx.cacheDir ?? defaultCache(), 'source');
  const key = keyFor(def, ctx);
  const file = path.join(dir, `${key}.json`);
  const cached = readJson(file);
  const every = parseDuration(def.every, 30);
  const age = cached ? ctx.now - cached.at : null;
  const stale = !cached || age >= every;
  if (stale && !ctx.offline) refresh(def, key, dir, ctx);
  if (!cached) return MISSING();
  if (cached.code !== 0) return { ...MISSING(`exit ${cached.code}`), age, stale };
  return result(shapeValue(cached.out, def.parse), { age, stale });
}

function refresh(def, key, dir, ctx) {
  const lock = path.join(dir, `${key}.lock`);
  const timeout = parseDuration(def.timeout, 5);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const st = fs.statSync(lock);
      if (Date.now() - st.mtimeMs < (timeout + 5) * 1000) return;
      fs.unlinkSync(lock);
    } catch { /* no lock yet */ }
    fs.closeSync(fs.openSync(lock, 'wx', 0o600));
    const job = JSON.stringify({ command: String(def.command), cwd: ctx.cwd, timeout, file: path.join(dir, `${key}.json`), lock });
    const child = spawn(process.execPath, [WORKER, job], { detached: true, stdio: 'ignore', cwd: ctx.cwd, windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* the next tick will retry */ }
}
