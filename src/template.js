// Templates compile to a node tree and render to styled runs: {t: text, s: style}.
//   {path | filter:arg}      value with filters
//   {module}                 another module, by bare name
//   {if expr}..{elif e}..{else}..{end}
//   <style tokens>text</>    styled span, nestable
//   \{ \< \\                 literal characters

import { evaluate, compile, truthy, pathsOf } from './expr.js';
import { parseColor, gradientAt } from './color.js';
import { sanitize, truncateText, truncateLeft, textWidth } from './width.js';

export class TemplateError extends Error {
  constructor(message, source) {
    super(`${message} in template: ${source}`);
    this.name = 'TemplateError';
  }
}

const CACHE = new Map();
const BARE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TAG = /^<(\/|[#A-Za-z][^<>\n]*)>/;

// A dynamic style tag holds an expression, which may itself contain > and >=.
// Its closing > is the first one not followed by = and not preceded by a space.
function dynamicTagEnd(src, from) {
  let q = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '\n') return -1;
    else if (c === '>' && src[i + 1] !== '=' && !/\s/.test(src[i - 1])) return i;
  }
  return -1;
}

function splitOutside(str, sep) {
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q) {
      cur += c;
      if (c === '\\' && i + 1 < str.length) cur += str[++i];
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === sep) {
      if (sep === '|' && (str[i + 1] === '|' || str[i - 1] === '|')) { cur += c; continue; }
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseArg(raw) {
  const s = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return s.slice(1, -1);
  return s;
}

function closingBrace(src, from) {
  let q = null;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '}') return i;
  }
  return -1;
}

