// Sample sessions for previews and tests. Times are relative to `now`, and git,
// history and sources are supplied directly, so nothing touches the machine.

const HOUR = 3600;
const DAY = 86400;

function base(now, over = {}) {
  return {
    cwd: '/Users/dev/code/orbit-api',
    session_id: 'preview-session',
    session_name: 'payments refactor',
    transcript_path: '',
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    workspace: {
      current_dir: '/Users/dev/code/orbit-api',
      project_dir: '/Users/dev/code/orbit-api',
      added_dirs: [],
      repo: { host: 'github.com', owner: 'acme', name: 'orbit-api' },
    },
    version: '2.1.300',
    output_style: { name: 'default' },
    effort: { level: 'high' },
    thinking: { enabled: true },
    fast_mode: false,
    ...over,
  };
}

const usage = (pct, size = 200000) => {
  const tokens = Math.round((pct / 100) * size);
  return {
    total_input_tokens: tokens,
    total_output_tokens: 1800,
    context_window_size: size,
    used_percentage: pct,
    remaining_percentage: 100 - pct,
    current_usage: { input_tokens: Math.round(tokens * 0.05), output_tokens: 1800, cache_creation_input_tokens: Math.round(tokens * 0.1), cache_read_input_tokens: Math.round(tokens * 0.85) },
  };
};

const ramp = (from, to, n = 24) => Array.from({ length: n }, (_, i) => Number((from + ((to - from) * i) / (n - 1) + Math.sin(i * 1.3) * 0.8).toFixed(2)));

