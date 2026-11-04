import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateFile, suggest } from '../src/validate.js';
import { THEMES, sandbox, writeConfig, stripAnsi } from './helpers.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'limit-bar.js');
const run = (env, args, input) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', input });

test('the render path reads stdin and prints the bar', () => {
  const s = sandbox();
  const r = run({ ...s.env, COLUMNS: '100', LIMITBAR_THEME: 'graphite' }, [], JSON.stringify({ model: { display_name: 'Opus' }, cwd: s.dir, context_window: { used_percentage: 12 } }));
  assert.equal(r.status, 0);
  assert.ok(stripAnsi(r.stdout).includes('Opus'));
  assert.ok(stripAnsi(r.stdout).includes('12%'));
  s.cleanup();
});

test('bad stdin still prints something and exits cleanly', () => {
  const s = sandbox();
  const r = run(s.env, [], 'this is not json');
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  s.cleanup();
});

test('install keeps other settings, and uninstall restores the previous status line', () => {
  const s = sandbox();
  const file = path.join(s.dir, 'settings.json');
  const original = { model: 'opus', permissions: { allow: ['Bash'] }, statusLine: { type: 'command', command: 'old-bar' } };
  fs.writeFileSync(file, JSON.stringify(original));
  assert.equal(run(s.env, ['install', '--settings', file, '--link', '--refresh', '3']).status, 0);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.permissions, original.permissions);
  assert.ok(after.statusLine.command.includes('limit-bar.js'));
  assert.equal(after.statusLine.refreshInterval, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.limit-bar.bak`, 'utf8')), original);
  assert.equal(run(s.env, ['install', '--settings', file, '--link']).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.limit-bar.bak`, 'utf8')), original, 'reinstall keeps the first backup');
  assert.equal(run(s.env, ['uninstall', '--settings', file]).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
  s.cleanup();
});

test('a normal install copies itself to a stable place that works on its own', () => {
  const s = sandbox();
  const file = path.join(s.dir, 'settings.json');
  assert.equal(run(s.env, ['install', '--settings', file, '--theme', 'cockpit']).status, 0);
  const cmd = JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command;
  const target = /"([^"]*limit-bar\.js)" *$/.exec(cmd)[1];
  assert.ok(target.startsWith(s.env.XDG_DATA_HOME));
  const r = spawnSync(process.execPath, [target], { env: { ...s.env, COLUMNS: '100' }, encoding: 'utf8', input: JSON.stringify({ model: { display_name: 'Opus' }, cwd: s.dir }) });
  assert.ok(stripAnsi(r.stdout).includes('OPUS'));
  s.cleanup();
});

test('install uses a Node path that survives upgrades', () => {
  const s = sandbox();
  const stable = path.join(s.dir, 'stable-bin');
  fs.mkdirSync(stable);
  fs.symlinkSync(process.execPath, path.join(stable, 'node'));
  const file = path.join(s.dir, 'settings.json');
  const env = { ...s.env, PATH: `${stable}${path.delimiter}${process.env.PATH}` };
  assert.equal(run(env, ['install', '--settings', file, '--link']).status, 0);
  const cmd = JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command;
  assert.ok(cmd.startsWith(`"${path.join(stable, 'node')}"`), cmd);
  s.cleanup();
});

test('install refuses to touch invalid settings, and dry run writes nothing', () => {
  const s = sandbox();
  const file = path.join(s.dir, 'settings.json');
  fs.writeFileSync(file, '{ broken');
  assert.equal(run(s.env, ['install', '--settings', file, '--link']).status, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
  fs.writeFileSync(file, '{}');
  const dry = run(s.env, ['install', '--settings', file, '--link', '--dry-run']);
  assert.equal(dry.status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
  s.cleanup();
});

test('uninstall leaves another tool alone', () => {
  const s = sandbox();
  const file = path.join(s.dir, 'settings.json');
  const other = { statusLine: { type: 'command', command: 'other-tool' } };
  fs.writeFileSync(file, JSON.stringify(other));
  run(s.env, ['uninstall', '--settings', file]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), other);
  s.cleanup();
});

test('use, init and theme new', () => {
  const s = sandbox();
  assert.equal(run(s.env, ['use', 'nope']).status, 1);
  assert.equal(run(s.env, ['use', 'cockpit']).status, 0);
  const file = path.join(s.env.XDG_CONFIG_HOME, 'limit-bar', 'config.toml');
  assert.match(fs.readFileSync(file, 'utf8'), /^theme = "cockpit"/m);
  assert.equal(run(s.env, ['init']).status, 1);
  assert.equal(run(s.env, ['theme', 'new', 'mine', '--from', 'cockpit']).status, 0);
  assert.equal(run(s.env, ['use', 'mine']).status, 0);
  assert.equal(run(s.env, ['theme', 'new', '../evil']).status, 1);
  s.cleanup();
});

test('theme names cannot escape the theme folders', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.dir, 'x.toml'), '');
  assert.equal(run(s.env, ['use', '../../x']).status, 1);
  s.cleanup();
});