export function parseTemplate(src) {
  const cached = CACHE.get(src);
  if (cached) return cached;
  const root = [];
  const stack = [{ nodes: root, frame: null }];
  const top = () => stack[stack.length - 1].nodes;
  let text = '';
  const flush = () => { if (text) { top().push({ k: 'text', v: text }); text = ''; } };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) { text += src[i + 1]; i += 2; continue; }
    if (c === '<' && src[i + 1] === '=') {
      const end = dynamicTagEnd(src, i + 2);
      if (end > 0) {
        flush();
        compile(src.slice(i + 2, end));
        top().push({ k: 'open', style: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (c === '<') {
      const m = TAG.exec(src.slice(i, i + 200));
      if (m) {
        flush();
        top().push(m[1] === '/' ? { k: 'close' } : { k: 'open', style: m[1].trim() });
        i += m[0].length;
        continue;
      }
    }
    if (c === '{') {
      const end = closingBrace(src, i + 1);
      if (end < 0) throw new TemplateError('unclosed "{"', src);
      const body = src.slice(i + 1, end).trim();
      i = end + 1;
      flush();
      const kw = /^(if|elif)\s+([\s\S]+)$/.exec(body);
      if (kw && kw[1] === 'if') {
        compile(kw[2]);
        const node = { k: 'if', branches: [{ cond: kw[2], nodes: [] }], other: null };
        top().push(node);
        stack.push({ nodes: node.branches[0].nodes, frame: node });
      } else if (kw) {
        const fr = stack[stack.length - 1].frame;
        if (!fr) throw new TemplateError('{elif} without {if}', src);
        compile(kw[2]);
        const branch = { cond: kw[2], nodes: [] };
        fr.branches.push(branch);
        stack[stack.length - 1].nodes = branch.nodes;
      } else if (body === 'else') {
        const fr = stack[stack.length - 1].frame;
        if (!fr) throw new TemplateError('{else} without {if}', src);
        fr.other = [];
        stack[stack.length - 1].nodes = fr.other;
      } else if (body === 'end') {
        if (stack.length === 1) throw new TemplateError('{end} without {if}', src);
        stack.pop();
      } else {
        if (!body) throw new TemplateError('empty {}', src);
        const parts = splitOutside(body, '|').map((p) => p.trim());
        const expr = parts.shift();
        compile(expr);
        const filters = parts.map((p) => {
          const bits = splitOutside(p, ':');
          const name = bits.shift().trim();
          if (!Object.hasOwn(FILTERS, name)) throw new TemplateError(`unknown filter "${name}"`, src);
          return { name, args: bits.map(parseArg) };
        });
        top().push({ k: 'val', expr, filters, bare: BARE.test(expr) ? expr : null });
      }
      continue;
    }
    text += c;
    i++;
  }
  flush();
  if (stack.length !== 1) throw new TemplateError('{if} without {end}', src);
  CACHE.set(src, root);
  return root;
}

export function templateRefs(src) {
  const paths = [];
  const modules = [];
  const styles = [];
  const visit = (nodes) => {
    for (const n of nodes) {
      if (n.k === 'val') { paths.push(...pathsOf(n.expr)); if (n.bare) modules.push(n.bare); }
      if (n.k === 'open') styles.push(n.style);
      if (n.k === 'if') {
        for (const b of n.branches) { paths.push(...pathsOf(b.cond)); visit(b.nodes); }
        if (n.other) visit(n.other);
      }
    }
  };
  visit(parseTemplate(src));
  return { paths, modules, styles };
}

// ---- styles ---------------------------------------------------------------

const ATTRS = new Set(['bold', 'dim', 'italic', 'underline', 'strike', 'reverse', 'blink']);

export function resolveColor(token, rc, seen = 0) {
  if (seen > 8) return null;
  const pal = rc.cfg.palette || {};
  if (Object.hasOwn(pal, token)) return resolveColor(String(pal[token]), rc, seen + 1);
  return parseColor(token);
}

export function parseStyle(src, rc, depth = 0) {
  const out = {};
  if (src === null || src === undefined || src === '' || depth > 8) return out;
  let str = String(src).trim();
  if (str.startsWith('=')) {
    try { str = String(evaluate(str.slice(1), rc.scope, rc.env) ?? ''); } catch (e) { rc.note(e.message); return out; }
  }
  for (const token of str.split(/\s+/).filter(Boolean)) {
    if (ATTRS.has(token)) { out[token] = true; continue; }
    if (token === 'none') { Object.assign(out, { fg: null, bg: null }); continue; }
    if (token.startsWith('on:') || token.startsWith('bg:')) {
      const c = resolveColor(token.slice(3), rc);
      if (c) out.bg = c; else rc.badStyle(token);
      continue;
    }
    if (token.startsWith('fg:')) {
      const c = resolveColor(token.slice(3), rc);
      if (c) out.fg = c; else rc.badStyle(token);
      continue;
    }
    if (token.startsWith('grad:') || token.startsWith('beam:')) {
      const stops = token.slice(5).split(',').map((t) => resolveColor(t, rc)).filter(Boolean);
      if (stops.length) {
        const key = token.slice(0, 4);
        out[key] = stops;
        out.fg = null;
        if (key === 'beam') delete out.grad; else delete out.beam;
      } else rc.badStyle(token);
      continue;
    }
    const named = rc.cfg.style || {};
    if (Object.hasOwn(named, token)) { Object.assign(out, parseStyle(named[token], rc, depth + 1)); continue; }
    const c = resolveColor(token, rc);
    if (c) { out.fg = c; delete out.grad; delete out.beam; } else rc.badStyle(token);
  }
  return out;
}

// ---- filters --------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function formatDuration(sec, parts = 2, pad = false) {
  if (!isNum(sec)) return null;
  let s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const units = [['d', 86400], ['h', 3600], ['m', 60]];
  const out = [];
  for (const [u, size] of units) {
    if (s >= size) {
      const n = Math.floor(s / size);
      out.push(`${pad && out.length ? String(n).padStart(2, '0') : n}${u}`);
      s %= size;
    } else if (out.length) out.push(pad ? `00${u}` : `0${u}`);
    if (out.length >= parts) break;
  }
  return pad ? out.join('') : out.join('').replace(/(?<=[a-z])0[a-z]$/, '');
}

export function formatTokens(v) {
  if (!isNum(v)) return null;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.round(v));
}

export function formatMoney(v, places) {
  if (!isNum(v)) return null;
  const d = places ?? (Math.abs(v) >= 100 ? 0 : 2);
  return `$${v.toFixed(d)}`;
}

// A gauge with its percentage written inside, centred across fill and track.
// With colour each cell is a background; without it the cells fall back to glyphs.
function labelledCells({ bar, rc, pct, w, full, track, fill, emptyGlyph, emptyStyle, levelStyle }) {
  const label = `${Math.round(pct)}%`;
  const start = label.length <= w ? Math.floor((w - label.length) / 2) : -1;
  const onFill = bar.label_fill ? parseStyle(bar.label_fill, rc) : {};
  const onTrack = bar.label_track ? parseStyle(bar.label_track, rc) : {};
  const stops = bar.color === 'ramp' ? (bar.ramp || []).map((c) => resolveColor(c, rc)).filter(Boolean) : [];
  // Every other cell a shade darker, for a blocky, textured gauge.
  const shade = (color, i) => (color && bar.dither > 0 && i % 2 ? gradientAt([color, { rgb: [0, 0, 0] }], bar.dither) : color);
  const cells = [];
  for (let i = 0; i < w; i++) {
    const filled = i < full;
    const ch = start >= 0 && i >= start && i < start + label.length ? label[i - start] : null;
    if (track) {
      const base = filled ? (stops.length ? gradientAt(stops, w > 1 ? i / (w - 1) : 0) : levelStyle.fg) : emptyStyle.fg;
      const bg = shade(base, i);
      cells.push({ t: ch ?? ' ', s: { ...(bg ? { bg } : {}), ...(ch ? { ...(filled ? onFill : onTrack), bold: true } : {}) } });
    } else if (ch) {
      cells.push({ t: ch, s: { bold: true } });
    } else {
      cells.push({ t: filled ? fill : emptyGlyph, s: filled ? levelStyle : emptyStyle });
    }
  }
  return cells;
}

