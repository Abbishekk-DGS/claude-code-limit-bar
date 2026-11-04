// Every subcommand except rendering lives here, so the render path stays small.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderBar } from './render.js';
import { FIXTURE_NAMES, fixture } from './fixtures.js';
import { listThemes, findTheme, projectConfigFile, projectTrustState, readTrust, trustPath, userConfigFiles, loadLayers } from './config.js';
import { validateAll, validateFile, formatIssue } from './validate.js';
import { readJson, sha, writeAtomic } from './fsutil.js';
import { cacheDir, claudeDir, configDir, dataDir, stateDir } from './paths.js';
import { parseToml } from './toml.js';
import { detectDepth } from './color.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const say = (s = '') => process.stdout.write(`${s}\n`);
const THEME_NOW = () => Date.now() / 1000;

const HELP = `limit-bar ${VERSION}: a Claude Code status line built from a dotfile

  limit-bar install [--theme NAME] [--refresh SECONDS] [--link] [--dry-run] [--settings FILE]
  limit-bar uninstall [--purge] [--settings FILE]

  limit-bar themes                     list themes with live previews
  limit-bar use NAME                   switch theme, keeping your config comments
  limit-bar preview [NAME|all] [--state fresh|working|danger|all] [--cols N]
                 [--charset nerd|unicode|ascii] [--color truecolor|256|16|none]
  limit-bar theme new NAME [--from BASE]    copy a theme into your config to edit

  limit-bar init [--force]             write a commented starter config
  limit-bar validate [FILE]            check config with file and line numbers
  limit-bar explain [--state NAME]     show which files, rules and modules applied
  limit-bar fields [FILTER] [--json]   list every variable with its current value
  limit-bar trust | untrust            allow or revoke this project's .limit-bar.toml
  limit-bar doctor                     check the whole setup
  limit-bar bench                      measure render time

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

function themeDescription(file) {
  try {
    return parseToml(fs.readFileSync(file, 'utf8')).description ?? '';
  } catch {
    return '';
  }
}

function previewEnv(flags) {
  const env = { ...process.env };
  if (flags.charset) env.LIMITBAR_CHARSET = String(flags.charset);
  if (flags.color) env.LIMITBAR_COLOR = String(flags.color);
  return env;
}

function renderFixture(theme, state, flags, env) {
  const now = THEME_NOW();
  const f = fixture(state, now);
  const cols = Number(flags.cols) || process.stdout.columns || 120;
  return renderBar(f.input, { env, theme, cols, now, overrides: f.overrides, projectDir: null, offline: true });
}

function cmdPreview(flags, rest) {
  const env = previewEnv(flags);
  const name = rest[0] ?? 'all';
  const themes = name === 'all' ? listThemes(env).map((t) => t.name) : [name];
  const states = !flags.state || flags.state === 'all' ? FIXTURE_NAMES : [String(flags.state)];
  for (const s of states) if (!FIXTURE_NAMES.includes(s)) { say(`Unknown state "${s}". Use ${FIXTURE_NAMES.join(', ')} or all.`); return 1; }
  for (const theme of themes) {
    if (!findTheme(theme, env)) { say(`Theme "${theme}" not found. Run limit-bar themes.`); return 1; }
    for (const state of states) {
      say(`\x1b[2m${theme} / ${state}\x1b[0m`);
      say(renderFixture(theme, state, flags, env).text);
      say();
    }
  }
  return 0;
}

function cmdThemes(flags) {
  const env = previewEnv(flags);
  const current = loadLayers({ env }).themeName;
  for (const t of listThemes(env)) {
    say(`${t.name === current ? '● ' : '  '}\x1b[1m${t.name}\x1b[0m${t.builtin ? '' : ' \x1b[2m(yours)\x1b[0m'}  \x1b[2m${themeDescription(t.file)}\x1b[0m`);
    say(renderFixture(t.name, 'working', flags, env).text);
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

export function setThemeInText(text, name) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) break;
    if (/^\s*theme\s*=/.test(lines[i])) {
      const comment = /(\s+#.*)$/.exec(lines[i])?.[1] ?? '';
      lines[i] = `theme = "${name}"${comment}`;
      return lines.join('\n');
    }
  }
  return `theme = "${name}"\n${text}`;
}

function cmdUse(rest) {
  const name = rest[0];
  if (!name) { say('Usage: limit-bar use NAME'); return 1; }
  if (!findTheme(name)) { say(`Theme "${name}" not found. Run limit-bar themes.`); return 1; }
  const file = mainConfigPath();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* created below */ }
  if (!text) text = fs.readFileSync(path.join(ROOT, 'examples', 'starter.toml'), 'utf8');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, setThemeInText(text, name), 0o644);
  say(`Theme set to ${name}`);
  return 0;
}

function cmdThemeNew(rest, flags) {
  const name = rest[1];
  if (rest[0] !== 'new' || !name) { say('Usage: limit-bar theme new NAME [--from BASE]'); return 1; }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) { say('Theme names can use letters, digits, - and _.'); return 1; }
  const from = String(flags.from ?? 'graphite');
  const src = findTheme(from);
  if (!src) { say(`Theme "${from}" not found.`); return 1; }
  const dest = path.join(configDir(), 'themes', `${name}.toml`);
  if (fs.existsSync(dest)) { say(`${dest} already exists.`); return 1; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  say(`Wrote ${dest}\nActivate it with: limit-bar use ${name}`);
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
  say(`Theme      ${r.layers.themeName}${r.rc.trace.theme !== r.layers.themeName ? ` -> ${r.rc.trace.theme} (changed by a rule)` : ''}`);
  say(`Render     ${ms.toFixed(1)} ms`);
  say('\nConfig files, lowest priority first');
  say('  built-in defaults');
  say(`  theme: ${r.layers.themeName}`);
  for (const f of r.layers.files) say(`  ${f}`);
  say('\nRules');
  if (!r.rc.trace.rules.length) say('  none');
  for (const rule of r.rc.trace.rules) {
    say(`  ${rule.matched ? 'matched ' : 'skipped '} ${rule.name ? `${rule.name}: ` : ''}${rule.if}${rule.matched && rule.theme ? `  -> theme ${rule.theme}` : ''}`);
  }
  say('\nModules');
  const mods = Object.entries(r.rc.trace.modules);
  say(`  shown:  ${mods.filter(([, v]) => v === 'shown').map(([k]) => k).join(', ') || 'none'}`);
  say(`  hidden: ${mods.filter(([, v]) => v === 'hidden').map(([k]) => k).join(', ') || 'none'}`);
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
  const r = renderBar(p.input, { overrides: p.overrides, offline: true });
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
  if (flags.theme && !findTheme(String(flags.theme))) { say(`Theme "${flags.theme}" not found.`); return 1; }

  const appDir = flags.link ? ROOT : path.join(dataDir(), 'app');
  const bin = path.join(appDir, 'bin', 'limit-bar.js');
  const statusLine = { type: 'command', command: `${quote(stableNodePath())} ${quote(bin)}`, padding: 0, refreshInterval: refresh };

  if (flags['dry-run']) {
    say(`Would write to ${file}:\n${JSON.stringify({ statusLine }, null, 2)}`);
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
  if (flags.theme) cmdUse([String(flags.theme)]);
  say(`Installed. ${file} now runs limit-bar, refreshing every ${refresh}s.`);
  say(`Your old file is saved as ${path.basename(file)}.limit-bar.bak`);
  say(linked ? 'Try: limit-bar themes' : `Try: node ${quote(bin)} themes`);
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
  const results = [];
  const themes = listThemes().map((t) => t.name);
  for (const theme of themes) {
    const f = fixture('working', THEME_NOW());
    const started = process.hrtime.bigint();
    for (let i = 0; i < runs; i++) renderBar(f.input, { theme, overrides: f.overrides, offline: true, projectDir: null, cols: 120 });
    results.push([theme, Number(process.hrtime.bigint() - started) / 1e6 / runs]);
  }
  say(`In-process render, ${runs} runs each`);
  for (const [t, ms] of results) say(`  ${t.padEnd(14)} ${ms.toFixed(2)} ms`);
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
    case 'use': return cmdUse(rest);
    case 'theme': return cmdThemeNew(rest, flags);
    case 'themes': return cmdThemes(flags);
    case 'preview': return cmdPreview(flags, rest);
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
