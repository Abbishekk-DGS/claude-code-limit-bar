import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateFile, suggest } from '../src/validate.js';
import { sandbox, writeConfig, stripAnsi } from './helpers.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'limit-bar.js');
const run = (env, args, input) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8', input });

test('the render path reads stdin and prints the bar', () => {
  const s = sandbox();
  const r = run({ ...s.env, COLUMNS: '100' }, [], JSON.stringify({ model: { display_name: 'Opus' }, cwd: s.dir, context_window: { used_percentage: 12 } }));
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
  assert.equal(run(s.env, ['install', '--settings', file]).status, 0);
  const cmd = JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command;
  const target = /"([^"]*limit-bar\.js)" *$/.exec(cmd)[1];
  assert.ok(target.startsWith(s.env.XDG_DATA_HOME));
  const r = spawnSync(process.execPath, [target], { env: { ...s.env, COLUMNS: '100' }, encoding: 'utf8', input: JSON.stringify({ model: { display_name: 'Opus' }, cwd: s.dir }) });
  assert.ok(stripAnsi(r.stdout).includes('Opus'));
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(settings.subagentStatusLine.command.endsWith(' subagent'));
  assert.equal(run(s.env, ['uninstall', '--settings', file]).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).subagentStatusLine, undefined);
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

test('show, hide, move, set, color and reset save to their own file', () => {
  const s = sandbox();
  const custom = path.join(s.env.XDG_CONFIG_HOME, 'limit-bar', 'custom.toml');
  const rendered = () => stripAnsi(run({ ...s.env, COLUMNS: '140' }, [], JSON.stringify({ model: { display_name: 'Opus' }, cwd: s.dir, version: '9.9.9', context_window: { used_percentage: 40 } })).stdout);
  assert.ok(rendered().includes('v9.9.9'));
  assert.equal(run(s.env, ['hide', 'version']).status, 0);
  assert.equal(rendered().includes('v9.9.9'), false);
  assert.equal(run(s.env, ['show', 'version', '--row', '1', '--before', 'ctx']).status, 0);
  assert.match(fs.readFileSync(custom, 'utf8'), /"d7", "version", "ctx"/);
  assert.equal(run(s.env, ['move', 'version', '--row', '2']).status, 0);
  assert.equal(run(s.env, ['show', 'nope']).status, 1);
  assert.match(run(s.env, ['show', 'verson']).stdout, /Did you mean version/);
  assert.equal(run(s.env, ['show', 'version', '--before', 'date']).status, 1);
  assert.equal(run(s.env, ['set', 'username', 'neo']).status, 0);
  assert.ok(rendered().includes('neo'));
  assert.equal(run(s.env, ['set', 'gauge_width', 'wide']).status, 1);
  assert.equal(run(s.env, ['set', 'bar', 'nope']).status, 1);
  assert.equal(run(s.env, ['set', 'nonsense', '1']).status, 1);
  assert.equal(run(s.env, ['color', 'pink', '#ff00aa']).status, 0);
  assert.equal(run(s.env, ['color', 'pink', 'red']).status, 1);
  assert.equal(run(s.env, ['validate']).status, 0);
  assert.equal(run(s.env, ['reset']).status, 0);
  assert.equal(fs.existsSync(custom), false);
  assert.equal(run(s.env, ['init']).status, 0);
  assert.equal(run(s.env, ['init']).status, 1);
  s.cleanup();
});

test('customize refuses to start without a terminal', () => {
  const s = sandbox();
  const r = run(s.env, ['customize']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /real terminal/);
  s.cleanup();
});

test('modules lists what is on offer and never the dollar modules', () => {
  const s = sandbox();
  const out = stripAnsi(run(s.env, ['modules']).stdout);
  assert.match(out, /row 1\s+h5/);
  assert.match(out, /off\s+git_stash/);
  assert.equal(/\b(cost|cost_rate|spend)\b/.test(out), false);
  s.cleanup();
});

test('agent panel rows are one JSON line per task, without the working folder', () => {
  const s = sandbox();
  const input = { columns: 90, tasks: [
    { id: 'a1', type: 'local_agent', agentType: 'Explore', status: 'running', description: 'Audit', label: 'Reading config', startTime: Date.now() - 65000, model: 'claude-opus-5-5', contextWindowSize: 200000, tokenCount: 40000, tokenSamples: [10000, 20000, 40000], cwd: '/secret/project-folder' },
    { id: 'a2', type: 'local_agent', agentType: 'Plan', status: 'failed', description: 'x', label: 'x', startTime: Date.now(), tokenCount: 0, tokenSamples: [], cwd: '/secret/project-folder' },
  ] };
  const r = run(s.env, ['subagent'], JSON.stringify(input));
  const rows = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((x) => x.id), ['a1', 'a2']);
  const first = stripAnsi(rows[0].content);
  assert.match(first, /Explore Reading config opus-5-5 1m\d*s? /);
  assert.match(first, /40k 20%/);
  assert.ok(stripAnsi(rows[1].content).includes('failed'));
  assert.equal(r.stdout.includes('project-folder'), false);
  assert.equal(run(s.env, ['subagent'], 'not json').stdout, '');
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
  for (const theme of ['neon']) {
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
  const file = writeConfig(s.env, `[module.ctx]
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
  assert.equal(find('formt').line, 2);
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
  const known = knownPaths(assemble(loadLayers({ env: s.env }), s.env));
  const section = (name) => doc.split(`<!-- ${name} -->`)[1];
  const rows = (name) => [...section(name).matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]);
  const vars = rows('vars');
  assert.ok(vars.length > 60);
  for (const v of vars) assert.ok(known.has(v), `documented variable missing: ${v}`);
  for (const k of known) {
    if (k.startsWith('g.') || k.startsWith('var.') || !/\./.test(k)) continue;
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
    assert.ok(stripAnsi(r.stdout).trim().length > 0, block);
    assert.equal(run(s.env, ['explain', '--state', 'working']).status, 0, block);
  }
  s.cleanup();
});

test('suggest only offers close matches', () => {
  assert.equal(suggest('formt', ['format', 'style']), 'format');
  assert.equal(suggest('zzzzzzzz', ['format', 'style']), null);
});

test('doctor, fields, explain and preview all work', () => {
  const s = sandbox();
  assert.equal(run(s.env, ['doctor']).status, 0);
  const fields = JSON.parse(run(s.env, ['fields', '--state', 'danger', '--json']).stdout);
  assert.equal(fields['ctx.pct'], 91);
  assert.equal(fields['git.branch'], 'hotfix/ledger-race');
  assert.equal(Object.keys(fields).some((k) => k.startsWith('raw') || k.startsWith('env')), false);
  const explain = run(s.env, ['explain', '--state', 'working']);
  assert.equal(explain.status, 0);
  assert.ok(explain.stdout.includes('Modules'));
  assert.equal(run(s.env, ['preview', '--cols', '100']).status, 0);
  assert.equal(run(s.env, ['preview', '--state', 'nope']).status, 1);
  assert.equal(run(s.env, ['themes']).status, 1);
  assert.equal(run(s.env, ['use', 'cockpit']).status, 1);
  assert.equal(run(s.env, ['nonsense']).status, 1);
  s.cleanup();
});
