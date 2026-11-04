// Every subcommand except rendering lives here, so the render path stays small.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderBar } from './render.js';
import { FIXTURE_NAMES, fixture } from './fixtures.js';
import { customFile, projectConfigFile, projectTrustState, readTrust, trustPath, userConfigFiles } from './config.js';
import { addTo, catalog, currentConfig, currentRows, isHex, readCustom, removeFrom, rowOf, runEditor, trimRows, writeCustom } from './customize.js';
import { validateAll, validateFile, formatIssue, suggest } from './validate.js';
import { readJson, sha, writeAtomic } from './fsutil.js';
import { cacheDir, claudeDir, configDir, dataDir, stateDir } from './paths.js';
import { parseToml } from './toml.js';
import { detectDepth } from './color.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const say = (s = '') => process.stdout.write(`${s}\n`);
const THEME_NOW = () => Date.now() / 1000;

const HELP = `limit-bar ${VERSION}

Customise
  limit-bar customize                  live editor with a preview
  limit-bar modules [FILTER]           everything you can show, and where it is
  limit-bar rows                       the current layout
  limit-bar show NAME [--row N] [--before X | --after X]
  limit-bar hide NAME
  limit-bar move NAME --row N [--before X | --after X]
  limit-bar set [KEY VALUE]            settings: username, gauge_width, gauge_show,
                                       bar, clock, warn, hot, charset, sep and more
  limit-bar color [NAME #HEX]          change any neon colour
  limit-bar reset                      back to the defaults

Look and check
  limit-bar preview [--state fresh|working|danger|all] [--cols N]
                 [--charset nerd|unicode|ascii] [--color truecolor|256|16|none]
  limit-bar init [--force]             write a commented starter config
  limit-bar validate [FILE]            check config with file and line numbers
  limit-bar explain [--state NAME]     show which files, rules and modules applied
  limit-bar fields [FILTER] [--json]   list every variable with its current value
  limit-bar trust | untrust            allow or revoke this project's config file
  limit-bar doctor                     check the whole setup
  limit-bar bench                      measure render time

Set up
  limit-bar install [--refresh SECONDS] [--link] [--no-agent-rows] [--dry-run] [--settings FILE]
  limit-bar uninstall [--purge] [--settings FILE]

Config: ${path.join(configDir(), 'config.toml')}
`;

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}

function previewEnv(flags) {
  const env = { ...process.env };
  if (flags.charset) env.LIMITBAR_CHARSET = String(flags.charset);
  if (flags.color) env.LIMITBAR_COLOR = String(flags.color);
  return env;
}

function renderFixture(state, flags, env) {
  const now = THEME_NOW();
  const f = fixture(state, now);
  const cols = Number(flags.cols) || process.stdout.columns || 120;
  return renderBar(f.input, { env, cols, now, overrides: f.overrides, projectDir: null, offline: true });
}

function cmdPreview(flags) {
  const env = previewEnv(flags);
  const states = !flags.state || flags.state === 'all' ? FIXTURE_NAMES : [String(flags.state)];
  for (const s of states) if (!FIXTURE_NAMES.includes(s)) { say(`Unknown state "${s}". Use ${FIXTURE_NAMES.join(', ')} or all.`); return 1; }
  for (const state of states) {
    say(`\x1b[2m${state}\x1b[0m`);
    say(renderFixture(state, flags, env).text);
    say();
  }
  return 0;
}

function mainConfigPath(env = process.env) {
  return env.LIMITBAR_CONFIG || path.join(configDir(env), 'config.toml');
}

function cmdInit(flags) {
  const file = mainConfigPath();
  if (fs.existsSync(file) && !flags.force) {
    say(`${file} already exists. Use --force to replace it.`);
    return 1;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'examples', 'starter.toml'), file);
  say(`Wrote ${file}`);
  return 0;
}

// ---- customising ----------------------------------------------------------