test('trust and untrust a project, listing the commands it will run', () => {
  const s = sandbox();
  const project = path.join(s.dir, 'repo');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, '.limit-bar.toml'), '[source.x]\ncommand = "echo hi"\n');
  const r = spawnSync(process.execPath, [BIN, 'trust'], { env: s.env, cwd: project, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('x: echo hi'));
  assert.equal(spawnSync(process.execPath, [BIN, 'untrust'], { env: s.env, cwd: project }).status, 0);
  s.cleanup();
});

test('every built-in theme and the starter config pass validation cleanly', () => {
  const s = sandbox();
  const root = path.join(path.dirname(BIN), '..');
  for (const theme of THEMES) {
    assert.deepEqual(validateFile(path.join(root, 'src', 'themes', `${theme}.toml`), s.env), [], theme);
  }
  assert.deepEqual(validateFile(path.join(root, 'examples', 'starter.toml'), s.env), []);
  for (const name of fs.readdirSync(path.join(root, 'examples'))) {
    assert.deepEqual(validateFile(path.join(root, 'examples', name), s.env), [], name);
  }
  s.cleanup();
});

test('validate gives line numbers and suggestions', () => {
  const s = sandbox();
  const file = writeConfig(s.env, `theme = "graphite"
[module.ctx]
formt = "x"
[module.git]
if = "git.brnch"
style = "notacolour"
[[line]]
left = ["modle", "dir"]
[[when]]
if = "1 +"
`);
  const issues = validateFile(file, s.env);
  const find = (needle) => issues.find((i) => i.message.includes(needle));
  assert.equal(find('formt').line, 3);
  assert.ok(find('formt').message.includes('did you mean "format"'));
  assert.ok(find('git.brnch').message.includes('git.branch'));
  assert.equal(find('git.brnch').level, 'warning');
  assert.ok(find('notacolour'));
  assert.ok(find('modle').message.includes('did you mean "model"'));
  assert.ok(find('unexpected end'));
  assert.equal(run(s.env, ['validate']).status, 1);
  s.cleanup();
});

test('every variable, filter and function in the reference exists', async () => {
  const s = sandbox();
  const root = path.join(path.dirname(BIN), '..');
  const doc = fs.readFileSync(path.join(root, 'docs', 'CONFIG.md'), 'utf8');
  const { knownPaths } = await import('../src/validate.js');
  const { loadLayers, assemble } = await import('../src/config.js');
  const { FILTERS } = await import('../src/template.js');
  const { FUNCS } = await import('../src/expr.js');
  const known = knownPaths(assemble(loadLayers({ env: s.env }), 'graphite', s.env));
  const section = (name) => doc.split(`<!-- ${name} -->`)[1];
  const rows = (name) => [...section(name).matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]);
  const vars = rows('vars');
  assert.ok(vars.length > 60);
  for (const v of vars) assert.ok(known.has(v), `documented variable missing: ${v}`);
  for (const k of known) {
    if (k.startsWith('g.') || !/\./.test(k)) continue;
    assert.ok(vars.includes(k), `variable not documented: ${k}`);
  }
  for (const f of rows('filters')) assert.ok(Object.hasOwn(FILTERS, f), f);
  assert.deepEqual(rows('filters').sort(), Object.keys(FILTERS).sort());
  for (const f of rows('funcs')) assert.ok(Object.hasOwn(FUNCS, f), f);
  assert.deepEqual(rows('funcs').sort(), Object.keys(FUNCS).sort());
  s.cleanup();
});

test('every config example in the README is valid and renders', () => {
  const s = sandbox();
  const root = path.join(path.dirname(BIN), '..');
  const blocks = [...fs.readFileSync(path.join(root, 'README.md'), 'utf8').matchAll(/```toml\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(blocks.length >= 5);
  for (const block of blocks) {
    const file = writeConfig(s.env, block);
    assert.deepEqual(validateFile(file, s.env), [], block);
    const r = run({ ...s.env, COLUMNS: '120' }, [], JSON.stringify({ model: { display_name: 'Opus' }, cwd: s.dir, context_window: { used_percentage: 90 } }));
    assert.equal(stripAnsi(r.stdout).includes('limit-bar:'), false, `${block}\n${r.stdout}`);
  }
  s.cleanup();
});

test('suggest only offers close matches', () => {
  assert.equal(suggest('formt', ['format', 'style']), 'format');
  assert.equal(suggest('zzzzzzzz', ['format', 'style']), null);
});

test('doctor, fields, explain, themes and preview all work', () => {
  const s = sandbox();
  assert.equal(run(s.env, ['doctor']).status, 0);
  const fields = JSON.parse(run(s.env, ['fields', '--state', 'danger', '--json']).stdout);
  assert.equal(fields['ctx.pct'], 91);
  assert.equal(fields['git.branch'], 'hotfix/ledger-race');
  assert.equal(Object.keys(fields).some((k) => k.startsWith('raw') || k.startsWith('env')), false);
  const explain = run(s.env, ['explain', '--state', 'working']);
  assert.equal(explain.status, 0);
  assert.ok(explain.stdout.includes('Modules'));
  assert.equal(run(s.env, ['themes', '--cols', '100']).status, 0);
  assert.equal(run(s.env, ['preview', 'all', '--cols', '100']).status, 0);
  assert.equal(run(s.env, ['preview', 'nope']).status, 1);
  assert.equal(run(s.env, ['nonsense']).status, 1);
  s.cleanup();
});
