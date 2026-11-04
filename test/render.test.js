import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderBar, emit } from '../src/render.js';
import { fixture, FIXTURE_NAMES } from '../src/fixtures.js';
import { readGit } from '../src/git.js';
import { readSource } from '../src/sources.js';
import { textWidth } from '../src/width.js';
import { sha } from '../src/fsutil.js';
import { NOW, THEMES, sandbox, writeConfig, stripAnsi } from './helpers.js';

function render(env, state, opts = {}) {
  const f = fixture(state, NOW);
  return renderBar(f.input, { env, now: NOW, overrides: f.overrides, offline: true, projectDir: null, cols: 120, ...opts });
}

test('every theme renders every state with no problems', () => {
  const s = sandbox();
  for (const theme of THEMES) {
    for (const state of FIXTURE_NAMES) {
      const r = render(s.env, state, { theme });
      assert.deepEqual(r.problems, [], `${theme}/${state}`);
      assert.deepEqual([...r.rc.badStyles], [], `${theme}/${state} styles`);
      assert.ok(stripAnsi(r.text).trim().length > 0, `${theme}/${state} output`);
    }
  }
  s.cleanup();
});

test('no line ever exceeds the terminal width, at any size, charset or depth', () => {
  const s = sandbox();
  for (const theme of THEMES) {
    for (const state of FIXTURE_NAMES) {
      for (const cols of [10, 20, 30, 40, 60, 72, 80, 100, 120, 160, 240]) {
        for (const charset of ['nerd', 'unicode', 'ascii']) {
          const env = { ...s.env, LIMITBAR_CHARSET: charset };
          const r = render(env, state, { theme, cols });
          for (const line of stripAnsi(r.text).split('\n')) {
            // Measured in a real session: Claude Code cuts anything past COLUMNS - 4.
            const limit = Math.max(1, cols - 4);
            assert.ok(textWidth(line) <= limit, `${theme}/${state}/${cols}/${charset}: ${textWidth(line)} > ${limit}: ${line}`);
          }
        }
      }
    }
  }
  s.cleanup();
});