const SET_KEYS = {
  username: 'text', gauge_width: 'int', gauge_show: ['used', 'left'], bar: 'bar', clock: ['24h', '12h'],
  warn: 'int', hot: 'int', charset: ['nerd', 'unicode', 'ascii'], color: ['auto', 'truecolor', '256', '16', 'none'],
  sep: 'text', margin: 'int', links: 'bool', notices: 'bool', git_ttl: 'int', ctx_limit: 'int',
};

function saveCustom(mutate) {
  if (process.env.LIMITBAR_CONFIG) { say('LIMITBAR_CONFIG is set, which replaces the file this saves to. Edit that file instead.'); return 1; }
  const custom = readCustom();
  mutate(custom);
  writeCustom(custom);
  return 0;
}

const saveRows = (rows) => saveCustom((c) => { c.layout = { rows }; });

function printRows(rows) {
  rows.forEach((row, i) => say(`  row ${i + 1}  ${row.join(' ') || '(empty)'}`));
}

function needModule(name, cfg) {
  if (!name) { say('Which one? List them with: limit-bar modules'); return false; }
  if (Object.hasOwn(cfg.module ?? {}, name)) return true;
  const hit = suggest(name, Object.keys(cfg.module ?? {}));
  say(`No module called "${name}".${hit ? ` Did you mean ${hit}?` : ''} List them with: limit-bar modules`);
  return false;
}

function placeArgs(flags, rows) {
  const opts = {};
  if (flags.before !== undefined) opts.before = String(flags.before);
  if (flags.after !== undefined) opts.after = String(flags.after);
  if (flags.row !== undefined) {
    const n = Number(flags.row);
    if (!Number.isInteger(n) || n < 1) { say('--row must be a whole number, 1 or more.'); return null; }
    opts.row = n - 1;
  }
  const anchor = opts.before ?? opts.after;
  if (anchor !== undefined && rowOf(rows, anchor) < 0) { say(`"${anchor}" is not on any row.`); return null; }
  return opts;
}

function cmdShow(rest, flags) {
  const cfg = currentConfig();
  if (!needModule(rest[0], cfg)) return 1;
  const rows = currentRows();
  const opts = placeArgs(flags, rows);
  if (!opts) return 1;
  const next = addTo(rows, rest[0], opts);
  if (!next) { say('That row is out of range.'); return 1; }
  const code = saveRows(next);
  if (!code) printRows(next);
  return code;
}

function cmdHide(rest) {
  const cfg = currentConfig();
  if (!needModule(rest[0], cfg)) return 1;
  const rows = currentRows();
  if (rowOf(rows, rest[0]) < 0) { say(`${rest[0]} is already off.`); return 0; }
  const next = trimRows(removeFrom(rows, rest[0]));
  const code = saveRows(next);
  if (!code) printRows(next);
  return code;
}

function cmdMove(rest, flags) {
  if (flags.row === undefined && flags.before === undefined && flags.after === undefined) { say('Usage: limit-bar move NAME --row N [--before X | --after X]'); return 1; }
  return cmdShow(rest, flags);
}

function cmdRows() {
  printRows(currentRows());
  return 0;
}

function cmdModules(rest) {
  const cfg = currentConfig();
  const rows = currentRows();
  const filter = rest[0];
  let group = null;
  for (const item of catalog(cfg)) {
    if (filter && !`${item.name} ${item.group} ${item.about}`.toLowerCase().includes(filter.toLowerCase())) continue;
    if (item.group !== group) { group = item.group; say(`\n\x1b[1m${group}\x1b[0m`); }
    const row = rowOf(rows, item.name);
    say(`  ${row >= 0 ? `row ${row + 1}` : '  off'}  ${item.name.padEnd(13)} \x1b[2m${item.about}\x1b[0m`);
  }
  say('\nTurn one on with: limit-bar show NAME --row N');
  return 0;
}

