// Turns config plus session data into terminal output.
//   1. assemble config layers    2. apply [[when]] rules    3. render modules
//   4. fit each line to the terminal width    5. emit ANSI

import { buildScope, glyphScope } from './data.js';
import { evaluate, truthy } from './expr.js';
import { parseStyle, renderTemplate } from './template.js';
import { assemble, loadLayers, merge } from './config.js';
import { colorCode, detectDepth, gradientAt } from './color.js';
import { cellWidth, runsWidth, textWidth, truncateRuns } from './width.js';
import { cacheDir } from './paths.js';

const RULE_META = new Set(['if', 'stop', 'name']);
const SAFE_LINK = /^(https?|file):\/\/[^\s]+$/i;
const CHARSETS = new Set(['nerd', 'unicode', 'ascii']);

function makeContext(cfg, opts) {
  const rc = {
    cfg,
    env: { warn: 60, hot: 85, now: 0 },
    charset: 'unicode',
    cacheDir: opts.cacheDir ?? cacheDir(opts.env ?? process.env),
    offline: Boolean(opts.offline),
    notes: [],
    badStyles: new Set(),
    trace: { rules: [], modules: {} },
    memo: new Map(),
    note(msg) { if (!rc.notes.includes(msg)) rc.notes.push(msg); },
    badStyle(token) { rc.badStyles.add(token); },
    severityName(v) { return v >= rc.env.hot ? 'hot' : v >= rc.env.warn ? 'warn' : 'ok'; },
    setConfig(next) {
      rc.cfg = next;
      const s = next.settings ?? {};
      rc.env.warn = typeof s.warn === 'number' ? s.warn : 60;
      rc.env.hot = typeof s.hot === 'number' ? s.hot : 85;
      rc.charset = CHARSETS.has(s.charset) ? s.charset : 'unicode';
      rc.depth = detectDepth(opts.env ?? process.env, s.color);
      rc.memo.clear();
    },
    renderModule(name, stack = new Set(), compact = false) {
      const key = `${name}|${compact}`;
      if (rc.memo.has(key)) return rc.memo.get(key);
      const empty = { runs: [], priority: 50, style: {}, empty: true };
      const def = rc.cfg.module?.[name];
      if (def?.disabled === true) rc.trace.modules[name] = 'off';
      if (!def || stack.has(name) || def.disabled === true) return empty;
      stack.add(name);
      let out = empty;
      try {
        if (def.if === undefined || truthy(evaluate(String(def.if), rc.scope, rc.env))) {
          const style = parseStyle(def.style, rc);
          const fmt = compact && def.compact !== undefined ? def.compact : def.format;
          let runs = fmt === undefined ? [] : renderTemplate(fmt, rc, style, stack);
          if (def.link !== undefined && rc.cfg.settings?.links !== false) {
            const url = renderTemplate(def.link, rc, {}, stack).map((r) => r.t).join('');
            if (SAFE_LINK.test(url)) runs = runs.map((r) => ({ t: r.t, s: { ...r.s, link: url } }));
          }
          const blank = runs.every((r) => !r.t.trim());
          out = { runs: blank ? [] : runs, priority: typeof def.priority === 'number' ? def.priority : 50, style, empty: blank };
        }
      } catch (e) {
        rc.note(`module ${name}: ${e.message}`);
      }
      stack.delete(name);
      rc.memo.set(key, out);
      rc.trace.modules[name] = out.empty ? 'hidden' : 'shown';
      return out;
    },
  };
  return rc;
}

function applyRules(rc) {
  const rules = Array.isArray(rc.cfg.when) ? rc.cfg.when : [];
  const cfg = rc.cfg;
  let overlay = {};
  for (const rule of rules) {
    let hit = false;
    try {
      hit = rule.if === undefined ? true : truthy(evaluate(String(rule.if), rc.scope, rc.env));
    } catch (e) {
      rc.note(`rule "${rule.name ?? rule.if}": ${e.message}`);
    }
    rc.trace.rules.push({ name: rule.name ?? null, if: rule.if ?? '(always)', matched: hit });
    if (!hit) continue;
    const delta = {};
    for (const key of Object.keys(rule)) if (!RULE_META.has(key)) delta[key] = rule[key];
    overlay = merge(overlay, delta);
    rc.setConfig(merge(cfg, overlay));
    rc.scope.g = glyphScope(rc.cfg, rc.charset);
    rc.rebindConfigValues();
    if (rule.stop === true) break;
  }
}