function barRuns(rawValue, rc, width, name) {
  const s = rc.cfg.settings ?? {};
  // Gauges read "remaining" instead of "used" with gauge_show = "left".
  const value = isNum(rawValue) && s.gauge_show === 'left' ? 100 - rawValue : rawValue;
  width ??= isNum(s.gauge_width) ? s.gauge_width : 10;
  const bars = rc.cfg.bars || {};
  let barName = name ?? rc.cfg.settings?.bar ?? 'block';
  if (rc.charset === 'ascii' && Object.hasOwn(bars, 'ascii')) barName = 'ascii';
  const bar = Object.hasOwn(bars, barName) ? bars[barName] : { fill: '#', empty: '-' };
  const w = Math.max(1, Math.min(200, Math.round(width)));
  const pct = isNum(value) ? Math.max(0, Math.min(100, value)) : 0;
  const exact = (pct / 100) * w;
  let full = Math.floor(exact);
  const partials = Array.isArray(bar.partial) ? bar.partial : null;
  let partialGlyph = '';
  if (partials && partials.length && full < w) {
    const idx = Math.floor((exact - full) * (partials.length + 1)) - 1;
    if (idx >= 0) partialGlyph = String(partials[idx]);
  } else if (!partials) {
    full = Math.round(exact);
  }
  const emptyCount = w - full - (partialGlyph ? 1 : 0);
  const mode = bar.color || 'level';
  const fill = String(bar.fill ?? '█');
  // A track bar draws its empty part as solid colour. Without colour that would
  // look full, so it falls back to a shaded glyph.
  const track = bar.track === true && rc.depth !== 'none';
  const emptyGlyph = bar.track === true && !track ? '░' : String(bar.empty ?? '░');
  const emptyStyle = bar.empty_style ? parseStyle(bar.empty_style, rc) : {};
  // The partial cell sits on the track colour, so fill and track meet with no gap.
  const onTrack = (glyph) => (track && glyph === partialGlyph && emptyStyle.fg ? { bg: emptyStyle.fg } : {});
  const runs = [];
  const levelStyle = () => parseStyle(rc.severityName(pct), rc);
  if (bar.left) runs.push({ t: String(bar.left), s: bar.cap_style ? parseStyle(bar.cap_style, rc) : {} });
  if (bar.label === true) {
    runs.push(...labelledCells({ bar, rc, pct, w, full: Math.round(exact), track, fill, emptyGlyph, emptyStyle, levelStyle: mode === 'none' ? {} : levelStyle() }));
  } else if (mode === 'ramp') {
    const stops = (bar.ramp || ['ok', 'warn', 'hot']).map((c) => resolveColor(c, rc)).filter(Boolean);
    const ramp = stops.length ? stops : null;
    for (let i = 0; i < full + (partialGlyph ? 1 : 0); i++) {
      const glyph = i < full ? fill : partialGlyph;
      runs.push({ t: glyph, s: { ...(ramp ? { fg: gradientAt(ramp, w > 1 ? i / (w - 1) : 0) } : {}), ...(i >= full ? onTrack(glyph) : {}) } });
    }
  } else {
    const s = mode === 'none' ? {} : levelStyle();
    if (full) runs.push({ t: fill.repeat(full), s });
    if (partialGlyph) runs.push({ t: partialGlyph, s: { ...s, ...onTrack(partialGlyph) } });
  }
  if (emptyCount > 0 && bar.label !== true) runs.push({ t: emptyGlyph.repeat(emptyCount), s: emptyStyle });
  if (bar.right) runs.push({ t: String(bar.right), s: bar.cap_style ? parseStyle(bar.cap_style, rc) : {} });
  return { runs };
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const SPARK_ASCII = ['_', '.', '-', "'"];

function sparkText(values, rc, width = 12, lo, hi) {
  if (!Array.isArray(values)) return null;
  const nums = values.filter(isNum).slice(-Math.max(1, width));
  if (nums.length < 2) return null;
  const min = isNum(lo) ? lo : Math.min(...nums);
  const max = isNum(hi) ? hi : Math.max(...nums);
  const glyphs = rc.charset === 'ascii' ? SPARK_ASCII : SPARK;
  const span = max - min;
  return nums.map((v) => {
    const t = span > 0 ? (Math.max(min, Math.min(max, v)) - min) / span : 0;
    return glyphs[Math.min(glyphs.length - 1, Math.floor(t * glyphs.length))];
  }).join('');
}

export const FILTERS = {
  round: (v, rc, d = 0) => (isNum(v) ? v.toFixed(d) : v),
  fixed: (v, rc, d = 2) => (isNum(v) ? v.toFixed(d) : v),
  money: (v, rc, d) => formatMoney(v, d),
  tokens: (v) => formatTokens(v),
  dur: (v, rc, parts = 2, pad) => formatDuration(v, parts, pad === 'pad'),
  clock: (v) => {
    if (!isNum(v)) return null;
    const s = Math.max(0, Math.round(v));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  },
  upper: (v) => (v === null ? v : String(v).toUpperCase()),
  lower: (v) => (v === null ? v : String(v).toLowerCase()),
  title: (v) => (v === null ? v : String(v).replace(/^\p{L}/u, (c) => c.toUpperCase())),
  pad: (v, rc, n = 0, ch = ' ') => { if (v === null) return v; const s = String(v); return s + String(ch).repeat(Math.max(0, n - textWidth(s))); },
  lpad: (v, rc, n = 0, ch = ' ') => { if (v === null) return v; const s = String(v); return String(ch).repeat(Math.max(0, n - textWidth(s))) + s; },
  trunc: (v, rc, n = 20) => (v === null ? v : truncateText(sanitize(v), n)),
  ltrunc: (v, rc, n = 20) => (v === null ? v : truncateLeft(sanitize(v), n)),
  basename: (v) => (v === null ? v : String(v).replace(/[/\\]+$/, '').split(/[/\\]/).pop()),
  default: (v, rc, d = '') => (v === null || v === '' ? d : v),
  replace: (v, rc, a = '', b = '') => (v === null ? v : String(v).split(String(a)).join(String(b))),
  bar: (v, rc, width, name) => barRuns(v, rc, width, name),
  spark: (v, rc, width, lo, hi) => sparkText(v, rc, width, lo, hi),
  frames: (v, rc, frames = '') => {
    const list = String(frames).split(/\s+/).filter(Boolean);
    if (!list.length || !isNum(v)) return null;
    return list[Math.abs(Math.floor(v)) % list.length];
  },
};

// ---- rendering ------------------------------------------------------------

function stringify(v) {
  if (v === null || v === undefined || v === false) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));
  if (Array.isArray(v) || typeof v === 'object') return '';
  return String(v);
}

