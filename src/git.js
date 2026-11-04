import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeAtomic, sha } from './fsutil.js';
import { cacheDir as defaultCache } from './paths.js';

export function parsePorcelain(text) {
  const out = { repo: true, branch: null, detached: false, oid: null, upstream: null, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, changed: 0, dirty: false, clean: true };
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.oid ')) out.oid = /^[0-9a-f]/.test(line.slice(13)) ? line.slice(13, 20) : null;
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

// The slower facts, kept apart so a layout that skips them never pays for them, and
// reused for longer. External diff drivers, textconv and signature checks stay off,
// because a repo's config could otherwise name a program for git to run.
const OPS = [['MERGE_HEAD', 'merge'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['BISECT_LOG', 'bisect']];

function git(cwd, args) {
  const r = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { encoding: 'utf8', timeout: 400, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 && !r.error ? r.stdout.trim() : null;
}

export function parseShortstat(text) {
  return { added: Number(/(\d+) insertion/.exec(text ?? '')?.[1] ?? 0), removed: Number(/(\d+) deletion/.exec(text ?? '')?.[1] ?? 0) };
}

export function readGitExtra(cwd, { ttl = 10, now = Date.now() / 1000, cacheDir } = {}) {
  const file = path.join(cacheDir ?? defaultCache(), 'git', `${sha(`extra\0${cwd}`).slice(0, 24)}.json`);
  const cached = readJson(file);
  if (cached && now - cached.at < ttl) return cached.value;
  const value = { op: null, stash: 0, added: 0, removed: 0, last_commit_at: null, tag: null };
  const dirs = git(cwd, ['rev-parse', '--absolute-git-dir', '--git-common-dir']);
  if (dirs) {
    const [gitDir, common] = dirs.split('\n');
    value.op = OPS.find(([f]) => fs.existsSync(path.join(gitDir, f)))?.[1] ?? null;
    try {
      const log = fs.readFileSync(path.resolve(cwd, common ?? gitDir, 'logs', 'refs', 'stash'), 'utf8');
      value.stash = log.split('\n').filter(Boolean).length;
    } catch { /* no stashes */ }
    Object.assign(value, parseShortstat(git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--shortstat', 'HEAD'])));
    const at = Number(git(cwd, ['-c', 'log.showSignature=false', 'log', '-1', '--format=%ct']));
    value.last_commit_at = at > 0 ? at : null;
    value.tag = git(cwd, ['describe', '--tags', '--exact-match']) || null;
  }
  writeAtomic(file, JSON.stringify({ at: now, value }));
  return value;
}
