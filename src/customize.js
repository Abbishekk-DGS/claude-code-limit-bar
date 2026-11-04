// The saved customisations and the interactive editor. Everything lands in one
// machine-written file, custom.toml, so config.toml and its comments stay yours.
import fs from 'node:fs';
import path from 'node:path';
import { assemble, customFile, loadLayers } from './config.js';
import { parseToml } from './toml.js';
import { writeAtomic } from './fsutil.js';
import { renderBar } from './render.js';
import { fixture, FIXTURE_NAMES } from './fixtures.js';
import { parseColor } from './color.js';

export const SPLIT = '>';
export const MAX_ROWS = 8;

const HEADER = '# Written by the show, hide, move, set, color and customize commands.\n# Comments here are not kept. Hand edits belong in config.toml, unless you want to\n# change these values directly. Delete this file, or run reset, to start over.\n';

export function readCustom(env = process.env) {
  try { return parseToml(fs.readFileSync(customFile(env), 'utf8')); } catch { return {}; }
}

const tomlValue = (v) => (typeof v === 'string' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(tomlValue).join(', ')}]` : String(v));

export function serializeCustom(custom) {
  const parts = [HEADER];
  for (const table of ['settings', 'palette']) {
    const entries = Object.entries(custom[table] ?? {});
    if (entries.length) parts.push(`[${table}]\n${entries.map(([k, v]) => `${k} = ${tomlValue(v)}`).join('\n')}\n`);
  }
  if (custom.layout?.rows) parts.push(`[layout]\nrows = [\n${custom.layout.rows.map((r) => `  ${tomlValue(r)},`).join('\n')}\n]\n`);
  return parts.join('\n');
}

export function writeCustom(custom, env = process.env) {
  const file = customFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return writeAtomic(file, serializeCustom(custom), 0o644);
}

export function currentConfig(env = process.env) {
  return assemble(loadLayers({ env, projectDir: null }), env);
}

export const currentRows = (env = process.env) => (currentConfig(env).layout?.rows ?? []).map((r) => [...r]);

// Every module on offer, in file order. Yours appear too. Dollar modules do not.
export function catalog(cfg) {
  return Object.entries(cfg.module ?? {})
    .filter(([, def]) => def?.group !== 'hidden')
    .map(([name, def]) => ({ name, group: def.group ?? 'yours', about: def.about ?? '' }));
}

export function rowOf(rows, name) {
  return rows.findIndex((r) => r.includes(name));
}

export const trimRows = (rows) => {
  const out = rows.map((r) => [...r]);
  while (out.length > 1 && !out[out.length - 1].some((n) => n !== SPLIT)) out.pop();
  return out;
};

export function removeFrom(rows, name) {
  return rows.map((r) => r.filter((n) => n !== name));
}

// Adds to a row before its right-hand section, or at an exact spot next to another.
export function addTo(rows, name, { row, before, after } = {}) {
  const out = removeFrom(rows, name);
  const anchor = before ?? after;
  if (anchor !== undefined) {
    const r = rowOf(out, anchor);
    if (r < 0) return null;
    out[r].splice(out[r].indexOf(anchor) + (after !== undefined ? 1 : 0), 0, name);
    return trimRows(out);
  }
  const target = row ?? out.length - 1;
  if (target < 0 || target >= MAX_ROWS) return null;
  while (out.length <= target) out.push([]);
  const split = out[target].indexOf(SPLIT);
  if (split < 0) out[target].push(name); else out[target].splice(split, 0, name);
  return trimRows(out);
}

function shift(rows, name, delta) {
  const out = rows.map((r) => [...r]);
  const r = rowOf(out, name);
  if (r < 0) return rows;
  const i = out[r].indexOf(name);
  const j = i + delta;
  if (j < 0 || j >= out[r].length) return rows;
  [out[r][i], out[r][j]] = [out[r][j], out[r][i]];
  return out;
}

const CYCLES = {
  g: { key: 'bar', values: ['meter', 'thin', 'ticks', 'dots'], label: 'gauge' },
  w: { key: 'gauge_width', values: [6, 8, 10, 12, 14, 16], label: 'width' },
  u: { key: 'gauge_show', values: ['used', 'left'], label: 'shows' },
  c: { key: 'clock', values: ['24h', '12h'], label: 'clock' },
};

const nextOf = (values, v) => values[(values.indexOf(v) + 1) % values.length];

const ESC = '\x1b[';
const PINK = `${ESC}38;5;199m`;
const CYAN = `${ESC}38;5;38m`;
const LIME = `${ESC}38;5;34m`;
const DIM = `${ESC}2m`;
const OFF = `${ESC}0m`;

export function drawEditor(st, { cols, lines, env }) {
  const f = fixture(st.state);
  delete f.overrides.user; // your real username, since this stays on your screen
  const overlay = { layout: { rows: st.rows }, settings: st.settings };
  const preview = renderBar(f.input, { env, overlay, cols, overrides: f.overrides, offline: true, projectDir: null }).text;
  const previewRows = preview.split('\n');
  const head = [
    `${PINK}${ESC}1mCustomize the bar${OFF}  ${DIM}sample: ${st.state}${OFF}`,
    ...previewRows,
    '',
    `${DIM}↑↓ pick  space on/off  ←→ change row  [ ] reorder  > toggle right side split${OFF}`,
    `${DIM}${Object.entries(CYCLES).map(([k, c]) => `${k} ${c.label}:${st.settings[c.key] ?? c.values[0]}`).join('  ')}  tab sample${OFF}`,
    `${DIM}s save  r defaults  q quit${st.dirty ? `  ${OFF}${PINK}unsaved${OFF}` : ''}${OFF}`,
    '',
  ];
  const room = Math.max(3, lines - head.length - 1);
  const first = Math.max(0, Math.min(st.cursor - Math.floor(room / 2), st.items.length - room));
  const body = st.items.slice(first, first + room).map((item, k) => {
    const row = rowOf(st.rows, item.name);
    const mark = row >= 0 ? `${LIME}●${OFF} ${CYAN}row ${row + 1}${OFF}` : `${DIM}○ off  ${OFF}`;
    const text = `${item.name.padEnd(13)} ${DIM}${item.group.padEnd(9)} ${item.about}${OFF}`;
    const cut = text.length + 16 > cols + DIM.length * 2 ? `${text.slice(0, Math.max(0, cols - 16))}${OFF}` : text;
    return `${first + k === st.cursor ? `${PINK}▸${OFF}` : ' '} ${mark}  ${first + k === st.cursor ? `${ESC}1m${cut}${OFF}` : cut}`;
  });
  return [...head, ...body].join('\r\n');
}

export function applyKey(st, key, defaults) {
  const item = st.items[st.cursor];
  const mark = () => { st.dirty = true; };
  switch (key) {
    case 'up': st.cursor = (st.cursor - 1 + st.items.length) % st.items.length; break;
    case 'down': st.cursor = (st.cursor + 1) % st.items.length; break;
    case ' ':
      st.rows = rowOf(st.rows, item.name) >= 0 ? trimRows(removeFrom(st.rows, item.name)) : addTo(st.rows, item.name) ?? st.rows;
      mark();
      break;
    case 'left': case 'right': {
      const row = rowOf(st.rows, item.name);
      const target = row < 0 ? st.rows.length - 1 : row + (key === 'left' ? -1 : 1);
      if (target >= 0 && target < MAX_ROWS) { st.rows = addTo(st.rows, item.name, { row: target }) ?? st.rows; mark(); }
      break;
    }
    case '[': st.rows = shift(st.rows, item.name, -1); mark(); break;
    case ']': st.rows = shift(st.rows, item.name, 1); mark(); break;
    case '>': {
      const row = rowOf(st.rows, item.name);
      if (row < 0) break;
      const has = st.rows[row].includes(SPLIT);
      st.rows = st.rows.map((r, i) => {
        if (i !== row) return r;
        if (has) return r.filter((n) => n !== SPLIT);
        const at = r.indexOf(item.name);
        return [...r.slice(0, at), SPLIT, ...r.slice(at)];
      });
      mark();
      break;
    }
    case '\t': st.state = nextOf(FIXTURE_NAMES, st.state); break;
    case 'r': st.rows = defaults.rows.map((r) => [...r]); st.settings = { ...defaults.settings }; mark(); break;
    default:
      if (CYCLES[key]) {
        const c = CYCLES[key];
        st.settings = { ...st.settings, [c.key]: nextOf(c.values, st.settings[c.key]) };
        mark();
      }
  }
  return st;
}

const KEYS = { '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', k: 'up', j: 'down', h: 'left', l: 'right', '\r': ' ', '\n': ' ' };

export function runEditor({ say, env = process.env } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    say('customize needs a real terminal. Without one, use show, hide, move and set.');
    return Promise.resolve(1);
  }
  if (env.LIMITBAR_CONFIG) {
    say('LIMITBAR_CONFIG is set, which replaces the file customize saves to.');
    return Promise.resolve(1);
  }
  const cfg = currentConfig(env);
  const pristine = assemble({ ...loadLayers({ env, projectDir: null }), user: {} }, env);
  const st = {
    items: catalog(cfg),
    rows: (cfg.layout?.rows ?? []).map((r) => [...r]),
    settings: Object.fromEntries(Object.values(CYCLES).map((c) => [c.key, cfg.settings?.[c.key]])),
    cursor: 0,
    state: 'working',
    dirty: false,
  };
  const defaults = {
    rows: pristine.layout.rows,
    settings: Object.fromEntries(Object.values(CYCLES).map((c) => [c.key, pristine.settings?.[c.key]])),
  };
  const out = process.stdout;
  const draw = () => out.write(`${ESC}H${ESC}2J${drawEditor(st, { cols: out.columns || 100, lines: out.rows || 30, env })}`);
  return new Promise((resolve) => {
    const finish = (code, message) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      out.removeListener('resize', draw);
      out.write(`${ESC}?25h${ESC}?1049l`);
      if (message) say(message);
      resolve(code);
    };
    const onData = (buf) => {
      const raw = buf.toString('utf8');
      if (raw === '\x03' || raw === 'q' || raw === '\x1b') { finish(0, st.dirty ? 'Quit without saving.' : ''); return; }
      if (raw === 's') {
        const custom = readCustom(env);
        const settings = { ...custom.settings };
        for (const [k, v] of Object.entries(st.settings)) if (v !== undefined && v !== defaults.settings[k]) settings[k] = v; else delete settings[k];
        writeCustom({ ...custom, settings, layout: { rows: st.rows } }, env);
        finish(0, `Saved to ${customFile(env)}. The bar picks it up on its next refresh.`);
        return;
      }
      applyKey(st, KEYS[raw] ?? raw, defaults);
      draw();
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
    out.on('resize', draw);
    out.write(`${ESC}?1049h${ESC}?25l`);
    draw();
  });
}

export const isHex = (v) => /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(String(v)) && parseColor(v) !== null;
