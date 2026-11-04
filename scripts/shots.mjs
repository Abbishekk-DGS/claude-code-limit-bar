// Regenerates every README graphic from the real renderer, so an image can never
// show something the bar does not do: node scripts/shots.mjs [out-dir]
// Prints the module table for the README as well, between its markers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderBar, renderSubagents } from '../src/render.js';
import { fixture } from '../src/fixtures.js';
import { catalog, currentConfig, drawEditor } from '../src/customize.js';
import { textWidth } from '../src/width.js';
import { ansiToHtml } from './ansi-to-html.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'assets'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const NOW = 1800000000;
const WIDTH = 1040;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bar-shot-'));
const env = { PATH: process.env.PATH, HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, 'c'), XDG_CACHE_HOME: path.join(tmp, 'k'), COLORTERM: 'truecolor', LIMITBAR_COLOR: 'truecolor', LIMITBAR_CHARSET: 'unicode' };

const THEMES = {
  light: { name: 'light', page: '#ffffff', ink: '#17171f', soft: '#5f5f75', line: '#dedee8', tint: '#f6f6fa', term: { bg: '#ffffff', fg: '#17171f' }, on: '#e6129f' },
  dark: { name: 'dark', page: '#0d1117', ink: '#e8e8f0', soft: '#9a9ab0', line: '#2b2f3a', tint: '#151a23', term: { bg: '#0d1117', fg: '#e8e8f0' }, on: '#ff4dbd' },
};

