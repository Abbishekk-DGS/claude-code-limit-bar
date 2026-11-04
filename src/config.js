// Config layers, lowest priority first:
//   built-in defaults < neon < conf.d + config.toml + custom.toml < trusted project file
// A project file is
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

export const THEME = 'neon';
const THEME_FILE = path.join(BUILTIN_THEMES, `${THEME}.toml`);
export const customFile = (env = process.env) => path.join(configDir(env), 'custom.toml');

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
  // Written by `show`, `hide`, `set`, `color` and `customize`, so it comes last.
  if (fs.existsSync(customFile(env))) files.push(customFile(env));
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

export function loadLayers({ env = process.env, projectDir } = {}) {
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
          errors.push(`project config ${e.message}`);
        }
      } else {
        notices.push(state === 'changed' ? 'project config changed and is ignored until trusted again' : 'project config found and ignored until trusted');
      }
    }
  }

  return { defaults, user, project, errors, notices, files };
}

export function assemble(layers, env = process.env) {
  let theme = {};
  try {
    theme = parseFile(THEME_FILE);
  } catch (e) {
    layers.errors.push(`${THEME}: ${e.message}`);
  }
  let cfg = merge(merge(merge(layers.defaults, theme), layers.user), layers.project);
  cfg.theme = THEME;
  if (env.LIMITBAR_COLOR) cfg = merge(cfg, { settings: { color: env.LIMITBAR_COLOR } });
  if (env.LIMITBAR_CHARSET) cfg = merge(cfg, { settings: { charset: env.LIMITBAR_CHARSET } });
  return cfg;
}
