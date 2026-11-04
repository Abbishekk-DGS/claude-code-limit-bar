// Regenerates the README images: node scripts/shots.mjs [out-dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderBar } from '../src/render.js';
import { fixture } from '../src/fixtures.js';
import { ansiToHtml } from './ansi-to-html.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'assets'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const NOW = 1800000000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-bar-shot-'));
const env = { PATH: process.env.PATH, HOME: tmp, XDG_CONFIG_HOME: path.join(tmp, 'c'), XDG_CACHE_HOME: path.join(tmp, 'k'), COLORTERM: 'truecolor', LIMITBAR_COLOR: 'truecolor' };

export function bar(theme, state, { cols = 130, charset = 'nerd', patch } = {}) {
  const f = fixture(state, NOW);
  if (patch) patch(f);
  const r = renderBar(f.input, { env: { ...env, LIMITBAR_CHARSET: charset }, theme, cols, now: NOW, overrides: f.overrides, offline: true, projectDir: null });
  if (r.problems.length) throw new Error(`${theme}/${state}: ${r.problems.join('; ')}`);
  return r.text;
}

const PANEL = {
  indigo: { bg: '#ffffff', fg: '#1f2328' },
  cyberpunk: { bg: '#ffffff', fg: '#1f2328' },
  minecraft: { bg: '#ffffff', fg: '#1f2328' },
  neon: { bg: '#ffffff', fg: '#1f2328' },
  matrix: { bg: '#ffffff', fg: '#1f2328' },
  gameboy: { bg: '#ffffff', fg: '#1f2328' },
  graphite: { bg: '#0d1117', fg: '#c9d1d9' },
  cockpit: { bg: '#120d05', fg: '#ffcf70' },
  dusk: { bg: '#15121f', fg: '#ece7f5' },
};

const CSS = `
*{box-sizing:border-box;margin:0}
.w{display:inline-block;height:1.22em;vertical-align:top;text-align:center;overflow:visible}
body{background:#f4f6f6;font:13px/1.45 -apple-system,"Helvetica Neue",Arial,sans-serif;color:#0c1a19;padding:28px;width:1040px}
.t{border-radius:8px;border:1px solid rgba(12,26,25,.14);overflow:hidden;margin-bottom:18px}
.h{display:flex;gap:10px;align-items:baseline;padding:9px 14px;background:#fff;border-bottom:1px solid rgba(12,26,25,.1)}
.h b{font-size:13px}.h span{color:#5b6f6d;font-size:12px}
.b{padding:12px 14px}
.lbl{font:11px/1 -apple-system,"Helvetica Neue",sans-serif;margin:10px 0 6px;opacity:.55}
.lbl:first-child{margin-top:0}
pre{font:12px/1.22 Menlo,Consolas,monospace;white-space:pre;letter-spacing:0}
.c{display:inline-block;height:1.22em;vertical-align:top}
.g{display:inline-block;width:1ch;height:1.22em;vertical-align:top}
.g i{display:block;width:100%;height:100%}
`;

function page(body, width = 1040) {
  return `<!doctype html><meta charset="utf-8"><style>${CSS}body{width:${width}px}</style>${body}`;
}

const panel = (name, desc, rows) => {
  const p = PANEL[name];
  return `<div class="t"><div class="h"><b>${name}</b><span>${desc}</span></div><div class="b" style="background:${p.bg};color:${p.fg}">${rows.map(([label, text]) => `<div class="lbl">${label}</div><pre>${ansiToHtml(text, p)}</pre>`).join('')}</div></div>`;
};