// ---- layout ---------------------------------------------------------------

const MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function resolveItems(side, rc) {
  if (side === undefined || side === null) return [];
  const list = Array.isArray(side) ? side : [side];
  const items = [];
  for (const entry of list) {
    const text = String(entry);
    if (MODULE_NAME.test(text) && Object.hasOwn(rc.cfg.module ?? {}, text)) items.push({ module: text });
    else if (MODULE_NAME.test(text) && Array.isArray(side)) rc.note(`unknown module "${text}"`);
    else items.push({ template: text });
  }
  return items;
}

function renderItem(item, rc, compact) {
  if (item.module) {
    const m = rc.renderModule(item.module, new Set(), compact);
    return { runs: m.runs, style: m.style, priority: m.priority, empty: m.empty };
  }
  try {
    const runs = renderTemplate(item.template, rc, {});
    return { runs, style: {}, priority: 50, empty: runs.every((r) => !r.t.trim()) };
  } catch (e) {
    rc.note(e.message);
    return { runs: [], style: {}, priority: 50, empty: true };
  }
}

function joinFlat(items, line, rc) {
  const out = [];
  const sepTpl = line.sep ?? rc.cfg.settings?.sep ?? '  ';
  const sepStyle = parseStyle(line.sep_style, rc);
  const sep = sepTpl === '' ? [] : renderTemplate(sepTpl, rc, sepStyle);
  items.forEach((item, i) => {
    if (i) out.push(...sep);
    out.push(...item.runs);
  });
  return out;
}

const sameBg = (a, b) => JSON.stringify(a.style.bg ?? null) === JSON.stringify(b.style.bg ?? null);

function joinPowerline(items, rc, rightSide) {
  const g = rc.scope.g;
  const arrow = rightSide ? (g.pl_left ?? '') : (g.pl_right ?? '');
  const thin = rightSide ? (g.pl_thin_left ?? '') : (g.pl_thin_right ?? '');
  const out = [];
  const pad = (item) => [{ t: ' ', s: item.style }, ...item.runs, { t: ' ', s: item.style }];
  // Neighbours of the same colour would merge, so they get a thin divider instead.
  items.forEach((item, i) => {
    if (rightSide) {
      const prev = items[i - 1];
      if (prev && sameBg(prev, item)) {
        if (thin) out.push({ t: thin, s: { fg: item.style.fg, bg: item.style.bg } });
      } else if (arrow) {
        out.push({ t: arrow, s: { fg: item.style.bg, ...(prev?.style.bg ? { bg: prev.style.bg } : {}) } });
      }
      out.push(...pad(item));
      return;
    }
    out.push(...pad(item));
    const next = items[i + 1];
    if (next && sameBg(next, item)) {
      if (thin) out.push({ t: thin, s: { fg: item.style.fg, bg: item.style.bg } });
    } else if (arrow) {
      out.push({ t: arrow, s: { fg: item.style.bg, ...(next?.style.bg ? { bg: next.style.bg } : {}) } });
    }
  });
  return out;
}

function joinCapsule(items, line, rc) {
  const g = rc.scope.g;
  const gap = renderTemplate(line.sep ?? ' ', rc, {});
  const out = [];
  items.forEach((item, i) => {
    if (i) out.push(...gap);
    out.push({ t: g.cap_left ?? '', s: { fg: item.style.bg } });
    out.push({ t: ' ', s: item.style }, ...item.runs, { t: ' ', s: item.style });
    out.push({ t: g.cap_right ?? '', s: { fg: item.style.bg } });
  });
  return out;
}

function joinItems(items, line, rc, rightSide) {
  if (!items.length) return [];
  const mode = line.mode ?? 'flat';
  if (mode === 'powerline') return joinPowerline(items, rc, rightSide);
  if (mode === 'capsule') return joinCapsule(items, line, rc);
  return joinFlat(items, line, rc);
}