function walk(nodes, rc, base, out, stack) {
  let current = base;
  const local = [];
  for (const n of nodes) {
    switch (n.k) {
      case 'text':
        out.push({ t: n.v, s: current });
        break;
      case 'open':
        local.push(current);
        current = { ...current, ...parseStyle(n.style, rc) };
        break;
      case 'close':
        if (local.length) current = local.pop();
        break;
      case 'if': {
        let chosen = n.other;
        for (const b of n.branches) {
          if (truthy(evaluate(b.cond, rc.scope, rc.env))) { chosen = b.nodes; break; }
        }
        if (chosen) walk(chosen, rc, current, out, stack);
        break;
      }
      case 'val': {
        // A module using its own name means the variable of that name, not itself.
        if (n.bare && !n.filters.length && !stack.has(n.bare) && Object.hasOwn(rc.cfg.module || {}, n.bare)) {
          const mod = rc.renderModule(n.bare, stack);
          for (const r of mod.runs) out.push(r);
          break;
        }
        let v = evaluate(n.expr, rc.scope, rc.env);
        for (const f of n.filters) v = FILTERS[f.name](v, rc, ...f.args);
        if (v && typeof v === 'object' && Array.isArray(v.runs)) {
          for (const r of v.runs) out.push({ t: sanitize(r.t), s: { ...current, ...r.s } });
        } else {
          const s = sanitize(stringify(v));
          if (s) out.push({ t: s, s: current });
        }
        break;
      }
      default:
    }
  }
}

export function renderTemplate(src, rc, base = {}, stack = new Set()) {
  const out = [];
  walk(parseTemplate(String(src)), rc, base, out, stack);
  return out;
}