test('colour depths emit only the codes they allow', () => {
  const s = sandbox();
  for (const theme of THEMES) {
    const none = render({ ...s.env, LIMITBAR_COLOR: 'none' }, 'danger', { theme }).text;
    assert.equal(/\x1b\[/.test(none), false, theme);
    const c16 = render({ ...s.env, LIMITBAR_COLOR: '16' }, 'danger', { theme }).text;
    assert.equal(/38;2;|48;2;|38;5;|48;5;/.test(c16), false, theme);
    const c256 = render({ ...s.env, LIMITBAR_COLOR: '256' }, 'danger', { theme }).text;
    assert.equal(/38;2;|48;2;/.test(c256), false, theme);
  }
  assert.equal(/\x1b\[/.test(render({ ...s.env, NO_COLOR: '1' }, 'danger').text), false);
  s.cleanup();
});

test('ascii charset produces plain ascii for every theme layout', () => {
  const s = sandbox();
  writeConfig(s.env, 'theme = "graphite"\n[settings]\ncharset = "ascii"\n');
  const r = render({ ...s.env, LIMITBAR_COLOR: 'none' }, 'working');
  assert.match(stripAnsi(r.text), /^[\x20-\x7e\n]*$/);
  s.cleanup();
});

test('empty, null and partial input still renders without throwing', () => {
  const s = sandbox();
  for (const theme of THEMES) {
    for (const input of [{}, null, 'text', 42, { model: null, context_window: null, cost: null, rate_limits: null, prompt_cache: null, workspace: null }, { context_window: { used_percentage: 'x' } }, { rate_limits: { five_hour: 'x', seven_day: { used_percentage: 'bad' } } }]) {
      const r = renderBar(input, { env: s.env, theme, now: NOW, offline: true, projectDir: null, cols: 100, overrides: { git: null, activity: { tool: {}, todo: {} }, history: { series: {}, rate: {}, eta: {} } } });
      assert.deepEqual(r.problems, [], `${theme} ${JSON.stringify(input)}`);
    }
  }
  s.cleanup();
});

test('a hostile branch name or session name cannot inject escape codes', () => {
  const s = sandbox();
  const evil = 'x\x1b]0;pwned\x07\x1b[2Jy\x1b]8;;http://evil\x1b\\z';
  const f = fixture('working', NOW);
  f.input.session_name = evil;
  f.input.model.display_name = evil;
  f.overrides.git.branch = evil;
  writeConfig(s.env, 'theme = "graphite"\n[[line]]\nleft = ["model", "git", "session"]\n');
  const r = renderBar(f.input, { env: s.env, now: NOW, overrides: f.overrides, offline: true, projectDir: null, cols: 200 });
  assert.equal(r.text.includes('pwned'), false);
  assert.equal(r.text.includes('[2J'), false);
  assert.equal(r.text.includes('evil'), false);
  const noSgr = r.text.replace(/\x1b\[[0-9;]*m/g, '');
  assert.equal(noSgr.includes('\x1b'), false);
  assert.equal(noSgr.includes('\x07'), false);
  s.cleanup();
});

test('links only allow http, https and file', () => {
  const s = sandbox();
  const f = fixture('working', NOW);
  writeConfig(s.env, 'theme = "graphite"\n[[line]]\nleft = ["pr"]\n');
  f.input.pr.url = 'javascript:alert(1)';
  assert.equal(renderBar(f.input, { env: s.env, now: NOW, overrides: f.overrides, offline: true, projectDir: null }).text.includes(']8;;'), false);
  f.input.pr.url = 'https://github.com/a/b/pull/1';
  assert.ok(renderBar(f.input, { env: s.env, now: NOW, overrides: f.overrides, offline: true, projectDir: null }).text.includes(']8;;https://github.com/a/b/pull/1'));
  s.cleanup();
});

test('built-in modules can be rewritten from config', () => {
  const s = sandbox();
  writeConfig(s.env, `
[module.ctx]
format = "context={ctx.pct | round}"
style = "#123456"
[[line]]
left = ["ctx"]
`);
  const r = render(s.env, 'working');
  assert.equal(stripAnsi(r.text), 'context=42');
  assert.ok(r.text.includes('38;2;18;52;86'));
  s.cleanup();
});

test('style tags, dynamic tags with comparisons, if/else and escapes', () => {
  const s = sandbox();
  writeConfig(s.env, `
[palette]
brand = "#010203"
[[line]]
left = '<brand bold>A</> <=ctx.pct >= 40 ? "hot" : "ok">B</> {if ctx.pct > 90}big{elif ctx.pct > 40}mid{else}small{end} \\{x\\} 1 < 2'
`);
  const r = render(s.env, 'working');
  assert.equal(stripAnsi(r.text), 'A B mid {x} 1 < 2');
  assert.ok(r.text.includes('1;38;2;1;2;3'));
  s.cleanup();
});

test('rules can override anything, including swapping the whole theme', () => {
  const s = sandbox();
  writeConfig(s.env, `
theme = "graphite"
[[when]]
name = "narrow"
if = "ctx.pct >= 90"
theme = "cockpit"
[[when]]
if = "ctx.pct < 50"
[when.module.dir]
format = "CALM {dir.name}"
`);
  const danger = render(s.env, 'danger');
  assert.equal(danger.rc.trace.theme, 'cockpit');
  assert.ok(stripAnsi(danger.text).includes('MASTER CAUTION'));
  const calm = render(s.env, 'working');
  assert.equal(calm.rc.trace.theme, 'graphite');
  assert.ok(stripAnsi(calm.text).includes('CALM orbit-api'));
  assert.equal(calm.rc.trace.rules[0].matched, false);
  assert.equal(calm.rc.trace.rules[1].matched, true);
  s.cleanup();
});

test('layout degrades: compact formats first, then lowest priority modules', () => {
  const s = sandbox();
  writeConfig(s.env, `
[module.a]
format = "aaaaaaaaaaaaaaaaaaaa"
compact = "aaa"
priority = 90
[module.b]
format = "bbbbbbbbbbbbbbbbbbbb"
compact = "bbb"
priority = 10
[[line]]
sep = " "
left = ["a", "b"]
`);
  const wide = (cols) => stripAnsi(render(s.env, 'working', { cols, env: { ...s.env, LIMITBAR_NO_PROJECT: '1' } }).text);
  assert.equal(wide(60), `${'a'.repeat(20)} ${'b'.repeat(20)}`);
  assert.equal(wide(20), 'aaa bbb');
  assert.equal(wide(10), 'aaa');
  s.cleanup();
});

test('a rule can swap the layout at a terminal width', () => {
  const s = sandbox();
  writeConfig(s.env, `
[[line]]
left = "wide one"
[[line]]
left = "wide two"
[[when]]
if = "term.cols < 72"
[[when.line]]
left = "narrow"
`);
  assert.equal(stripAnsi(render(s.env, 'working', { cols: 120 }).text), 'wide one\nwide two');
  assert.equal(stripAnsi(render(s.env, 'working', { cols: 60 }).text), 'narrow');
  s.cleanup();
});

test('dusk collapses to one line when narrow', () => {
  const s = sandbox();
  assert.equal(render(s.env, 'working', { theme: 'dusk', cols: 120 }).text.split('\n').length, 3);
  assert.equal(render(s.env, 'working', { theme: 'dusk', cols: 60 }).text.split('\n').length, 1);
  s.cleanup();
});

test('a module that includes itself does not hang', () => {
  const s = sandbox();
  writeConfig(s.env, '[module.a]\nformat = "x{b}"\n[module.b]\nformat = "y{a}"\n[[line]]\nleft = ["a"]\n');
  assert.equal(stripAnsi(render(s.env, 'working').text), 'xy');
  s.cleanup();
});

test('config mistakes show a message and never remove the bar', () => {
  const s = sandbox();
  writeConfig(s.env, 'theme = "graphite"\n[[line\n');
  const r = render(s.env, 'working');
  const text = stripAnsi(r.text);
  assert.ok(text.includes('Opus 5.5'));
  assert.ok(text.includes('limit-bar: config.toml line 2'));
  writeConfig(s.env, '[[line]]\nleft = "{bad"\n');
  assert.ok(stripAnsi(render(s.env, 'working').text).includes('limit-bar: '));
  writeConfig(s.env, 'theme = "nope"\n');
  const missing = stripAnsi(render(s.env, 'working').text);
  assert.ok(missing.includes('Opus 5.5') && missing.includes('not found'));
  s.cleanup();
});

test('themes and the rules inside them cannot run commands', () => {
  const s = sandbox();
  const marker = path.join(s.dir, 'ran');
  const dir = path.join(s.env.XDG_CONFIG_HOME, 'limit-bar', 'themes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'evil.toml'), `
[source.x]
command = "touch ${marker}"
every = "0s"
[module.x]
format = "{source.x.value}"
[[line]]
left = ["x", "model"]
[[when]]
if = "true"
[when.source.y]
command = "touch ${marker}"
`);
  const r = renderBar({ model: { display_name: 'M' }, session_id: 's' }, { env: s.env, theme: 'evil', cols: 80, projectDir: null });
  assert.equal(r.rc.cfg.source?.x, undefined);
  assert.equal(r.rc.cfg.source?.y, undefined);
  assert.equal(fs.existsSync(marker), false);
  s.cleanup();
});

test('a project config is ignored until trusted, and edits revoke trust', () => {
  const s = sandbox();
  const project = path.join(s.dir, 'repo');
  fs.mkdirSync(project);
  const file = path.join(project, '.limit-bar.toml');
  fs.writeFileSync(file, '[[line]]\nleft = "PROJECT"\n');
  const go = () => {
    const f = fixture('working', NOW);
    return renderBar(f.input, { env: s.env, now: NOW, overrides: f.overrides, offline: true, projectDir: project, cols: 100 });
  };
  const untrusted = stripAnsi(go().text);
  assert.equal(untrusted.includes('PROJECT'), false);
  assert.ok(untrusted.includes('run limit-bar trust'));
  const trustFile = path.join(s.env.XDG_STATE_HOME, 'limit-bar', 'trust.json');
  fs.mkdirSync(path.dirname(trustFile), { recursive: true });
  fs.writeFileSync(trustFile, JSON.stringify({ [file]: sha(fs.readFileSync(file, 'utf8')) }));
  assert.equal(stripAnsi(go().text), 'PROJECT');
  fs.writeFileSync(file, '[[line]]\nleft = "CHANGED"\n');
  const changed = stripAnsi(go().text);
  assert.equal(changed.includes('CHANGED'), false);
  assert.ok(changed.includes('changed: run limit-bar trust'));
  s.cleanup();
});

test('git never runs a program named by a repo config', { skip: spawnSync('git', ['--version']).status !== 0 }, () => {
  const s = sandbox();
  const repo = path.join(s.dir, 'repo');
  const marker = path.join(s.dir, 'pwned');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'config', 'core.fsmonitor', `touch ${marker}; false`]);
  fs.writeFileSync(path.join(repo, 'f'), 'x');
  const g = readGit(repo, { ttl: 0, now: NOW, cacheDir: path.join(s.dir, 'c') });
  assert.equal(g.repo, true);
  assert.equal(g.untracked, 1);
  assert.equal(fs.existsSync(marker), false);
  s.cleanup();
});

test('git hides outside a repo', () => {
  const s = sandbox();
  assert.equal(readGit(s.dir, { ttl: 0, now: NOW, cacheDir: path.join(s.dir, 'c') }), null);
  s.cleanup();
});

test('a slow source never delays the render, and its value arrives later', async () => {
  const s = sandbox();
  const cacheDir = path.join(s.dir, 'c');
  const def = { command: 'sleep 0.4; echo ready', every: '1h', timeout: '5s' };
  const ctx = { cwd: s.dir, now: Date.now() / 1000, env: s.env, cacheDir };
  const started = Date.now();
  const first = readSource('x', def, ctx);
  assert.ok(Date.now() - started < 200, 'must return before the command finishes');
  assert.equal(first.value, null);
  const deadline = Date.now() + 5000;
  let value = null;
  while (Date.now() < deadline && value === null) {
    await new Promise((r) => setTimeout(r, 100));
    value = readSource('x', def, { ...ctx, now: Date.now() / 1000 }).value;
  }
  assert.equal(value, 'ready');
  s.cleanup();
});

test('env and file sources, and rules reacting to them', () => {
  const s = sandbox();
  const flag = path.join(s.dir, 'oncall');
  fs.writeFileSync(flag, 'paged\n');
  writeConfig(s.env, `
[source.who]
env = "WHO"
[source.flag]
file = "${flag}"
[var]
alert = "source.flag.value == 'paged'"
[module.who]
if = "source.who.value"
format = "{source.who.value}"
[[line]]
left = ["who"]
[[when]]
if = "var.alert"
[when.module.who]
format = "ALERT {source.who.value}"
`);
  assert.equal(stripAnsi(render({ ...s.env, WHO: 'me' }, 'working').text), 'ALERT me');
  fs.writeFileSync(flag, 'calm\n');
  assert.equal(stripAnsi(render({ ...s.env, WHO: 'me' }, 'working').text), 'me');
  s.cleanup();
});

test('gauges have no gap with colour, and still read correctly without it', () => {
  const s = sandbox();
  writeConfig(s.env, '[[line]]\nleft = "{ctx.pct | bar:10:block}"\n');
  const color = render(s.env, 'working');
  assert.equal(stripAnsi(color.text), `████${'▏'}█████`);
  const plain = stripAnsi(render({ ...s.env, LIMITBAR_COLOR: 'none' }, 'working').text);
  assert.equal(plain, `████▏░░░░░`);
  s.cleanup();
});

test('powerline neighbours of the same colour get a divider', () => {
  const s = sandbox();
  writeConfig(s.env, `
[module.a]
format = "A"
style = "#ffffff on:#102030"
[module.b]
format = "B"
style = "#ffffff on:#102030"
[module.c]
format = "C"
style = "#ffffff on:#304050"
[[line]]
mode = "powerline"
left = ["a", "b", "c"]
`);
  assert.equal(stripAnsi(render(s.env, 'working').text), ' A │ B ▌ C ▌');
  s.cleanup();
});

test('a module named after a variable reads the variable', () => {
  const s = sandbox();
  writeConfig(s.env, '[[line]]\nleft = ["version", "output_style"]\n');
  const f = fixture('working', NOW);
  f.input.output_style = { name: 'concise' };
  const r = renderBar(f.input, { env: s.env, now: NOW, overrides: f.overrides, offline: true, projectDir: null, cols: 100 });
  assert.equal(stripAnsi(r.text), 'v2.1.300  concise');
  s.cleanup();
});

test('append_line adds a row under any theme and keeps its layout', () => {
  const s = sandbox();
  writeConfig(s.env, '[[append_line]]\nleft = ["user_host", "os", "shell", "load"]\n');
  for (const [theme, rows] of [['graphite', 2], ['cockpit', 3], ['dusk', 4]]) {
    const lines = stripAnsi(render(s.env, 'working', { theme }).text).split('\n');
    assert.equal(lines.length, rows, theme);
    assert.match(lines[rows - 1], /^dev@workstation {2}macOS arm64 {2}zsh {2}load 1\.4$/);
  }
  s.cleanup();
});

test('live data reads the real user, and samples never do', () => {
  const s = sandbox();
  writeConfig(s.env, '[[line]]\nleft = ["user", "host"]\n');
  const real = os.userInfo().username;
  const live = renderBar({ cwd: s.dir }, { env: s.env, cols: 100, projectDir: null, offline: true });
  assert.ok(stripAnsi(live.text).includes(real));
  assert.equal(live.scope.user.host.endsWith('.local'), false);
  const sample = stripAnsi(render(s.env, 'working').text);
  assert.equal(sample, 'dev  workstation');
  s.cleanup();
});

test('rate limit projection is computed from the window itself', () => {
  const s = sandbox();
  const r = render(s.env, 'danger');
  const h5 = r.scope.limit.h5;
  assert.ok(Math.abs(h5.projected - (88 * 5) / 3.6) < 0.01);
  assert.equal(h5.will_hit, true);
  assert.ok(h5.hit_in > 0 && h5.hit_in < h5.left);
  const calm = render(s.env, 'working').scope.limit.h5;
  assert.equal(calm.will_hit, false);
  assert.equal(calm.hit_in, null);
  s.cleanup();
});

test('an expired rate window is dropped', () => {
  const s = sandbox();
  const f = fixture('working', NOW);
  f.input.rate_limits.five_hour.resets_at = NOW - 1;
  const r = renderBar(f.input, { env: s.env, now: NOW, overrides: f.overrides, offline: true, projectDir: null });
  assert.equal(r.scope.limit.h5, null);
  s.cleanup();
});

test('a beam gradient sweeps across the whole line, and frames fit exactly', () => {
  const s = sandbox();
  writeConfig(s.env, `
[style]
border = "beam:#8a7bff,#e66f9c,#f6b26b"
[[line]]
prefix = "<border>╭─ </>"
suffix = "<border> ─╮</>"
fill = "─"
fill_style = "border"
left = "title"
right = "end"
[[line]]
prefix = "<border>╰─ </>"
suffix = "<border> ─╯</>"
fill = "─"
fill_style = "border"
keep = true
full = true
`);
  const out = emit([{ t: 'ab', s: {} }, { t: 'cd', s: {} }], 'truecolor');
  assert.equal(stripAnsi(out), 'abcd');
  const r = render(s.env, 'working', { cols: 80 });
  const [top, bottom] = r.text.split('\n');
  assert.ok(new Set(top.match(/38;2;\d+;\d+;\d+/g)).size > 20);
  assert.equal(textWidth(stripAnsi(top)), 76);
  assert.equal(textWidth(stripAnsi(bottom)), 76);
  assert.match(stripAnsi(bottom), /^╰─+─╯$/);
  s.cleanup();
});

test('a labelled gauge keeps its width and writes the percentage inside', () => {
  const s = sandbox();
  writeConfig(s.env, `[bars.tag]
left = "["
right = "]"
label = true
fill = "█"
track = true
empty_style = "faint"
label_fill = "#ffffff"
label_track = "#ffffff"

[[line]]
left = ["{ctx.pct | bar:10:tag}"]
`);
  const f = fixture('working', NOW);
  const plain = renderBar(f.input, { env: { ...s.env, LIMITBAR_COLOR: 'none' }, theme: 'graphite', cols: 80, now: NOW, overrides: f.overrides, offline: true, projectDir: null });
  assert.deepEqual(plain.problems, []);
  assert.equal(stripAnsi(plain.text), '[███42%░░░░]');
  const color = renderBar(f.input, { env: s.env, theme: 'graphite', cols: 80, now: NOW, overrides: f.overrides, offline: true, projectDir: null });
  assert.equal(stripAnsi(color.text), '[   42%    ]');
  assert.match(color.text, /48;2;/);
  s.cleanup();
});

test('indigo shows three lines and falls back cleanly when narrow', () => {
  const s = sandbox();
  const f = fixture('working', NOW);
  const at = (cols) => stripAnsi(renderBar(f.input, { env: s.env, theme: 'indigo', cols, now: NOW, overrides: f.overrides, offline: true, projectDir: null }).text).split('\n');
  const wide = at(120);
  assert.equal(wide.length, 3);
  assert.match(wide[0], /^5h\[ +24% +\]⏰3h12m →\d+% \| 7d\[ +41% +\]⏰4d00h →\d+% \| Opus 5\.5\(84k\/200k\) \| cache 47:10$/);
  assert.match(wide[1], /^↳ orbit-api ⎇ feat\/payments\* · v2\.1\.300$/);
  assert.equal(wide[2], '⚙ effort:high · think:on · fast:off · style:default');
  const fresh = fixture('fresh', NOW);
  const cold = stripAnsi(renderBar(fresh.input, { env: s.env, theme: 'indigo', cols: 120, now: NOW, overrides: fresh.overrides, offline: true, projectDir: null }).text);
  assert.match(cold.split('\n')[0], /cache COLD$/);
  for (const cols of [100, 80, 60, 40]) for (const line of at(cols)) assert.ok(textWidth(line) <= cols - 4, `${cols}: ${line}`);
  s.cleanup();
});

test('themes with their own background cover the full width of every line', () => {
  const s = sandbox();
  for (const theme of ['cyberpunk', 'minecraft', 'neon', 'matrix', 'gameboy']) {
    for (const state of FIXTURE_NAMES) {
      for (const cols of [120, 70, 40]) {
        const r = render(s.env, state, { theme, cols });
        assert.deepEqual(r.problems, [], `${theme}/${state}/${cols}`);
        for (const line of r.lines) {
          assert.ok(line.every((run) => !run.t || run.s.bg), `${theme}/${state}/${cols}: a gap in the background`);
          const text = line.map((run) => run.t).join('');
          assert.equal(textWidth(text), cols - 4, `${theme}/${state}/${cols}: ${text}`);
        }
      }
    }
  }
  s.cleanup();
});

test('a ramp colours labelled gauges by position, and dither shades alternate cells', () => {
  const s = sandbox();
  writeConfig(s.env, `[bars.tag]
label = true
fill = "█"
track = true
color = "ramp"
ramp = ["#0000ff", "#ff0000"]
dither = 0.5
empty_style = "faint"

[[line]]
left = ["{ctx.pct | bar:10:tag}"]
`);
  const r = render(s.env, 'danger', { theme: 'graphite', cols: 80 });
  assert.deepEqual(r.problems, []);
  const bgs = r.lines[0].filter((run) => run.t).map((run) => JSON.stringify(run.s.bg));
  assert.equal(new Set(bgs).size >= 9, true);
  s.cleanup();
});