function renderLine(line, rc, width) {
  if (line.if !== undefined) {
    try {
      if (!truthy(evaluate(String(line.if), rc.scope, rc.env))) return null;
    } catch (e) {
      rc.note(e.message);
      return null;
    }
  }
  if (typeof line.min_width === 'number' && rc.scope.term.cols < line.min_width) return null;
  if (typeof line.max_width === 'number' && rc.scope.term.cols > line.max_width) return null;

  const sides = { left: resolveItems(line.left, rc), center: resolveItems(line.center, rc), right: resolveItems(line.right, rc) };
  const prefix = line.prefix !== undefined ? renderTemplate(line.prefix, rc) : [];
  const suffix = line.suffix !== undefined ? renderTemplate(line.suffix, rc) : [];
  const dropped = new Set();
  const compacted = new Set();

  const build = () => {
    const out = {};
    for (const name of ['left', 'center', 'right']) {
      const rendered = sides[name]
        .map((item, index) => {
          const key = `${name}:${index}`;
          return { ...renderItem(item, rc, compacted.has(key)), key, index, side: name };
        })
        .filter((r) => !r.empty && !dropped.has(r.key));
      out[name] = { items: rendered, runs: joinItems(rendered, line, rc, name === 'right') };
    }
    return out;
  };

  const frame = runsWidth(prefix) + runsWidth(suffix);
  const need = (b) => {
    const widths = [runsWidth(b.left.runs), runsWidth(b.center.runs), runsWidth(b.right.runs)];
    const used = widths.filter(Boolean).length;
    return widths[0] + widths[1] + widths[2] + frame + Math.max(0, used - 1);
  };
  const itemsOf = (b) => [...b.left.items, ...b.center.items, ...b.right.items];
  // Least important first; among equals, the one furthest along the line.
  const leastImportant = (items) => items.reduce((best, it) => (it.priority <= best.priority ? it : best));

  // Degrade one step at a time, keeping as much as fits: shorten modules to their
  // compact format, then drop modules, and only as a last resort cut text.
  let built = build();
  while (need(built) > width) {
    const items = itemsOf(built).filter((it) => !compacted.has(it.key));
    if (!items.length) break;
    compacted.add(leastImportant(items).key);
    built = build();
  }
  while (need(built) > width) {
    const items = itemsOf(built);
    if (items.length <= 1) break;
    dropped.add(leastImportant(items).key);
    built = build();
  }

  for (const name of ['left', 'center', 'right']) {
    sides[name].forEach((item, index) => {
      if (item.module && dropped.has(`${name}:${index}`)) rc.trace.modules[item.module] = 'dropped';
    });
  }

  const anyContent = built.left.runs.length || built.center.runs.length || built.right.runs.length;
  if (!anyContent && !line.keep) return null;

  const fillGlyph = String(line.fill ?? ' ');
  const fillStyle = parseStyle(line.fill_style, rc);
  // A drawn fill such as a border gets a one-cell gap so text never touches it.
  const drawn = fillGlyph !== ' ';
  const fill = (n, before, after) => {
    if (n <= 0) return [];
    const padL = drawn && before && n > 0 ? 1 : 0;
    const padR = drawn && after && n > padL ? 1 : 0;
    const body = n - padL - padR;
    return [...(padL ? [{ t: ' ', s: {} }] : []), ...(body > 0 ? [{ t: fillGlyph.repeat(body), s: fillStyle }] : []), ...(padR ? [{ t: ' ', s: {} }] : [])];
  };
  const leftW = runsWidth(built.left.runs);
  const centerW = runsWidth(built.center.runs);
  const rightW = runsWidth(built.right.runs);
  const expand = line.full === true || centerW > 0 || rightW > 0;

  // With nothing beside a drawn border, its padding space would leave a hole.
  const trimEdge = (edge, atEnd) => {
    if (!edge.length) return edge;
    const i = atEnd ? edge.length - 1 : 0;
    const t = edge[i].t;
    const cut = atEnd ? t.replace(/ +$/, '') : t.replace(/^ +/, '');
    return cut === t ? edge : edge.map((r, j) => (j === i ? { ...r, t: cut } : r));
  };
  let frameLeft = prefix;
  let frameRight = suffix;
  if (drawn && expand) {
    if (!leftW) frameLeft = trimEdge(prefix, true);
    if (!rightW && !centerW) frameRight = trimEdge(suffix, false);
  }
  const widthTrim = frame - runsWidth(frameLeft) - runsWidth(frameRight);

  let runs;
  if (expand) {
    const inner = Math.max(0, width - frame + widthTrim);
    const free = Math.max(0, inner - leftW - centerW - rightW);
    let gapA = free;
    let gapB = 0;
    if (centerW) {
      gapA = Math.max(0, Math.min(free, Math.floor((inner - centerW) / 2) - leftW));
      gapB = free - gapA;
    }
    runs = [
      ...frameLeft, ...built.left.runs,
      ...fill(gapA, leftW > 0, centerW > 0 || (rightW > 0 && !gapB)),
      ...built.center.runs,
      ...fill(gapB, centerW > 0 || leftW > 0, rightW > 0),
      ...built.right.runs, ...frameRight,
    ];
  } else {
    runs = [...prefix, ...built.left.runs, ...suffix];
  }
  if (runsWidth(runs) > width) {
    const body = truncateRuns(runs, Math.max(0, width - runsWidth(suffix)));
    runs = runsWidth(suffix) && width > runsWidth(suffix) ? [...body, ...suffix] : truncateRuns(runs, width);
  }
  // A line style sits under everything on the line, so a theme can bring its own
  // background instead of depending on the terminal's.
  const lineStyle = parseStyle(line.style, rc);
  return Object.keys(lineStyle).length ? runs.map((r) => ({ ...r, s: { ...lineStyle, ...r.s } })) : runs;
}