function shoot(html, file, width, height) {
  const htmlFile = path.join(tmp, `${path.basename(file)}.html`);
  fs.writeFileSync(htmlFile, html);
  const r = spawnSync('nice', ['-n', '15', CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', `--force-device-scale-factor=2`, `--window-size=${width},${height}`, `--screenshot=${file}`, `file://${htmlFile}`], { stdio: 'ignore', timeout: 60000 });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error(`screenshot failed: ${file}`);
}

fs.mkdirSync(OUT, { recursive: true });
const DESC = {
  neon: 'Gradient gauges on black. The default',
  indigo: 'Three lines, with the percentage inside each gauge. Reads on light and dark',
  cyberpunk: 'Black, hazard yellow, cyan and magenta, all in capitals',
  minecraft: 'Each line a layer of ground: grass, dirt, stone',
  matrix: 'Phosphor green on black, written like a shell',
  gameboy: 'Only the four greens of the original handheld',
  graphite: 'One quiet line, grey until something needs attention',
  cockpit: 'Instrument panel with trends, forecasts and a caution chip',
  dusk: 'Framed panel with a continuous gradient border',
};
const themes = Object.keys(DESC);
const rows = (t) => [['Normal session', bar(t, 'working')], ['Close to the limit', bar(t, 'danger')]];
shoot(page(themes.map((t) => panel(t, DESC[t], rows(t))).join('')), path.join(OUT, 'themes.png'), 1040, 1960);

const sizes = (t) => [[140, 'working'], [100, 'working'], [64, 'working'], [40, 'working']].map(([cols, s]) => [`${cols} columns`, bar(t, s, { cols })]);
shoot(page(['dusk', 'cockpit'].map((t) => panel(t, 'The same config at four terminal widths', sizes(t))).join(''), 1160), path.join(OUT, 'responsive.png'), 1160, 560);

// Demo of [[when]]: one config, and the bar changes form as the session heats up.
const framesDir = path.join(tmp, 'frames');
fs.mkdirSync(framesDir);
const RULES = `theme = "graphite"\n\n[[when]]\nname = "take over when a limit is close"\nif = "ctx.pct >= 85 || limit.h5.pct >= 85"\ntheme = "cockpit"\n`;
fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'limit-bar'), { recursive: true });
const cfgFile = path.join(env.XDG_CONFIG_HOME, 'limit-bar', 'config.toml');
fs.writeFileSync(cfgFile, RULES);
const steps = [18, 26, 34, 42, 50, 58, 66, 72, 78, 82, 84, 87, 90, 93, 95];
const hold = (i) => (i === 0 || i === steps.length - 1 ? 8 : steps[i] === 87 ? 6 : 1);
let frame = 0;
for (let i = 0; i < steps.length; i++) {
  const pct = steps[i];
  const f = fixture(pct >= 85 ? 'danger' : 'working', NOW);
  const size = 200000;
  f.input.context_window = { ...f.input.context_window, used_percentage: pct, remaining_percentage: 100 - pct, context_window_size: size };
  f.input.rate_limits.five_hour.used_percentage = Math.round(pct * 0.8);
  const r = renderBar(f.input, { env: { ...env, LIMITBAR_CHARSET: 'nerd' }, cols: 118, now: NOW, overrides: f.overrides, offline: true, projectDir: null });
  const p = pct >= 85 ? PANEL.cockpit : PANEL.graphite;
  const code = RULES.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = page(`<div class="t" style="margin:0"><div class="h"><b>config.toml</b><span>one rule, and the bar changes form as the session heats up</span></div><div class="b" style="background:#fff"><pre style="color:#0c1a19">${code}</pre></div><div class="b" style="background:${p.bg};color:${p.fg};height:66px"><pre>${ansiToHtml(r.text, p)}</pre></div></div>`, 900);
  const png = path.join(framesDir, `s${String(i).padStart(2, '0')}.png`);
  const htmlFile = path.join(tmp, `f${i}.html`);
  fs.writeFileSync(htmlFile, html);
  spawnSync('nice', ['-n', '15', CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=900,270', `--screenshot=${png}`, `file://${htmlFile}`], { stdio: 'ignore', timeout: 60000 });
  for (let k = 0; k < hold(i); k++) fs.copyFileSync(png, path.join(framesDir, `f${String(frame++).padStart(3, '0')}.png`));
}
const gif = path.join(OUT, 'reactive.gif');
const ff = spawnSync('nice', ['-n', '15', 'ffmpeg', '-y', '-loglevel', 'error', '-threads', '2', '-framerate', '4', '-i', path.join(framesDir, 'f%03d.png'), '-vf', 'split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none', gif], { encoding: 'utf8' });
if (ff.status !== 0) throw new Error(ff.stderr);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote images to ${OUT}`);