function cmdSet(rest) {
  const cfg = currentConfig();
  if (!rest.length) {
    for (const key of Object.keys(SET_KEYS)) say(`  ${key.padEnd(12)} ${cfg.settings?.[key] ?? '(default)'}`);
    return 0;
  }
  const [key, ...parts] = rest;
  const raw = parts.join(' ');
  const kind = SET_KEYS[key];
  if (!kind) {
    const hit = suggest(key, Object.keys(SET_KEYS));
    say(`Unknown setting "${key}".${hit ? ` Did you mean ${hit}?` : ''}`);
    return 1;
  }
  if (!raw) { say(`Usage: limit-bar set ${key} VALUE`); return 1; }
  let value = raw;
  if (kind === 'int') {
    value = Number(raw);
    if (!Number.isInteger(value) || value < 0) { say(`${key} must be a whole number.`); return 1; }
  } else if (kind === 'bool') {
    if (raw !== 'true' && raw !== 'false') { say(`${key} must be true or false.`); return 1; }
    value = raw === 'true';
  } else if (kind === 'bar') {
    if (!Object.hasOwn(cfg.bars ?? {}, raw)) { say(`Gauge designs: ${Object.keys(cfg.bars ?? {}).join(', ')}`); return 1; }
  } else if (Array.isArray(kind) && !kind.includes(raw)) {
    say(`${key} must be one of: ${kind.join(', ')}`);
    return 1;
  }
  const code = saveCustom((c) => { c.settings = { ...c.settings, [key]: value }; });
  if (!code) say(`${key} = ${value}`);
  return code;
}

function cmdColor(rest) {
  const cfg = currentConfig();
  if (!rest.length) {
    for (const [name, hex] of Object.entries(cfg.palette ?? {})) say(`  ${name.padEnd(8)} ${hex}`);
    return 0;
  }
  const [name, hex] = rest;
  if (!Object.hasOwn(cfg.palette ?? {}, name)) {
    const hit = suggest(name, Object.keys(cfg.palette ?? {}));
    say(`No colour called "${name}".${hit ? ` Did you mean ${hit}?` : ''}`);
    return 1;
  }
  if (!hex || !isHex(hex)) { say('Colours are written like #ff2bd6.'); return 1; }
  const code = saveCustom((c) => { c.palette = { ...c.palette, [name]: hex }; });
  if (!code) say(`${name} = ${hex}`);
  return code;
}

function cmdReset() {
  const file = customFile();
  if (!fs.existsSync(file)) { say('Nothing to reset.'); return 0; }
  fs.unlinkSync(file);
  say('Back to the defaults. Your config.toml was left alone.');
  return 0;
}

function cmdValidate(rest) {
  const { files, issues } = rest[0] ? { files: [rest[0]], issues: validateFile(rest[0]) } : validateAll();
  if (!files.length) { say('No config files found, so built-in defaults apply. Create one with: limit-bar init'); return 0; }
  for (const issue of issues) say(formatIssue(issue));
  const errors = issues.filter((i) => i.level !== 'warning').length;
  const warnings = issues.length - errors;
  say(issues.length ? `${errors} error(s), ${warnings} warning(s) in ${files.length} file(s)` : `OK: ${files.length} file(s) checked`);
  return errors ? 1 : 0;
}

function lastPayload() {
  return readJson(path.join(cacheDir(), 'last.json'));
}

function payloadFor(flags) {
  if (flags.state) {
    const f = fixture(String(flags.state), THEME_NOW());
    if (!f) return null;
    return { input: f.input, overrides: f.overrides, label: `sample "${flags.state}"` };
  }
  const last = lastPayload();
  if (last) return { input: last, overrides: undefined, label: `last real session update, from ${last.workspace?.current_dir ?? last.cwd ?? 'an unknown folder'}` };
  const f = fixture('working', THEME_NOW());
  return { input: f.input, overrides: f.overrides, label: 'sample "working" (no real session seen yet)' };
}

