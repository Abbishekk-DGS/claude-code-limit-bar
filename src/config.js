// Config layers, lowest priority first:
//   built-in defaults < theme < conf.d + config.toml < trusted project .limit-bar.toml
// Themes are data only and cannot define [source] commands. A project file is
// ignored until `limit-bar trust` pins its hash, because cloning a repo must not be
// able to run commands or change your bar.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseToml } from './toml.js';
import { readJson, sha } from './fsutil.js';
import { configDir, stateDir } from './paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BUILTIN_THEMES = path.join(HERE, 'themes');
export const DEFAULTS_FILE = path.join(HERE, 'defaults.toml');
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export function merge(base, over) {
  if (over === null || typeof over !== 'object' || Array.isArray(over)) return over;
  const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
  for (const key of Object.keys(over)) {
    if (FORBIDDEN.has(key)) continue;
    if (key === 'when' && Array.isArray(over.when)) {
      out.when = [...(Array.isArray(out.when) ? out.when : []), ...over.when];
    } else {
      out[key] = merge(out[key], over[key]);
    }
  }
  return out;
}

function parseFile(file, lines) {
  const text = fs.readFileSync(file, 'utf8');
  return file.endsWith('.json') ? JSON.parse(text) : parseToml(text, { lines });
}

// Themes may not run anything, wherever they try to declare it.
export function stripExecutable(layer, removed = []) {
  if (!layer || typeof layer !== 'object') return layer;
  if (layer.source) { removed.push('source'); delete layer.source; }
  if (Array.isArray(layer.when)) for (const rule of layer.when) stripExecutable(rule, removed);
  return layer;
}

export function themeDirs(env = process.env) {
  return [path.join(configDir(env), 'themes'), BUILTIN_THEMES];
}

export function findTheme(name, env = process.env) {
  if (!/^[A-Za-z0-9_.-]+$/.test(String(name)) || String(name).startsWith('.')) return null;
  for (const dir of themeDirs(env)) {
    for (const ext of ['.toml', '.json']) {
      const f = path.join(dir, `${name}${ext}`);
      if (fs.existsSync(f)) return f;
    }
  }
  return null;
}

export function listThemes(env = process.env) {
  const seen = new Map();
  for (const dir of themeDirs(env)) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* no user themes yet */ }
    for (const n of names.sort()) {
      const m = /^(.+)\.(toml|json)$/.exec(n);
      if (m && !seen.has(m[1])) seen.set(m[1], { name: m[1], file: path.join(dir, n), builtin: dir === BUILTIN_THEMES });
    }
  }
  return [...seen.values()];
}

export function loadTheme(name, env = process.env, seen = new Set()) {
  if (seen.has(name)) throw new Error(`theme "${name}" extends itself`);
  seen.add(name);
  const file = findTheme(name, env);
  if (!file) throw new Error(`theme "${name}" not found`);
  const layer = stripExecutable(parseFile(file));
  if (layer.extends) {
    const parent = loadTheme(String(layer.extends), env, seen);
    delete layer.extends;
    return merge(parent, layer);
  }
  return layer;
}

export function userConfigFiles(env = process.env) {
  if (env.LIMITBAR_CONFIG) return [env.LIMITBAR_CONFIG];
  const files = [];
  const legacy = path.join(env.HOME || os.homedir(), '.limit-bar.toml');
  if (fs.existsSync(legacy)) files.push(legacy);
  const dir = configDir(env);
  try {
    const dropins = fs.readdirSync(path.join(dir, 'conf.d')).filter((f) => /\.(toml|json)$/.test(f)).sort();
    for (const f of dropins) files.push(path.join(dir, 'conf.d', f));
  } catch { /* optional */ }
  for (const f of [path.join(dir, 'config.toml'), path.join(dir, 'config.json')]) {
    if (fs.existsSync(f)) files.push(f);
  }
  return files;
}

// ---- project trust --------------------------------------------------------

const trustFile = (env) => path.join(stateDir(env), 'trust.json');
export const readTrust = (env = process.env) => readJson(trustFile(env)) ?? {};
export const trustPath = trustFile;

export function projectConfigFile(dir) {
  const f = path.join(dir, '.limit-bar.toml');
  return fs.existsSync(f) ? f : null;
}

export function projectTrustState(file, env = process.env) {
  const want = readTrust(env)[file];
  if (!want) return 'untrusted';
  return want === sha(fs.readFileSync(file, 'utf8')) ? 'trusted' : 'changed';
}

// ---- assembly -------------------------------------------------------------

export function loadLayers({ env = process.env, projectDir, themeOverride } = {}) {
  const errors = [];
  const notices = [];
  const files = [];
  let defaults = {};
  try { defaults = parseFile(DEFAULTS_FILE); } catch (e) { errors.push(`built-in defaults: ${e.message}`); }

  let user = {};
  for (const file of userConfigFiles(env)) {
    try {
      user = merge(user, parseFile(file));
      files.push(file);
    } catch (e) {
      errors.push(`${path.basename(file)} ${e.message}`);
    }
  }

  let project = {};
  if (projectDir && env.LIMITBAR_NO_PROJECT !== '1') {
    const file = projectConfigFile(projectDir);
    if (file) {
      const state = projectTrustState(file, env);
      if (state === 'trusted') {
        try {
          project = parseFile(file);
          files.push(file);
        } catch (e) {
          errors.push(`.limit-bar.toml ${e.message}`);
        }
      } else {
        notices.push(state === 'changed' ? '.limit-bar.toml changed: run limit-bar trust' : '.limit-bar.toml found: run limit-bar trust');
      }
    }
  }

  const themeName = themeOverride ?? env.LIMITBAR_THEME ?? project.theme ?? user.theme ?? defaults.theme ?? 'graphite';
  return { defaults, user, project, themeName, errors, notices, files };
}

export function assemble(layers, themeName, env = process.env) {
  let theme = {};
  try {
    theme = loadTheme(themeName, env);
  } catch (e) {
    layers.errors.push(e.message);
    if (themeName !== 'graphite') {
      try { theme = loadTheme('graphite', env); } catch { /* defaults still render */ }
    }
  }
  let cfg = merge(merge(merge(layers.defaults, theme), layers.user), layers.project);
  cfg.theme = themeName;
  if (env.LIMITBAR_COLOR) cfg = merge(cfg, { settings: { color: env.LIMITBAR_COLOR } });
  if (env.LIMITBAR_CHARSET) cfg = merge(cfg, { settings: { charset: env.LIMITBAR_CHARSET } });
  return cfg;
}
