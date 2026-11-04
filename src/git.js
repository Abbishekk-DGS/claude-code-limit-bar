import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { readJson, writeAtomic, sha } from './fsutil.js';
import { cacheDir as defaultCache } from './paths.js';

export function parsePorcelain(text) {
  const out = { repo: true, branch: null, detached: false, oid: null, upstream: null, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, changed: 0, dirty: false, clean: true };
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.oid ')) out.oid = line.slice(13, 20);
    else if (line.startsWith('# branch.head ')) {
      const head = line.slice(14);
      if (head === '(detached)') out.detached = true; else out.branch = head;
    } else if (line.startsWith('# branch.upstream ')) out.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4);
      if (xy[0] !== '.') out.staged++;
      if (xy[1] !== '.') out.modified++;
    } else if (line.startsWith('u ')) out.conflicts++;
    else if (line.startsWith('? ')) out.untracked++;
  }
  if (out.detached && out.oid) out.branch = out.oid;
  out.changed = out.staged + out.modified + out.untracked + out.conflicts;
  out.dirty = out.changed > 0;
  out.clean = !out.dirty;
  return out;
}

export function readGit(cwd, { ttl = 2, now = Date.now() / 1000, cacheDir } = {}) {
  const file = path.join(cacheDir ?? defaultCache(), 'git', `${sha(cwd).slice(0, 24)}.json`);
  const cached = readJson(file);
  if (cached && now - cached.at < ttl) return cached.value;
  // fsmonitor is forced off: a repo's own config could otherwise name a program
  // for git to run, and a status line must never execute code from a repo.
  const r = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, 'status', '--porcelain=v2', '--branch'], {
    encoding: 'utf8',
    timeout: 400,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.error) return cached ? cached.value : null;
  const value = r.status === 0 ? parsePorcelain(r.stdout) : null;
  writeAtomic(file, JSON.stringify({ at: now, value }));
  return value;
}