function cmdExplain(flags) {
  const p = payloadFor(flags);
  if (!p) { say(`Unknown state. Use ${FIXTURE_NAMES.join(', ')}.`); return 1; }
  const started = process.hrtime.bigint();
  const r = renderBar(p.input, { overrides: p.overrides, offline: true, cols: Number(flags.cols) || undefined });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  say(`Data       ${p.label}`);
  say(`Width      ${r.scope.term.cols} columns, ${r.width} usable`);
  say(`Colour     ${r.depth}`);
  say(`Charset    ${r.rc.charset}`);
  say(`Render     ${ms.toFixed(1)} ms`);
  say('\nConfig files, lowest priority first');
  say('  built-in defaults');
  say('  neon');
  for (const f of r.layers.files) say(`  ${f}`);
  say('\nRules');
  if (!r.rc.trace.rules.length) say('  none');
  for (const rule of r.rc.trace.rules) {
    say(`  ${rule.matched ? 'matched ' : 'skipped '} ${rule.name ? `${rule.name}: ` : ''}${rule.if}`);
  }
  say('\nModules');
  const mods = Object.entries(r.rc.trace.modules);
  say(`  shown:  ${mods.filter(([, v]) => v === 'shown').map(([k]) => k).join(', ') || 'none'}`);
  say(`  hidden, nothing to show: ${mods.filter(([, v]) => v === 'hidden').map(([k]) => k).join(', ') || 'none'}`);
  say(`  dropped, no room: ${mods.filter(([, v]) => v === 'dropped').map(([k]) => k).join(', ') || 'none'}`);
  say(`  disabled: ${mods.filter(([, v]) => v === 'off').map(([k]) => k).join(', ') || 'none'}`);
  if (r.problems.length) { say('\nProblems'); for (const x of r.problems) say(`  ${x}`); }
  if (r.layers.notices.length) { say('\nNotices'); for (const x of r.layers.notices) say(`  ${x}`); }
  say('\nOutput');
  say(r.text);
  return r.problems.length ? 1 : 0;
}

function collectFields(obj, prefix, out, depth = 0) {
  for (const key of Object.keys(obj)) {
    if (!prefix && key === 'raw') continue;
    const p = prefix ? `${prefix}.${key}` : key;
    const v = obj[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 5) collectFields(v, p, out, depth + 1);
    else out[p] = v;
  }
  return out;
}

function cmdFields(flags, rest) {
  const p = payloadFor(flags);
  if (!p) { say(`Unknown state. Use ${FIXTURE_NAMES.join(', ')}.`); return 1; }
  const r = renderBar(p.input, { overrides: { history: { series: { ctx: [], cost: [], h5: [], d7: [], tokens: [] }, rate: {}, eta: {} }, ...p.overrides }, offline: true });
  let fields = collectFields(r.scope, '', {});
  if (rest[0]) fields = Object.fromEntries(Object.entries(fields).filter(([k]) => k.includes(rest[0])));
  if (flags.json) { say(JSON.stringify(fields, null, 2)); return 0; }
  say(`Values from: ${p.label}\n`);
  const pad = Math.max(...Object.keys(fields).map((k) => k.length), 0) + 2;
  for (const [k, v] of Object.entries(fields)) {
    const shown = Array.isArray(v) ? `[${v.length} values]` : v === null || v === undefined ? '\x1b[2mnull\x1b[0m' : JSON.stringify(v);
    say(`${k.padEnd(pad)}${shown}`);
  }
  return 0;
}

function cmdTrust(revoke) {
  const file = projectConfigFile(process.cwd());
  if (!file) { say('No .limit-bar.toml in this directory.'); return 1; }
  const trust = readTrust();
  if (revoke) {
    delete trust[file];
    writeAtomic(trustPath(process.env), JSON.stringify(trust, null, 2));
    say(`No longer trusted: ${file}`);
    return 0;
  }
  const text = fs.readFileSync(file, 'utf8');
  const commands = [];
  try {
    const layer = parseToml(text);
    for (const [name, def] of Object.entries(layer.source ?? {})) if (def?.command) commands.push(`${name}: ${def.command}`);
    (layer.when ?? []).forEach((rule) => { for (const [name, def] of Object.entries(rule.source ?? {})) if (def?.command) commands.push(`${name}: ${def.command}`); });
  } catch (e) {
    say(`Cannot trust a file that does not parse: ${e.message}`);
    return 1;
  }
  trust[file] = sha(text);
  writeAtomic(trustPath(process.env), JSON.stringify(trust, null, 2));
  say(`Trusted: ${file}`);
  if (commands.length) {
    say('This file will run these commands in the background:');
    for (const c of commands) say(`  ${c}`);
  }
  say('Any change to the file revokes trust until you run this again.');
  return 0;
}