function render(state, { cols = 124, overlay, patch } = {}) {
  const f = fixture(state, NOW);
  if (patch) patch(f);
  const r = renderBar(f.input, { env, cols, now: NOW, overrides: f.overrides, offline: true, projectDir: null, overlay });
  if (r.problems.length) throw new Error(`${state}: ${r.problems.join('; ')}`);
  return r.text;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const term = (text, t) => `<pre class="term">${ansiToHtml(text, t.term)}</pre>`;

const css = (t) => `
*{box-sizing:border-box;margin:0}
html,body{background:transparent}
body{width:${WIDTH}px;font:14px/1.5 -apple-system,"SF Pro Text","Helvetica Neue",Arial,sans-serif;color:${t.ink};--c199:#e6129f;--c38:#0097b2;--c34:#17a300}
.card{background:${t.page};border:1px solid ${t.line};border-radius:8px;overflow:hidden}
.head{padding:22px 28px 18px;border-bottom:1px solid ${t.line}}
h2{font:500 24px/1.2 ui-serif,"New York",Georgia,serif;letter-spacing:-.005em}
.sub{color:${t.soft};margin-top:5px;font-size:14px}
.body{padding:22px 28px 26px}
pre{font:13px/1.32 Menlo,Consolas,monospace;white-space:pre;letter-spacing:0}
pre.term{color:${t.term.fg}}
.w{display:inline-block;height:1.32em;vertical-align:top;text-align:center;overflow:visible}
.c{display:inline-block;height:1.32em;vertical-align:top}
.g{display:inline-block;width:1ch;height:1.32em;vertical-align:top}
.g i{display:block;width:100%;height:100%}
.row{padding:16px 0;border-top:1px solid ${t.line}}
.row:first-child{padding-top:0;border-top:0}
.row:last-child{padding-bottom:0}
.rowname{font:500 16px/1.3 ui-serif,"New York",Georgia,serif;margin-bottom:8px}
.keys{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 22px;margin-top:11px}
.key{font-size:12.5px;line-height:1.4;color:${t.soft}}
.key code{display:block;font:12.5px/1.4 Menlo,Consolas,monospace;color:${t.ink}}
.lbl{font-size:13px;color:${t.soft};margin:18px 0 7px}
.lbl:first-child{margin-top:0}
.big pre{font-size:34px;line-height:1.3}
.big .w,.big .c,.big .g{height:1.3em}
.ticks{position:relative;font:34px/1 Menlo,Consolas,monospace;height:34px;margin-top:8px}
.tick{position:absolute;top:0;height:9px;border:1px solid ${t.on};border-top:0;text-align:center}
.tick .num{position:absolute;left:50%;top:13px;transform:translateX(-50%)}
.num{display:inline-block;width:18px;height:18px;border-radius:50%;background:${t.on};color:#fff;font:600 11px/18px -apple-system,"Helvetica Neue",sans-serif;text-align:center}
.notes{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;margin-top:18px;padding-top:16px;border-top:1px solid ${t.line}}
.note{position:relative;padding-left:26px;font-size:13px;line-height:1.45;color:${t.soft}}
.note .num{position:absolute;left:0;top:1px}
.note b{display:block;font-weight:600;color:${t.ink}}
.groups{display:grid;grid-template-columns:repeat(2,1fr);gap:20px 34px}
.gname{font:500 16px/1.3 ui-serif,"New York",Georgia,serif}
.gdesc{font-size:12.5px;color:${t.soft};margin:2px 0 8px}
.chips{display:flex;flex-wrap:wrap;gap:5px 6px}
.chip{font:11.5px/1 Menlo,Consolas,monospace;padding:5px 7px 5px;border:1px solid ${t.line};border-radius:4px;color:${t.soft}}
.chip.on{border-color:${t.on};color:${t.ink}}
.chip.on:before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:${t.on};margin-right:5px;vertical-align:1px}
.legend{font-size:12.5px;color:${t.soft};margin-top:18px;padding-top:12px;border-top:1px solid ${t.line}}
.flow{display:grid;grid-template-columns:1fr 26px 1fr 26px 1fr;align-items:stretch}
.arrow{display:flex;align-items:center;justify-content:center;color:${t.soft};font-size:16px}
.col{border:1px solid ${t.line};border-radius:6px;padding:14px 15px;background:${t.tint}}
.col h3{font:500 15px/1.3 ui-serif,"New York",Georgia,serif;margin-bottom:9px}
.item{font-size:12.5px;line-height:1.4;padding:6px 0;border-top:1px solid ${t.line};color:${t.soft}}
.item b{font-weight:600;color:${t.ink};display:block}
.keysrow{display:grid;grid-template-columns:repeat(4,1fr);gap:8px 20px;margin-top:16px;padding-top:14px;border-top:1px solid ${t.line}}
.k{font-size:12.5px;color:${t.soft}}
.k kbd{font:12px/1 Menlo,Consolas,monospace;color:${t.ink};border:1px solid ${t.line};border-radius:3px;padding:2px 5px;margin-right:6px;background:${t.tint}}
`;

const page = (t, body) => `<!doctype html><meta charset="utf-8"><style>${css(t)}</style>${body}<script>document.title='H'+Math.ceil(document.body.scrollHeight)</script>`;
const card = (title, sub, body) => `<div class="card"><div class="head"><h2>${title}</h2><div class="sub">${sub}</div></div><div class="body">${body}</div></div>`;

function chrome(args) {
  return spawnSync('nice', ['-n', '15', CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
}

const heights = new Map();
function shoot(name, build) {
  for (const t of Object.values(THEMES)) {
    const html = path.join(tmp, `${name}-${t.name}.html`);
    fs.writeFileSync(html, page(t, build(t)));
    if (!heights.has(name)) {
      const dom = chrome(['--dump-dom', `file://${html}`]).stdout;
      const h = Number(/<title>H(\d+)<\/title>/.exec(dom)?.[1]);
      if (!h) throw new Error(`could not measure ${name}`);
      heights.set(name, h);
    }
    const file = path.join(OUT, `${name}-${t.name}.png`);
    chrome(['--force-device-scale-factor=2', '--default-background-color=00000000', `--window-size=${WIDTH},${heights.get(name)}`, `--screenshot=${file}`, `file://${html}`]);
    if (!fs.existsSync(file)) throw new Error(`screenshot failed: ${file}`);
  }
}

fs.mkdirSync(OUT, { recursive: true });

// ---- how to read the bar ----------------------------------------------------
const ROWS = [
  ['Limits', 'How much of each limit is gone, and where you are heading.', [
    ['5h[ 24% ]', 'Share of the 5-hour limit used'],
    ['⚡3h12m', 'Time until that limit resets'],
    ['→65%', 'Where this pace lands you at reset'],
    ['7d[ 41% ]', 'The same for the 7-day limit'],
    ['ctx[ 42% ]', 'How full the context window is'],
    ['▲ 5h limit in 29m', 'Appears when you will run out first'],
  ]],
  ['You and your code', 'Who is working, on what, and how far it has moved.', [
    ['▸ dev', 'Your username, never the project name'],
    ['⎇ feat/payments*', 'Branch. * means uncommitted changes'],
    ['↑2', 'Commits ahead of the remote'],
    ['+1 ~3 ?1', 'Staged, modified and untracked files'],
    ['⇄ #1234 pending', 'Open pull request and its review'],
    ['+156 -23', 'Lines changed this session'],
  ]],
  ['The session', 'How Claude Code is set up right now.', [
    ['Opus 5.5(84k/200k)', 'Model, and tokens in the context window'],
    ['✦ effort:high', 'Reasoning effort'],
    ['think:on', 'Extended thinking'],
    ['fast:off', 'Fast mode'],
    ['style:default', 'Output style'],
    ['cache 47:10', 'Time until the prompt cache expires'],
  ]],
  ['Right now', 'What is happening this second. Empty when nothing is.', [
    ['◐ Edit charge.ts 4s', 'Tool running, its target and elapsed time'],
    ['◆ 3 agents (2 bg)', 'Subagents running, and how many in background'],
    ['☰ 3/7 Wire retry policy', 'Todos done, and the current one'],
    ['✧ 2 frontend-design', 'Skills used, and the latest'],
  ]],
  ['Totals', 'The session so far.', [
    ['up 47m', 'Time the session has been open'],
    ['↻14', 'Turns completed'],
    ['◐212', 'Tool calls'],
    ['⇣1', 'Times the session was compacted'],
    ['76 tok/s', 'Output speed'],
    ['1.6k tok/m', 'How fast context is growing'],
  ]],
];

shoot('anatomy', (t) => {
  const lines = render('working').split('\n');
  return card('How to read the bar', 'Five rows, from what could stop you down to the session totals. A row with nothing to show disappears.', ROWS.map(([name, desc, keys], i) => `
    <div class="row">
      <div class="rowname">${i + 1}. ${name} <span style="font:13px -apple-system,sans-serif;color:${t.soft}">&nbsp;${desc}</span></div>
      ${term(lines[i], t)}
      <div class="keys">${keys.map(([k, v]) => `<div class="key"><code>${esc(k)}</code>${esc(v)}</div>`).join('')}</div>
    </div>`).join(''));
});

// ---- one gauge, up close ----------------------------------------------------
shoot('gauge', (t) => {
  const text = render('working', { overlay: { layout: { rows: [['h5']] } } });
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const col = (i) => textWidth(plain.slice(0, i));
  const parts = [
    [0, 2, 'Which limit', '5h is the 5-hour window. 7d is the weekly one.'],
    [plain.indexOf('['), plain.indexOf(']') + 1, 'Used so far', 'Fills from blue to pink, with the number inside.'],
    [plain.indexOf('3h12m'), plain.indexOf('3h12m') + 5, 'Time to reset', 'How long until this window starts over.'],
    [plain.indexOf('→'), plain.length, 'Your pace', 'Where you land at reset if you keep going like this.'],
  ];
  const ticks = parts.map(([from, to], i) => `<div class="tick" style="left:${col(from)}ch;width:${col(to) - col(from)}ch"><span class="num">${i + 1}</span></div>`).join('');
  const notes = parts.map(([, , title, note], i) => `<div class="note"><span class="num">${i + 1}</span><b>${title}</b>${note}</div>`).join('');
  return card('One gauge, up close', 'Every limit reads the same way. The pace figure turns amber, then pink, as you head for the limit.', `<div class="big">${term(text, t)}<div class="ticks">${ticks}</div></div><div class="notes">${notes}</div>`);
});

// ---- everything on offer -----------------------------------------------------
const GROUPS = {
  session: 'Model, effort, thinking, fast mode, version.',
  place: 'Who and where. Folder and repo are off by default.',
  git: 'Branch, changes, sync, stashes, pull requests.',
  context: 'How full the window is and how fast it fills.',
  limits: 'Gauges, forecasts, reset times, usage trends.',
  pace: 'Session clocks, speed, turns and token burn.',
  cache: 'Prompt cache countdown, hit rate and misses.',
  activity: 'Tools, subagents, todos, skills and MCP servers.',
};
const cfg = currentConfig(env);
const items = catalog(cfg);
const rowsOn = new Set(cfg.layout.rows.flat());
shoot('modules', (t) => card(`${items.length} things it can show`, `${items.filter((i) => rowsOn.has(i.name)).length} are on when you install it. The rest are one command away, in any row and any order.`, `
  <div class="groups">${Object.entries(GROUPS).map(([g, d]) => `<div><div class="gname">${g[0].toUpperCase()}${g.slice(1)}</div><div class="gdesc">${d}</div><div class="chips">${items.filter((i) => i.group === g).map((i) => `<span class="chip${rowsOn.has(i.name) ? ' on' : ''}">${i.name}</span>`).join('')}</div></div>`).join('')}</div>
  <div class="legend">A dot means on by default. Dollar amounts are deliberately left out.</div>`));

// ---- the live editor ---------------------------------------------------------
const editorState = () => ({
  items: items.slice(10, 24),
  rows: cfg.layout.rows.map((r) => [...r]),
  settings: { username: 'dev', bar: 'meter', gauge_width: 10, gauge_show: 'used', clock: '24h' },
  cursor: 3,
  state: 'working',
  dirty: true,
});
shoot('editor', (t) => {
  const text = drawEditor(editorState(), { cols: 124, lines: 28, env, now: NOW }).replace(/\r/g, '');
  const keep = text.split('\n').filter((l) => !/↑↓ pick|g gauge:|s save/.test(l)).join('\n');
  const keys = [['space', 'Turn on or off'], ['← →', 'Move to another row'], ['[ ]', 'Reorder in the row'], ['>', 'Split left and right'], ['g', 'Gauge design'], ['w', 'Gauge width'], ['u', 'Show used or left'], ['tab', 'Try another moment'], ['c', '12 or 24 hour clock'], ['r', 'Back to the defaults'], ['s', 'Save'], ['q', 'Quit']];
  return card('Rearrange it live', 'limit-bar customize. The bar at the top redraws with every key you press.', `${term(keep.trimEnd(), t)}<div class="keysrow">${keys.map(([k, v]) => `<div class="k"><kbd>${esc(k)}</kbd>${v}</div>`).join('')}</div>`);
});

// ---- widths --------------------------------------------------------------------
shoot('responsive', (t) => card('Fits any terminal', 'When space runs out, long forms shorten first, then the least important items leave.', [124, 100, 80, 60].map((cols) => `<div class="lbl">${cols} columns</div>${term(render('working', { cols }), t)}`).join('')));

// ---- agent panel ----------------------------------------------------------------
shoot('agents', (t) => {
  const start = (s) => (NOW - s) * 1000;
  const tasks = [
    { id: 'a', type: 'local_agent', agentType: 'Explore', status: 'running', description: 'x', label: 'Reading the payment handlers', startTime: start(72), model: 'claude-haiku-5-5', contextWindowSize: 200000, tokenCount: 47000, tokenSamples: [8000, 15000, 22000, 31000, 47000] },
    { id: 'b', type: 'local_agent', agentType: 'code-reviewer', status: 'running', description: 'x', label: 'Checking the retry policy', startTime: start(255), model: 'claude-opus-5-5', contextWindowSize: 1000000, tokenCount: 312000, tokenSamples: [90000, 140000, 210000, 280000, 312000] },
    { id: 'c', type: 'local_agent', agentType: 'Plan', status: 'completed', description: 'x', label: 'Outlined the migration', startTime: start(610), model: 'claude-sonnet-5-5', contextWindowSize: 200000, tokenCount: 64000, tokenSamples: [20000, 40000, 64000] },
    { id: 'd', type: 'local_agent', agentType: 'test-runner', status: 'failed', description: 'x', label: 'Ran the ledger tests', startTime: start(95), model: 'claude-haiku-5-5', contextWindowSize: 200000, tokenCount: 171000, tokenSamples: [80000, 171000] },
  ];
  const rows = renderSubagents({ columns: 118, tasks }, { env, now: NOW }).map((r) => r.content).join('\n');
  return card('Your agents, in the same colours', 'Each subagent row in Claude Code\'s agent panel shows its model, elapsed time, token trend and how full its context is.', term(rows, t));
});

// ---- how it works ---------------------------------------------------------------
shoot('flow', (t) => {
  const item = (b, d) => `<div class="item"><b>${b}</b>${d}</div>`;
  return card('How it works', 'Claude Code runs the bar on every update. It reads, renders and exits in about 50 ms, with no network and no background service.', `
    <div class="flow">
      <div class="col"><h3>It reads</h3>
        ${item('Session update', 'Model, limits, context, cache and pull request, from Claude Code')}
        ${item('Session transcript', 'Only the new lines: tools, agents, turns, skills')}
        ${item('Git', 'Status, and read only, in your current folder')}
        ${item('Your commands', 'Optional, and always in the background')}
      </div>
      <div class="arrow">→</div>
      <div class="col"><h3>It decides</h3>
        ${item('Your config', 'Defaults, then neon, then your file, then your edits')}
        ${item('Your rules', 'Change anything when a condition is true')}
        ${item('Forecasts', 'Where your pace lands, and when context fills')}
        ${item('The fit', 'Shorten, then drop, by your priorities')}
      </div>
      <div class="arrow">→</div>
      <div class="col"><h3>You see</h3>
        ${item('Up to five rows', 'Empty ones disappear')}
        ${item('Your terminal behind it', 'A transparent background, on white or black')}
        ${item('Your username', 'Not the folder or the repo')}
        ${item('Problems in plain sight', 'A bad config shows a message and never removes the bar')}
      </div>
    </div>`);
});

// ---- one session, animated -------------------------------------------------------
const framesDir = path.join(tmp, 'frames');
fs.mkdirSync(framesDir);
const STEPS = [
  [18, 8, 11, 'Read', 'charge.ts', 1, 7, 'Map the payment flow', 0],
  [24, 12, 12, 'Grep', 'retryPolicy', 2, 7, 'Map the payment flow', 1],
  [31, 19, 13, 'Edit', 'charge.ts', 2, 7, 'Wire retry policy', 1],
  [38, 26, 14, 'Agent', 'Review the retry logic', 3, 7, 'Wire retry policy', 2],
  [46, 34, 15, 'Bash', 'npm', 3, 7, 'Run the suite', 2],
  [55, 43, 16, 'Edit', 'ledger.ts', 4, 7, 'Fix the ledger race', 2],
  [63, 52, 17, 'Bash', 'npm', 4, 7, 'Fix the ledger race', 3],
  [71, 61, 18, 'Agent', 'Audit the migration', 5, 7, 'Fix the ledger race', 3],
  [78, 69, 19, 'Edit', 'migrate.ts', 5, 7, 'Write the migration', 3],
  [84, 76, 20, 'Bash', 'npm', 6, 7, 'Write the migration', 4],
  [89, 83, 21, 'Write', 'CHANGELOG.md', 6, 7, 'Write the migration', 4],
  [93, 89, 22, 'Bash', 'git', 6, 7, 'Ship it', 4],
];
let frame = 0;
STEPS.forEach((step, i) => {
  const [ctx, h5, d7, tool, target, done, total, current, agents] = step;
  const text = render('working', {
    patch: (f) => {
      f.input.context_window = { ...f.input.context_window, used_percentage: ctx, remaining_percentage: 100 - ctx, current_usage: { input_tokens: 500, output_tokens: 1800, cache_creation_input_tokens: 500, cache_read_input_tokens: ctx * 2000 - 1000 } };
      f.input.rate_limits.five_hour = { used_percentage: h5, resets_at: NOW + (3.6 - i * 0.05) * 3600 };
      f.input.rate_limits.seven_day = { used_percentage: d7 + 25, resets_at: NOW + 4 * 86400 };
      f.input.cost.total_lines_added = 20 + i * 60;
      f.input.cost.total_lines_removed = 4 + i * 11;
      f.input.cost.total_duration_ms = (10 + i * 8) * 60000;
      f.input.prompt_cache.expires_at = NOW + 3400 - i * 120;
      f.overrides.activity.tool = { active: tool, target, running: 1, agents: tool === 'Agent' ? 1 : 0, elapsed: 2 + (i * 7) % 40 };
      f.overrides.activity.todo = { done, total, current, pct: (done / total) * 100 };
      f.overrides.activity.agents = { running: tool === 'Agent' ? 1 : 0, background: agents, spawned: agents + 1 };
      f.overrides.activity.stats = { ...f.overrides.activity.stats, turns: 2 + i, tools: 12 + i * 19, compactions: i > 8 ? 1 : 0 };
      f.overrides.git = { ...f.overrides.git, ahead: Math.floor(i / 3), modified: 1 + i, staged: i > 6 ? 2 : 0 };
    },
  });
  const t = THEMES.light;
  const html = path.join(tmp, `f${i}.html`);
  fs.writeFileSync(html, page(t, card('One session, start to finish', 'The gauges fill, the forecast appears when the limit is in reach, and the current tool changes as Claude works.', term(text, t))));
  const png = path.join(framesDir, `s${String(i).padStart(2, '0')}.png`);
  chrome(['--force-device-scale-factor=1', '--default-background-color=ffffffff', `--window-size=${WIDTH},230`, `--screenshot=${png}`, `file://${html}`]);
  const hold = i === 0 ? 8 : i === STEPS.length - 1 ? 14 : 3;
  for (let k = 0; k < hold; k++) fs.copyFileSync(png, path.join(framesDir, `f${String(frame++).padStart(3, '0')}.png`));
});
const ff = spawnSync('nice', ['-n', '15', 'ffmpeg', '-y', '-loglevel', 'error', '-threads', '2', '-framerate', '5', '-i', path.join(framesDir, 'f%03d.png'), '-vf', 'split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=none', path.join(OUT, 'session.gif')], { encoding: 'utf8' });
if (ff.status !== 0) throw new Error(ff.stderr);

// ---- module table for the README --------------------------------------------------
const readme = path.join(ROOT, 'README.md');
if (fs.existsSync(readme) && OUT === path.join(ROOT, 'assets')) {
  const table = Object.keys(GROUPS).map((g) => `| **${g[0].toUpperCase()}${g.slice(1)}** | | |\n${items.filter((i) => i.group === g).map((i) => `| \`${i.name}\` | ${rowsOn.has(i.name) ? '●' : ''} | ${i.about} |`).join('\n')}`).join('\n');
  const text = fs.readFileSync(readme, 'utf8');
  const next = text.replace(/<!-- modules:start -->[\s\S]*<!-- modules:end -->/, `<!-- modules:start -->\n| Name | On | What it shows |\n|---|---|---|\n${table}\n<!-- modules:end -->`);
  fs.writeFileSync(readme, next);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote images to ${OUT}. ${items.length} modules, ${items.filter((i) => rowsOn.has(i.name)).length} on by default.`);