export const FIXTURES = {
  fresh: (now) => ({
    input: base(now, { session_name: undefined, cost: { total_cost_usd: 0, total_duration_ms: 4000, total_api_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0 }, context_window: { total_input_tokens: 0, total_output_tokens: 0, context_window_size: 200000, used_percentage: null, remaining_percentage: null, current_usage: null } }),
    overrides: {
      git: { repo: true, branch: 'main', detached: false, oid: 'a1b2c3d', upstream: 'origin/main', ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, changed: 0, dirty: false, clean: true },
      history: { series: { ctx: [], cost: [], h5: [], d7: [], tokens: [] }, rate: { ctx_per_min: null, cost_per_hour: null, h5_per_hour: null, tokens_per_min: null }, eta: { ctx: null } },
      activity: { tool: { active: null, target: null, running: 0, agents: 0, elapsed: null }, todo: { done: 0, total: 0, current: null, pct: null }, agents: { running: 0, background: 0, spawned: 0 }, stats: { turns: 0, messages: 0, tools: 0, top_tool: null, top_tool_count: 0, compactions: 0, last_turn: null, skills: 0, last_skill: null, mcp: 0, agents_spawned: 0, output_tokens: 0 } },
    },
  }),
  working: (now) => ({
    input: base(now, {
      cost: { total_cost_usd: 1.84, total_duration_ms: 2820000, total_api_duration_ms: 610000, total_lines_added: 156, total_lines_removed: 23 },
      context_window: usage(42),
      prompt_cache: { warm: true, caching_observed: true, ttl: '1h', expires_at: now + 2830, requests: 38, misses: 1, expected_rebuilds: 0, hit_ratio: 0.93, cache_write_tokens: 92000, miss_recache_tokens: 4100, last_miss_at: null, last_miss_cause: null, miss_causes: {}, recache_tokens_if_cold: 84000 },
      rate_limits: { five_hour: { used_percentage: 23.5, resets_at: now + 3.2 * HOUR }, seven_day: { used_percentage: 41.2, resets_at: now + 4 * DAY } },
      pr: { number: 1234, url: 'https://github.com/acme/orbit-api/pull/1234', review_state: 'pending' },
    }),
    overrides: {
      git: { repo: true, branch: 'feat/payments', detached: false, oid: 'a1b2c3d', upstream: 'origin/feat/payments', ahead: 2, behind: 0, staged: 1, modified: 3, untracked: 1, conflicts: 0, changed: 5, dirty: true, clean: false, op: null, stash: 1, added: 82, removed: 14, tag: null, last_commit_at: now - 2400 },
      history: { series: { ctx: ramp(12, 42), cost: ramp(0.2, 1.84), h5: ramp(14, 23.5), d7: ramp(39, 41.2), tokens: [] }, rate: { ctx_per_min: 0.8, cost_per_hour: 2.35, h5_per_hour: 5.2, tokens_per_min: 1600 }, eta: { ctx: 58 * 60 } },
      activity: { tool: { active: 'Edit', target: 'charge.ts', running: 2, agents: 1, elapsed: 4 }, todo: { done: 3, total: 7, current: 'Wire retry policy', pct: 42.8 }, agents: { running: 1, background: 2, spawned: 5 }, stats: { turns: 14, messages: 96, tools: 212, top_tool: 'Edit', top_tool_count: 61, compactions: 1, last_turn: 39, skills: 2, last_skill: 'frontend-design', mcp: 1, agents_spawned: 5, output_tokens: 46200 } },
    },
  }),
  danger: (now) => ({
    input: base(now, {
      cost: { total_cost_usd: 18.42, total_duration_ms: 9180000, total_api_duration_ms: 3100000, total_lines_added: 1482, total_lines_removed: 611 },
      context_window: usage(91),
      prompt_cache: { warm: true, caching_observed: true, ttl: '5m', expires_at: now + 48, requests: 212, misses: 9, expected_rebuilds: 2, hit_ratio: 0.71, cache_write_tokens: 910000, miss_recache_tokens: 310200, last_miss_at: now - 240, last_miss_cause: { causes: ['tools_changed'], tools_added: 2, tools_removed: 0 }, miss_causes: { tools_changed: 5 }, recache_tokens_if_cold: 182000 },
      rate_limits: { five_hour: { used_percentage: 88, resets_at: now + 1.4 * HOUR }, seven_day: { used_percentage: 76, resets_at: now + 2 * DAY } },
    }),
    overrides: {
      git: { repo: true, branch: 'hotfix/ledger-race', detached: false, oid: 'f00dcaf', upstream: 'origin/hotfix/ledger-race', ahead: 0, behind: 3, staged: 0, modified: 11, untracked: 4, conflicts: 1, changed: 16, dirty: true, clean: false, op: 'rebase', stash: 3, added: 640, removed: 215, tag: 'v2.4.0', last_commit_at: now - 86400 },
      history: { series: { ctx: ramp(34, 91), cost: ramp(9, 18.42), h5: ramp(60, 88), d7: ramp(70, 76), tokens: [] }, rate: { ctx_per_min: 2.9, cost_per_hour: 12.6, h5_per_hour: 21, tokens_per_min: 5800 }, eta: { ctx: 3 * 60 + 6 } },
      activity: { tool: { active: 'Bash', target: 'npm test', running: 2, agents: 1, elapsed: 74 }, todo: { done: 6, total: 7, current: 'Fix ledger race', pct: 85.7 }, agents: { running: 1, background: 0, spawned: 9 }, stats: { turns: 61, messages: 412, tools: 934, top_tool: 'Bash', top_tool_count: 288, compactions: 3, last_turn: 212, skills: 4, last_skill: 'code-review', mcp: 3, agents_spawned: 9, output_tokens: 100100 } },
    },
  }),
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

// Samples use made-up identity values, so previews and screenshots can never show
// the real username or machine name of whoever generated them.
const SAMPLE_USER = { name: 'dev', host: 'workstation', home: '/Users/dev' };
const SAMPLE_SYSTEM = { os: 'macOS', arch: 'arm64', shell: 'zsh', cores: 8, load: 1.42, node: '24.0.0' };

export const fixture = (name, now = Date.now() / 1000) => {
  if (!Object.hasOwn(FIXTURES, name)) return null;
  const f = FIXTURES[name](now);
  f.overrides.user = SAMPLE_USER;
  f.overrides.system = SAMPLE_SYSTEM;
  return f;
};
