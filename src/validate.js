// `limit-bar validate`: finds mistakes with file and line numbers before they reach
// the bar: unknown keys with suggestions, bad templates, expressions and styles,
// missing modules, and variables that do not exist.

import fs from 'node:fs';
import path from 'node:path';
import { parseToml } from './toml.js';
import { compile, pathsOf } from './expr.js';
import { parseTemplate, templateRefs, parseStyle } from './template.js';
import { assemble, loadLayers, findTheme, userConfigFiles, merge } from './config.js';
import { buildScope } from './data.js';
import { fixture } from './fixtures.js';

const TOP = ['theme', 'description', 'extends', 'settings', 'palette', 'style', 'glyphs', 'bars', 'var', 'source', 'module', 'line', 'append_line', 'when'];
const SETTINGS = ['charset', 'color', 'margin', 'warn', 'hot', 'bar', 'git_ttl', 'ctx_limit', 'links', 'notices', 'sep'];
const MODULE = ['if', 'format', 'compact', 'style', 'priority', 'link', 'disabled'];
const LINE = ['if', 'style', 'left', 'center', 'right', 'sep', 'sep_style', 'mode', 'prefix', 'suffix', 'fill', 'fill_style', 'full', 'keep', 'min_width', 'max_width'];
const RULE_ONLY = ['if', 'name', 'theme', 'stop'];
const BAR = ['fill', 'empty', 'track', 'partial', 'color', 'ramp', 'left', 'right', 'empty_style', 'cap_style', 'label', 'label_fill', 'label_track', 'dither'];
const SOURCE = ['command', 'file', 'env', 'every', 'timeout', 'parse', 'scope'];

function distance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

export function suggest(word, options) {
  let best = null;
  let bestD = Infinity;
  for (const o of options) {
    const d = distance(word, o);
    if (d < bestD) { bestD = d; best = o; }
  }
  return bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : null;
}

function flatten(obj, prefix, out, depth = 0) {
  for (const key of Object.keys(obj)) {
    const p = prefix ? `${prefix}.${key}` : key;
    out.add(p);
    const v = obj[key];
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 5) flatten(v, p, out, depth + 1);
  }
  return out;
}

// Every variable a template can read, derived from the real scope builder so the
// list can never drift away from the code.
export function knownPaths(cfg) {
  const f = fixture('danger', 1800000000);
  // Optional fields are switched on so that every variable is listed.
  const input = {
    ...f.input,
    vim: { mode: 'NORMAL' },
    agent: { name: 'a' },
    pr: { number: 1, url: 'https://x.y/z', review_state: 'pending', kind: 'pr' },
    worktree: { name: 'w', path: '/w', branch: 'b', original_branch: 'm' },
    rate_limits: { ...f.input.rate_limits, spend_limit: { used_percentage: 5, resets_at: 1800000000 + 86400, used_usd: 1, limit_usd: 2, period: 'monthly' } },
  };
  const rc = { cfg, cacheDir: null, offline: true, env: {}, note() {} };
  const scope = buildScope(input, rc, { env: { HOME: '/h' }, now: 1800000000, overrides: { ...f.overrides, source: {} }, home: '/h', cols: 120 });
  delete scope.raw;
  const paths = flatten(scope, '', new Set());
  paths.add('g');
  for (const name of Object.keys(cfg.glyphs ?? {})) paths.add(`g.${name}`);
  for (const name of Object.keys(cfg.source ?? {})) for (const f2 of ['value', 'data', 'ok', 'stale', 'age', 'error']) paths.add(`source.${name}.${f2}`);
  for (const name of Object.keys(cfg.var ?? {})) paths.add(`var.${name}`);
  return paths;
}

function checkKeys(obj, allowed, prefix, report) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      const hint = suggest(key, allowed);
      report(prefix ? `${prefix}.${key}` : key, `unknown key "${key}"${hint ? `, did you mean "${hint}"?` : ''}`);
    }
  }
}