// ---- emission -------------------------------------------------------------

function sgr(style, depth) {
  const codes = [];
  if (style.bold) codes.push('1');
  if (style.dim) codes.push('2');
  if (style.italic) codes.push('3');
  if (style.underline) codes.push('4');
  if (style.blink) codes.push('5');
  if (style.reverse) codes.push('7');
  if (style.strike) codes.push('9');
  const fg = colorCode(style.fg, depth, false);
  if (fg) codes.push(fg);
  const bg = colorCode(style.bg, depth, true);
  if (bg) codes.push(bg);
  return codes.length ? `\x1b[${codes.join(';')}m` : '';
}

function expandGradients(runs, total) {
  const out = [];
  let column = 0;
  let i = 0;
  while (i < runs.length) {
    const run = runs[i];
    if (run.s?.beam) {
      for (const ch of run.t) {
        const t = total > 1 ? column / (total - 1) : 0;
        const { beam, ...rest } = run.s;
        out.push({ t: ch, s: { ...rest, fg: gradientAt(beam, t) } });
        column += cellWidth(ch);
      }
      i++;
      continue;
    }
    if (run.s?.grad) {
      const stops = run.s.grad;
      let j = i;
      let span = 0;
      while (j < runs.length && runs[j].s?.grad === stops) { span += textWidth(runs[j].t); j++; }
      let pos = 0;
      for (let k = i; k < j; k++) {
        const { grad, ...rest } = runs[k].s;
        for (const ch of runs[k].t) {
          out.push({ t: ch, s: { ...rest, fg: gradientAt(stops, span > 1 ? pos / (span - 1) : 0) } });
          pos += cellWidth(ch);
          column += cellWidth(ch);
        }
      }
      i = j;
      continue;
    }
    out.push(run);
    column += textWidth(run.t);
    i++;
  }
  return out;
}

export function emit(runs, depth, { links = true } = {}) {
  const total = runsWidth(runs);
  const expanded = expandGradients(runs.filter((r) => r.t), total);
  if (depth === 'none' && !links) return expanded.map((r) => r.t).join('');
  let out = depth === 'none' ? '' : '\x1b[0m';
  let lastCode = null;
  let lastLink = null;
  let text = '';
  const flushText = () => { out += text; text = ''; };
  for (const run of expanded) {
    const code = depth === 'none' ? '' : sgr(run.s ?? {}, depth);
    const link = links ? run.s?.link ?? null : null;
    if (link !== lastLink) {
      flushText();
      if (lastLink) out += '\x1b]8;;\x1b\\';
      if (link) out += `\x1b]8;;${link}\x1b\\`;
      lastLink = link;
    }
    if (code !== lastCode) {
      flushText();
      if (depth !== 'none') out += `\x1b[0m${code}`;
      lastCode = code;
    }
    text += run.t;
  }
  flushText();
  if (lastLink) out += '\x1b]8;;\x1b\\';
  if (depth !== 'none') out += '\x1b[0m';
  return out;
}

// ---- entry point ----------------------------------------------------------

// [layout] rows are plain lists of module names, drawn with the shared [row] look.
// A [[line]] in your config is the expert route and replaces them entirely.
export function linesOf(cfg) {
  if (Array.isArray(cfg.line)) return cfg.line;
  const rows = Array.isArray(cfg.layout?.rows) ? cfg.layout.rows : [];
  return rows.filter(Array.isArray).map((row) => {
    const split = row.indexOf('>');
    return split < 0
      ? { ...cfg.row, left: row }
      : { ...cfg.row, left: row.slice(0, split), right: row.slice(split + 1) };
  });
}