// ---- install --------------------------------------------------------------

const settingsPath = (flags) => (flags.settings ? path.resolve(String(flags.settings)) : path.join(claudeDir(), 'settings.json'));
const previousFile = () => path.join(stateDir(), 'previous-statusline.json');
const previousAgentRowsFile = () => path.join(stateDir(), 'previous-subagent-statusline.json');
const quote = (p) => `"${p.replace(/\\/g, '/')}"`;

// process.execPath is often a versioned location such as Homebrew's Cellar, which
// stops existing after an upgrade and would leave a blank status bar. Prefer the
// same Node as found through PATH, which keeps working across upgrades.
export function stableNodePath(env = process.env, execPath = process.execPath) {
  let real;
  try { real = fs.realpathSync(execPath); } catch { return execPath; }
  const names = process.platform === 'win32' ? ['node.exe'] : ['node'];
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.realpathSync(candidate) === real) return candidate;
      } catch { /* not here */ }
    }
  }
  return execPath;
}

function copyApp(dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const item of ['bin', 'src', 'examples', 'package.json']) {
    fs.cpSync(path.join(ROOT, item), path.join(dest, item), { recursive: true });
  }
}

function cmdInstall(flags) {
  const file = settingsPath(flags);
  let settings = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      say(`${file} is not valid JSON, so nothing was changed.\n${e.message}`);
      return 1;
    }
  }
  const refresh = flags.refresh === undefined ? 5 : Number(flags.refresh);
  if (!Number.isInteger(refresh) || refresh < 1) { say('--refresh must be a whole number of seconds, 1 or more.'); return 1; }

  const appDir = flags.link ? ROOT : path.join(dataDir(), 'app');
  const bin = path.join(appDir, 'bin', 'limit-bar.js');
  const statusLine = { type: 'command', command: `${quote(stableNodePath())} ${quote(bin)}`, padding: 0, refreshInterval: refresh };
  const agentRows = flags['no-agent-rows'] ? null : { type: 'command', command: `${quote(stableNodePath())} ${quote(bin)} subagent` };

  if (flags['dry-run']) {
    say(`Would write to ${file}:\n${JSON.stringify({ statusLine, ...(agentRows ? { subagentStatusLine: agentRows } : {}) }, null, 2)}`);
    if (settings.statusLine) say(`\nReplacing (kept for limit-bar uninstall):\n${JSON.stringify({ statusLine: settings.statusLine }, null, 2)}`);
    if (!flags.link) say(`\nWould copy limit-bar to ${appDir}`);
    return 0;
  }

  if (!flags.link) copyApp(appDir);
  const already = String(settings.statusLine?.command ?? '').includes('limit-bar.js');
  if (settings.statusLine && !already) writeAtomic(previousFile(), JSON.stringify(settings.statusLine, null, 2));
  // Reinstalling must not replace the backup of your original file with its own output.
  if (fs.existsSync(file) && !already) fs.copyFileSync(file, `${file}.limit-bar.bak`);
  settings.statusLine = statusLine;
  if (agentRows) {
    const current = settings.subagentStatusLine;
    if (current && !String(current.command ?? '').includes('limit-bar.js')) writeAtomic(previousAgentRowsFile(), JSON.stringify(current, null, 2));
    settings.subagentStatusLine = agentRows;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`, 0o644);

  const binDir = path.join(os.homedir(), '.local', 'bin');
  let linked = null;
  if (!flags.settings && process.platform !== 'win32' && fs.existsSync(binDir)) {
    const link = path.join(binDir, 'limit-bar');
    try {
      if (fs.lstatSync(link, { throwIfNoEntry: false })) fs.unlinkSync(link);
      fs.symlinkSync(bin, link);
      fs.chmodSync(bin, 0o755);
      linked = link;
    } catch { /* the printed command below still works */ }
  }
  say(`Installed. ${file} now runs limit-bar, refreshing every ${refresh}s.`);
  say(`Your old file is saved as ${path.basename(file)}.limit-bar.bak`);
  say(linked ? 'Try: limit-bar customize' : `Try: node ${quote(bin)} customize`);
  return 0;
}

function cmdUninstall(flags) {
  const file = settingsPath(flags);
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    say(`Cannot read ${file}, so nothing was changed.\n${e.message}`);
    return 1;
  }
  if (!String(settings.statusLine?.command ?? '').includes('limit-bar.js')) {
    say('limit-bar is not the active status line, so settings were left alone.');
  } else {
    const previous = readJson(previousFile());
    if (previous) settings.statusLine = previous; else delete settings.statusLine;
    if (String(settings.subagentStatusLine?.command ?? '').includes('limit-bar.js')) {
      const previousRows = readJson(previousAgentRowsFile());
      if (previousRows) settings.subagentStatusLine = previousRows; else delete settings.subagentStatusLine;
    }
    writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`, 0o644);
    say(previous ? 'Restored your previous status line.' : 'Removed the status line setting.');
  }
  if (!flags.settings) {
    const link = path.join(os.homedir(), '.local', 'bin', 'limit-bar');
    try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch { /* not linked */ }
    fs.rmSync(path.join(dataDir(), 'app'), { recursive: true, force: true });
  }
  if (flags.purge) {
    for (const dir of [cacheDir(), stateDir()]) fs.rmSync(dir, { recursive: true, force: true });
    say('Removed cache and state.');
  }
  say(`Your config is untouched: ${configDir()}`);
  return 0;
}

