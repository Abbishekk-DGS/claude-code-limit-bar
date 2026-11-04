// Builds the variable tree that templates and rules read. Expensive branches
// (git, history, activity, sources) are lazy, so a layout only pays for what it
// actually references.

import os from 'node:os';
import path from 'node:path';
import { readGit, readGitExtra } from './git.js';
import { openHistory } from './history.js';
import { readActivity, emptyStats } from './activity.js';
import { readSource } from './sources.js';
import { evaluate } from './expr.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const toNum = (v) => (isNum(v) ? v : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function lazy(obj, key, fn) {
  Object.defineProperty(obj, key, {
    enumerable: true,
    configurable: true,
    get() {
      const value = fn();
      Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
      return value;
    },
  });
}

function tilde(p, home) {
  if (!p) return p;
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

// Compresses /a/long/path/here to ~/a/l/p/here, fish-style.
function shortPath(p, home) {
  const t = tilde(p, home);
  if (!t) return t;
  const parts = t.split('/');
  if (parts.length <= 2) return t;
  return parts.map((seg, i) => (i === parts.length - 1 || i === 0 ? seg : seg.slice(0, 1))).join('/');
}

function clockText(d, format) {
  const m = String(d.getMinutes()).padStart(2, '0');
  if (format === '12h') return `${d.getHours() % 12 || 12}:${m}${d.getHours() < 12 ? 'am' : 'pm'}`;
  return `${String(d.getHours()).padStart(2, '0')}:${m}`;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function windowInfo(w, windowSeconds, now, clock) {
  if (!w || typeof w !== 'object') return null;
  const pct = toNum(w.used_percentage);
  const resets = toNum(w.resets_at);
  if (resets !== null && resets <= now) return null;
  const left = resets !== null ? resets - now : null;
  const out = { pct, resets_at: resets, left, reset_clock: null, reset_day: null, elapsed: null, projected: null, pace: null, will_hit: false, hit_in: null };
  if (resets !== null) {
    const d = new Date(resets * 1000);
    out.reset_clock = clockText(d, clock);
    out.reset_day = `${DAY_NAMES[d.getDay()]} ${out.reset_clock}`;
  }
  if (pct !== null && left !== null && windowSeconds) {
    const elapsed = clamp(windowSeconds - left, 0, windowSeconds);
    out.elapsed = elapsed;
    // Usage arrives in bursts, so early in a window a straight-line projection
    // overshoots badly. Below 15% elapsed there is too little signal to use.
    if (elapsed >= windowSeconds * 0.15) {
      out.projected = (pct * windowSeconds) / elapsed;
      out.pace = out.projected / 100;
      out.will_hit = out.projected >= 100;
      if (pct > 0 && pct < 100) {
        const hitIn = ((100 - pct) * elapsed) / pct;
        out.hit_in = hitIn < left ? hitIn : null;
      }
    }
  }
  return out;
}

const PERIOD_SECONDS = { daily: 86400, weekly: 604800, monthly: 2592000 };

export function buildScope(input, rc, opts = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const env = opts.env ?? process.env;
  const settings = rc?.cfg?.settings ?? {};
  const now = opts.now ?? (env.LIMITBAR_NOW ? Number(env.LIMITBAR_NOW) : Date.now() / 1000);
  const home = opts.home ?? os.homedir();
  const overrides = opts.overrides ?? {};
  const ws = raw.workspace ?? {};
  const cwd = ws.current_dir ?? raw.cwd ?? process.cwd();
  const projectDir = ws.project_dir ?? cwd;
  const scope = { raw };

  const modelName = raw.model?.display_name ?? raw.model?.id ?? null;
  scope.model = {
    id: raw.model?.id ?? null,
    name: modelName,
    short: modelName ? String(modelName).replace(/^Claude\s+/i, '').split(/\s+/)[0] : null,
  };
  scope.effort = { level: raw.effort?.level ?? null };
  scope.thinking = raw.thinking?.enabled === true;
  scope.fast = raw.fast_mode === true;
  scope.output_style = raw.output_style?.name ?? null;
  scope.version = raw.version ?? null;

  scope.dir = { path: cwd, name: path.basename(cwd), tilde: tilde(cwd, home), short: shortPath(cwd, home) };
  scope.project = {
    path: projectDir,
    name: path.basename(projectDir),
    is_subdir: cwd !== projectDir,
    relative: cwd !== projectDir ? path.relative(projectDir, cwd) : '',
    added_dirs: Array.isArray(ws.added_dirs) ? ws.added_dirs.length : 0,
  };
  const repo = ws.repo;
  scope.repo = repo
    ? { host: repo.host ?? null, owner: repo.owner ?? null, name: repo.name ?? null, slug: repo.owner && repo.name ? `${repo.owner}/${repo.name}` : null, url: repo.host && repo.owner && repo.name ? `https://${repo.host}/${repo.owner}/${repo.name}` : null }
    : { host: null, owner: null, name: null, slug: null, url: null };
  scope.session = { id: raw.session_id ?? null, name: raw.session_name ?? null, prompt_id: raw.prompt_id ?? null };
  scope.vim = { mode: raw.vim?.mode ?? null };
  scope.agent = { name: raw.agent?.name ?? null };
  scope.pr = { number: raw.pr?.number ?? null, url: raw.pr?.url ?? null, state: raw.pr?.review_state ?? null, kind: raw.pr?.kind ?? null };
  scope.worktree = {
    name: raw.worktree?.name ?? ws.git_worktree ?? null,
    path: raw.worktree?.path ?? null,
    branch: raw.worktree?.branch ?? null,
    original_branch: raw.worktree?.original_branch ?? null,
  };

  // Context window
  const cw = raw.context_window ?? {};
  const usage = cw.current_usage ?? null;
  const size = toNum(cw.context_window_size);
  let pct = toNum(cw.used_percentage);
  const inputTokens = usage ? (toNum(usage.input_tokens) ?? 0) + (toNum(usage.cache_creation_input_tokens) ?? 0) + (toNum(usage.cache_read_input_tokens) ?? 0) : null;
  if (pct === null && inputTokens !== null && size) pct = (inputTokens / size) * 100;
  scope.ctx = {
    pct,
    left: toNum(cw.remaining_percentage) ?? (pct !== null ? 100 - pct : null),
    size,
    tokens: inputTokens ?? toNum(cw.total_input_tokens),
    tokens_left: size !== null && inputTokens !== null ? Math.max(0, size - inputTokens) : null,
    output: usage ? toNum(usage.output_tokens) : toNum(cw.total_output_tokens),
    fresh: usage ? toNum(usage.input_tokens) : null,
    cache_read: usage ? toNum(usage.cache_read_input_tokens) : null,
    cache_write: usage ? toNum(usage.cache_creation_input_tokens) : null,
    over_200k: raw.exceeds_200k_tokens === true,
  };

  // Cost and session clocks, in seconds.
  const cost = raw.cost ?? {};
  scope.cost = {
    usd: toNum(cost.total_cost_usd),
    duration: isNum(cost.total_duration_ms) ? cost.total_duration_ms / 1000 : null,
    api: isNum(cost.total_api_duration_ms) ? cost.total_api_duration_ms / 1000 : null,
    added: toNum(cost.total_lines_added),
    removed: toNum(cost.total_lines_removed),
    lines: isNum(cost.total_lines_added) || isNum(cost.total_lines_removed) ? (cost.total_lines_added ?? 0) + (cost.total_lines_removed ?? 0) : null,
  };
  scope.cost.avg_per_hour = scope.cost.usd !== null && scope.cost.duration >= 60 ? (scope.cost.usd / scope.cost.duration) * 3600 : null;

  // Rate limits, plus a stateless projection from how much of the window is gone.
  const rl = raw.rate_limits ?? {};
  scope.limit = {
    h5: windowInfo(rl.five_hour, 5 * 3600, now, settings.clock),
    d7: windowInfo(rl.seven_day, 7 * 86400, now, settings.clock),
    spend: null,
  };
  if (rl.spend_limit && typeof rl.spend_limit === 'object') {
    const s = windowInfo(rl.spend_limit, PERIOD_SECONDS[rl.spend_limit.period] ?? null, now, settings.clock);
    if (s) {
      s.usd = toNum(rl.spend_limit.used_usd);
      s.max = toNum(rl.spend_limit.limit_usd);
      s.period = rl.spend_limit.period ?? null;
      scope.limit.spend = s;
    }
  }

  // Prompt cache
  const pc = raw.prompt_cache ?? {};
  const expires = toNum(pc.expires_at);
  scope.cache = {
    known: raw.prompt_cache !== undefined,
    warm: pc.warm === true,
    observed: pc.caching_observed === true,
    ttl: pc.ttl ?? null,
    expires_at: expires,
    left: expires !== null ? Math.max(0, expires - now) : null,
    hit: isNum(pc.hit_ratio) ? pc.hit_ratio * 100 : null,
    requests: toNum(pc.requests),
    misses: toNum(pc.misses),
    rebuilds: toNum(pc.expected_rebuilds),
    written: toNum(pc.cache_write_tokens),
    wasted: toNum(pc.miss_recache_tokens),
    cold_cost: toNum(pc.recache_tokens_if_cold),
    last_miss_at: toNum(pc.last_miss_at),
    last_cause: Array.isArray(pc.last_miss_cause?.causes) ? pc.last_miss_cause.causes.join(', ') : null,
  };

  scope.term = {
    cols: toNum(Number(env.COLUMNS)) || opts.cols || 120,
    lines: toNum(Number(env.LINES)) || 24,
    program: env.TERM_PROGRAM ?? null,
    ssh: Boolean(env.SSH_CONNECTION || env.SSH_TTY),
    tmux: Boolean(env.TMUX),
  };
  if (opts.cols) scope.term.cols = opts.cols;

  const d = new Date(now * 1000);
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  scope.time = {
    epoch: Math.floor(now),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
    weekday: DAYS[d.getDay()],
    weekend: d.getDay() === 0 || d.getDay() === 6,
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    clock: clockText(d, settings.clock),
  };

  Object.defineProperty(scope, 'env', { value: { ...env }, enumerable: false });

  // Who and where. Only looked up when a layout asks for it.
  lazy(scope, 'user', () => {
    const shown = typeof settings.username === 'string' && settings.username ? settings.username : null;
    if (overrides.user) return shown ? { ...overrides.user, name: shown } : overrides.user;
    let name = env.USER ?? env.LOGNAME ?? env.USERNAME ?? null;
    try { name = os.userInfo().username; } catch { /* keep the env value */ }
    let host = null;
    try { host = os.hostname(); } catch { /* stays null */ }
    return { name: shown ?? name, host: host ? host.replace(/\.(local|lan|home)$/i, '') : null, home };
  });
  lazy(scope, 'system', () => {
    if (overrides.system) return overrides.system;
    const NAMES = { darwin: 'macOS', linux: 'Linux', win32: 'Windows', freebsd: 'FreeBSD' };
    return {
      os: NAMES[process.platform] ?? process.platform,
      arch: process.arch,
      shell: env.SHELL ? path.basename(env.SHELL) : null,
      cores: os.cpus().length,
      load: Number(os.loadavg()[0].toFixed(2)),
      node: process.versions.node,
    };
  });

  lazy(scope, 'git', () => {
    if (overrides.git !== undefined) return withCommitAge({ ...emptyGit(), ...overrides.git }, now);
    const g = readGit(cwd, { ttl: settings.git_ttl ?? 2, now, cacheDir: rc?.cacheDir }) ?? emptyGit();
    if (!g.repo) return g;
    let extra;
    const more = () => { extra ??= readGitExtra(cwd, { now, cacheDir: rc?.cacheDir }); return extra; };
    for (const key of ['op', 'stash', 'added', 'removed', 'tag', 'last_commit_at']) lazy(g, key, () => more()[key]);
    lazy(g, 'age', () => (more().last_commit_at ? Math.max(0, now - more().last_commit_at) : null));
    return g;
  });

  const historyHandle = () => {
    if (overrides.history) return overrides.history;
    return openHistory(scope, { now, cacheDir: rc?.cacheDir, limit: rc?.cfg?.settings?.ctx_limit ?? 100 });
  };
  let histMemo;
  const hist = () => { histMemo ??= historyHandle(); return histMemo; };
  lazy(scope, 'history', () => hist().series);
  lazy(scope, 'rate', () => hist().rate);
  lazy(scope.ctx, 'eta', () => hist().eta?.ctx ?? null);
  lazy(scope.cost, 'per_hour', () => hist().rate?.cost_per_hour ?? scope.cost.avg_per_hour);

  const activity = () => overrides.activity ?? readActivity(raw.transcript_path, { now, cacheDir: rc?.cacheDir });
  let activityMemo;
  const act = () => { activityMemo ??= activity(); return activityMemo; };
  lazy(scope, 'tool', () => act().tool);
  lazy(scope, 'todo', () => act().todo);
  lazy(scope, 'agents', () => act().agents ?? { running: 0, background: 0, spawned: 0 });
  lazy(scope, 'stats', () => act().stats ?? emptyStats());
  // context_window.total_output_tokens only covers the latest message, so the session
  // total comes from the transcript.
  scope.speed = {};
  lazy(scope.speed, 'output', () => {
    const out = act().stats?.output_tokens;
    return out && scope.cost.api >= 1 ? out / scope.cost.api : null;
  });

  // [source.*] and [var.*] come from config, and a rule can swap the config, so
  // they are rebuilt whenever that happens.
  const bindConfigValues = () => {
    const sources = {};
    const defs = rc?.cfg?.source ?? {};
    for (const name of Object.keys(defs)) {
      lazy(sources, name, () => {
        if (overrides.source && Object.hasOwn(overrides.source, name)) return overrides.source[name];
        return readSource(name, defs[name], { cwd, now, env, cacheDir: rc?.cacheDir, offline: rc?.offline, sessionId: raw.session_id });
      });
    }
    scope.source = sources;

    const vars = {};
    const varDefs = rc?.cfg?.var ?? {};
    const resolving = new Set();
    for (const name of Object.keys(varDefs)) {
      lazy(vars, name, () => {
        if (resolving.has(name)) return null;
        resolving.add(name);
        try { return evaluate(String(varDefs[name]), scope, rc?.env); } catch (e) { rc?.note?.(e.message); return null; } finally { resolving.delete(name); }
      });
    }
    scope.var = vars;
  };
  bindConfigValues();
  if (rc) rc.rebindConfigValues = bindConfigValues;

  return scope;
}

function emptyGit() {
  return { repo: false, branch: null, detached: false, oid: null, upstream: null, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, changed: 0, dirty: false, clean: false, op: null, stash: 0, added: 0, removed: 0, tag: null, last_commit_at: null, age: null };
}

function withCommitAge(g, now) {
  return { ...g, age: g.last_commit_at ? Math.max(0, now - g.last_commit_at) : null };
}

export function glyphScope(cfg, charset) {
  const out = {};
  for (const [k, v] of Object.entries(cfg.glyphs ?? {})) {
    if (v && typeof v === 'object') out[k] = String(v[charset] ?? v.unicode ?? Object.values(v)[0] ?? '');
    else out[k] = String(v ?? '');
  }
  return out;
}