export function renderBar(input, opts = {}) {
  const env = opts.env ?? process.env;
  const raw = input && typeof input === 'object' ? input : {};
  const projectDir = opts.projectDir ?? raw.workspace?.project_dir ?? raw.cwd;
  const layers = opts.layers ?? loadLayers({ env, projectDir });
  const cfg = assemble(layers, env);
  if (opts.overlay) Object.assign(cfg, merge(cfg, opts.overlay));

  const rc = makeContext(cfg, opts);
  rc.setConfig(cfg);
  const scope = buildScope(raw, rc, { env, now: opts.now, cols: opts.cols, home: opts.home, overrides: opts.overrides });
  rc.scope = scope;
  rc.env.now = scope.time.epoch;
  scope.g = glyphScope(rc.cfg, rc.charset);

  applyRules(rc);

  const margin = typeof rc.cfg.settings?.margin === 'number' ? rc.cfg.settings.margin : 4;
  const width = Math.max(1, scope.term.cols - margin);
  const depth = detectDepth(env, rc.cfg.settings?.color);
  const links = rc.cfg.settings?.links !== false;
  // append_line adds rows under the layout instead of replacing it.
  const lines = [...linesOf(rc.cfg), ...(Array.isArray(rc.cfg.append_line) ? rc.cfg.append_line : [])];
  const output = [];
  for (const line of lines) {
    let runs = null;
    try {
      runs = renderLine(line, rc, width);
    } catch (e) {
      rc.note(e.message);
    }
    if (runs) output.push(runs);
  }

  // Problems stay visible but can never take the bar down.
  const problems = [...layers.errors, ...rc.notes];
  if (problems.length) {
    const msg = `${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}`;
    output.push(truncateRuns([{ t: msg, s: parseStyle('hot', rc) }], width));
  } else if (layers.notices.length && rc.cfg.settings?.notices !== false) {
    output.push(truncateRuns([{ t: layers.notices[0], s: parseStyle('muted', rc) }], width));
  }

  return {
    text: output.map((runs) => emit(runs, depth, { links })).join('\n'),
    lines: output,
    rc,
    scope,
    problems,
    width,
    depth,
    layers,
  };
}

// One JSON line per subagent for the agent panel. Only the rows given are touched,
// and anything unexpected falls back to Claude Code's own row.
export function renderSubagents(input, opts = {}) {
  const env = opts.env ?? process.env;
  const raw = input && typeof input === 'object' ? input : {};
  const layers = opts.layers ?? loadLayers({ env, projectDir: null });
  const cfg = assemble(layers, env);
  const def = cfg.subagent ?? {};
  if (def.disabled === true || def.format === undefined) return [];
  const rc = makeContext(cfg, opts);
  rc.setConfig(cfg);
  const now = opts.now ?? Date.now() / 1000;
  const columns = typeof raw.columns === 'number' && raw.columns > 0 ? raw.columns : 120;
  const depth = detectDepth(env, cfg.settings?.color);
  const style = parseStyle(def.style, rc);
  const out = [];
  for (const task of Array.isArray(raw.tasks) ? raw.tasks : []) {
    if (!task || typeof task.id !== 'string') continue;
    const size = typeof task.contextWindowSize === 'number' ? task.contextWindowSize : null;
    const tokens = typeof task.tokenCount === 'number' ? task.tokenCount : null;
    rc.scope = {
      g: glyphScope(cfg, rc.charset),
      term: { cols: columns },
      task: {
        id: task.id,
        name: task.name ?? null,
        agent: task.name ?? task.agentType ?? task.type ?? 'agent',
        type: task.agentType ?? null,
        text: task.label ?? task.description ?? '',
        status: task.status ?? null,
        model: typeof task.model === 'string' ? task.model.replace(/^claude-/, '') : null,
        effort: task.effort ?? null,
        tokens,
        pct: size && tokens !== null ? (tokens / size) * 100 : null,
        elapsed: typeof task.startTime === 'number' ? Math.max(0, now - task.startTime / 1000) : null,
        samples: Array.isArray(task.tokenSamples) ? task.tokenSamples : [],
      },
    };
    rc.memo.clear();
    try {
      const runs = truncateRuns(renderTemplate(def.format, rc, style), columns);
      out.push({ id: task.id, content: emit(runs.map((r) => ({ ...r, s: { ...style, ...r.s } })), depth, { links: false }) });
    } catch (e) {
      rc.note(e.message);
    }
  }
  return out;
}