// ---- doctor and bench -----------------------------------------------------

function cmdDoctor() {
  let bad = 0;
  const row = (ok, label, detail = '') => {
    if (ok === false) bad++;
    say(`${ok === true ? 'ok  ' : ok === false ? 'FAIL' : 'note'}  ${label}${detail ? `: ${detail}` : ''}`);
  };
  const major = Number(process.versions.node.split('.')[0]);
  row(major >= 18, 'Node.js', `${process.version}${major >= 18 ? '' : ', needs 18 or newer'}`);
  const settingsFile = path.join(claudeDir(), 'settings.json');
  const settings = readJson(settingsFile);
  const cmd = settings?.statusLine?.command;
  if (String(cmd ?? '').includes('limit-bar.js')) {
    row(true, 'Claude Code is using limit-bar', cmd);
    row(settings.statusLine.refreshInterval ? true : null, 'Refresh interval', settings.statusLine.refreshInterval ? `${settings.statusLine.refreshInterval}s` : 'none, so countdowns only move on events');
    const targetMatch = /"([^"]*limit-bar\.js)"/.exec(cmd);
    if (targetMatch) row(fs.existsSync(targetMatch[1]), 'Installed script exists', targetMatch[1]);
    const nodeMatch = /^"([^"]+)"/.exec(cmd);
    if (nodeMatch) row(fs.existsSync(nodeMatch[1]), 'Node path in settings exists', fs.existsSync(nodeMatch[1]) ? nodeMatch[1] : `${nodeMatch[1]} is gone, run limit-bar install again`);
  } else {
    row(null, 'Claude Code is not using limit-bar yet', cmd ? `current: ${cmd}` : 'run limit-bar install');
  }
  const files = userConfigFiles();
  row(null, 'Config files', files.length ? files.join(', ') : 'none, defaults apply');
  const { issues } = validateAll();
  const errors = issues.filter((i) => i.level !== 'warning');
  row(errors.length === 0, 'Config is valid', errors.length ? `${errors.length} error(s), run limit-bar validate` : issues.length ? `${issues.length} warning(s)` : '');
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  row(git.status === 0 ? true : null, 'git', git.status === 0 ? git.stdout.trim() : 'not found, git modules will hide');
  row(null, 'Colour depth', `${detectDepth(process.env)} detected`);
  const probe = path.join(cacheDir(), 'doctor-probe');
  const writable = writeAtomic(probe, 'x');
  try { fs.unlinkSync(probe); } catch { /* fine */ }
  row(writable, 'Cache directory is writable', cacheDir());
  const lastFile = path.join(cacheDir(), 'last.json');
  try {
    const age = (Date.now() - fs.statSync(lastFile).mtimeMs) / 1000;
    row(true, 'Last update from Claude Code', `${Math.round(age)}s ago`);
    const last = readJson(lastFile);
    const cwd = last?.workspace?.project_dir ?? last?.cwd;
    const project = cwd ? projectConfigFile(cwd) : null;
    if (project) row(projectTrustState(project) === 'trusted' ? true : null, `Project config ${project}`, projectTrustState(project));
  } catch {
    row(null, 'No update from Claude Code seen yet');
  }
  const f = fixture('working', THEME_NOW());
  const started = process.hrtime.bigint();
  const r = renderBar(f.input, { overrides: f.overrides, offline: true, projectDir: null });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  row(r.problems.length === 0, 'Sample render', r.problems[0] ?? `${ms.toFixed(1)} ms in process`);
  return bad ? 1 : 0;
}