export function validateLayer(layer, cfg, report) {
  checkKeys(layer, TOP, '', report);
  const known = knownPaths(cfg);
  const modules = Object.keys(cfg.module ?? {});
  const issueStyles = new Set();
  const rc = { cfg, scope: {}, env: {}, note() {}, badStyle: (t) => issueStyles.add(t) };

  const checkPaths = (paths, where) => {
    for (const p of paths) {
      if (known.has(p) || p.startsWith('env.') || p.startsWith('raw.') || /^source\.[^.]+\.data\./.test(p)) continue;
      const hint = suggest(p, [...known]);
      report(where, `unknown variable "${p}"${hint ? `, did you mean "${hint}"?` : ''}`, 'warning');
    }
  };
  const checkExpr = (src, where) => {
    try {
      compile(String(src));
      checkPaths(pathsOf(String(src)), where);
    } catch (e) {
      report(where, e.message);
    }
  };
  const checkStyle = (src, where) => {
    if (src === undefined) return;
    const str = String(src).trim();
    if (str.startsWith('=')) { checkExpr(str.slice(1), where); return; }
    issueStyles.clear();
    parseStyle(str, rc);
    for (const bad of issueStyles) {
      report(where, `unknown style or colour "${bad}"`);
    }
  };
  const checkTemplate = (src, where) => {
    if (src === undefined) return;
    try {
      parseTemplate(String(src));
      const refs = templateRefs(String(src));
      const unknownBare = refs.paths.filter((p) => !(modules.includes(p) && refs.modules.includes(p)));
      checkPaths(unknownBare, where);
      for (const s of refs.styles) checkStyle(s, where);
    } catch (e) {
      report(where, e.message);
    }
  };
  const checkLines = (lines, prefix) => {
    if (lines === undefined) return;
    if (!Array.isArray(lines)) { report(prefix, 'must be an array, written [[line]]'); return; }
    lines.forEach((line, i) => {
      const at = `${prefix}[${i}]`;
      checkKeys(line, LINE, at, report);
      if (line.if !== undefined) checkExpr(line.if, `${at}.if`);
      if (line.mode !== undefined && !['flat', 'powerline', 'capsule'].includes(line.mode)) report(`${at}.mode`, `mode must be flat, powerline or capsule, not "${line.mode}"`);
      for (const k of ['sep', 'prefix', 'suffix']) checkTemplate(line[k], `${at}.${k}`);
      for (const k of ['style', 'sep_style', 'fill_style']) checkStyle(line[k], `${at}.${k}`);
      for (const side of ['left', 'center', 'right']) {
        const v = line[side];
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const entry of v) {
            if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(String(entry))) {
              if (!modules.includes(String(entry))) {
                const hint = suggest(String(entry), modules);
                report(`${at}.${side}`, `unknown module "${entry}"${hint ? `, did you mean "${hint}"?` : ''}`);
              }
            } else checkTemplate(entry, `${at}.${side}`);
          }
        } else checkTemplate(v, `${at}.${side}`);
      }
    });
  };
  const checkModules = (mods, prefix) => {
    for (const [name, def] of Object.entries(mods ?? {})) {
      const at = `${prefix}.${name}`;
      checkKeys(def, MODULE, at, report);
      if (def.if !== undefined) checkExpr(def.if, `${at}.if`);
      for (const k of ['format', 'compact', 'link']) checkTemplate(def[k], `${at}.${k}`);
      checkStyle(def.style, `${at}.style`);
    }
  };
  const checkSections = (l, prefix) => {
    const at = (s) => (prefix ? `${prefix}.${s}` : s);
    checkKeys(l.settings, SETTINGS, at('settings'), report);
    for (const [name, def] of Object.entries(l.bars ?? {})) {
      checkKeys(def, BAR, at(`bars.${name}`), report);
      checkStyle(def.empty_style, at(`bars.${name}.empty_style`));
      checkStyle(def.cap_style, at(`bars.${name}.cap_style`));
      checkStyle(def.label_fill, at(`bars.${name}.label_fill`));
      checkStyle(def.label_track, at(`bars.${name}.label_track`));
    }
    for (const [name, def] of Object.entries(l.source ?? {})) {
      checkKeys(def, SOURCE, at(`source.${name}`), report);
      if (def.command === undefined && def.file === undefined && def.env === undefined) report(at(`source.${name}`), 'needs one of command, file or env');
    }
    for (const [name, expr] of Object.entries(l.var ?? {})) checkExpr(expr, at(`var.${name}`));
    for (const [name, value] of Object.entries(l.style ?? {})) checkStyle(value, at(`style.${name}`));
    checkModules(l.module, at('module'));
    checkLines(l.line, at('line'));
    checkLines(l.append_line, at('append_line'));
  };

  checkSections(layer, '');
  (layer.when ?? []).forEach((rule, i) => {
    const at = `when[${i}]`;
    checkKeys(rule, [...RULE_ONLY, ...TOP.filter((k) => !['when', 'theme', 'description', 'extends'].includes(k))], at, report);
    if (rule.if !== undefined) checkExpr(rule.if, `${at}.if`);
    if (rule.theme && !findTheme(String(rule.theme))) report(`${at}.theme`, `theme "${rule.theme}" not found`);
    checkSections(rule, at);
  });
}

export function validateFile(file, env = process.env) {
  const issues = [];
  const lines = new Map();
  let layer;
  try {
    const text = fs.readFileSync(file, 'utf8');
    layer = file.endsWith('.json') ? JSON.parse(text) : parseToml(text, { lines });
  } catch (e) {
    return [{ file, line: e.line ?? null, path: '', message: e.message.replace(/^line \d+: /, ''), level: 'error' }];
  }
  const base = loadLayers({ env, projectDir: null });
  const themeName = layer.theme ?? base.themeName;
  if (layer.theme && !findTheme(String(layer.theme), env)) {
    issues.push({ file, line: lines.get('theme') ?? null, path: 'theme', message: `theme "${layer.theme}" not found`, level: 'error' });
  }
  let cfg;
  try {
    cfg = merge(assemble(base, findTheme(themeName, env) ? themeName : 'graphite', env), layer);
  } catch (e) {
    return [...issues, { file, line: null, path: '', message: e.message, level: 'error' }];
  }
  const lineOf = (p) => {
    let cur = p.replace(/\[\d+\]/g, '');
    while (cur) {
      if (lines.has(cur)) return lines.get(cur);
      cur = cur.includes('.') ? cur.slice(0, cur.lastIndexOf('.')) : '';
    }
    return null;
  };
  validateLayer(layer, cfg, (p, message, level = 'error') => issues.push({ file, line: lineOf(p), path: p, message, level }));
  return issues;
}

export function validateAll(env = process.env, extra = []) {
  const files = [...userConfigFiles(env), ...extra];
  return { files, issues: files.flatMap((f) => validateFile(f, env)) };
}

export const formatIssue = (i) => `${path.basename(i.file)}${i.line ? `:${i.line}` : ''}  ${i.level === 'warning' ? 'warning' : 'error'}  ${i.path ? `${i.path}: ` : ''}${i.message}`;