function cmdBench(flags) {
  const runs = Number(flags.runs) || 200;
  const f = fixture('working', THEME_NOW());
  const started = process.hrtime.bigint();
  for (let i = 0; i < runs; i++) renderBar(f.input, { overrides: f.overrides, offline: true, projectDir: null, cols: 120 });
  say(`In-process render, ${runs} runs: ${(Number(process.hrtime.bigint() - started) / 1e6 / runs).toFixed(2)} ms each`);
  const bin = path.join(ROOT, 'bin', 'limit-bar.js');
  const payload = JSON.stringify(fixture('working', THEME_NOW()).input);
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const started = process.hrtime.bigint();
    spawnSync(process.execPath, [bin], { input: payload, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, LIMITBAR_NO_CAPTURE: '1' } });
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  say(`Whole process, as Claude Code runs it: median ${samples[10].toFixed(0)} ms, worst ${samples[19].toFixed(0)} ms (Node startup included)`);
  return 0;
}

export async function runCli(argv) {
  const { flags, rest } = parseArgs(argv);
  const cmd = rest.shift();
  if (flags.version || cmd === 'version') { say(VERSION); return 0; }
  switch (cmd) {
    case undefined: case 'help': say(HELP); return 0;
    case 'install': return cmdInstall(flags);
    case 'uninstall': return cmdUninstall(flags);
    case 'init': return cmdInit(flags);
    case 'customize': case 'customise': return runEditor({ say });
    case 'modules': return cmdModules(rest);
    case 'rows': return cmdRows();
    case 'show': return cmdShow(rest, flags);
    case 'hide': return cmdHide(rest);
    case 'move': return cmdMove(rest, flags);
    case 'set': return cmdSet(rest);
    case 'color': case 'colour': return cmdColor(rest);
    case 'reset': return cmdReset();
    case 'preview': return cmdPreview(flags);
    case 'validate': return cmdValidate(rest);
    case 'explain': return cmdExplain(flags);
    case 'fields': return cmdFields(flags, rest);
    case 'trust': return cmdTrust(false);
    case 'untrust': return cmdTrust(true);
    case 'doctor': return cmdDoctor();
    case 'bench': return cmdBench(flags);
    default:
      say(`Unknown command "${cmd}".\n\n${HELP}`);
      return 1;
  }
}
