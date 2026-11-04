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

export function bar(state, { cols = 130, charset = 'unicode' } = {}) {
  const f = fixture(state, NOW);
  const r = renderBar(f.input, { env: { ...env, LIMITBAR_CHARSET: charset }, cols, now: NOW, overrides: f.overrides, offline: true, projectDir: null });
  if (r.problems.length) throw new Error(`${state}: ${r.problems.join('; ')}`);
  return r.text;
}

const PANEL = { bg: '#ffffff', fg: '#1f2328' };

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

const panel = (name, desc, rows, colors = PANEL) => `<div class="t"><div class="h"><b>${name}</b><span>${desc}</span></div><div class="b" style="background:${colors.bg};color:${colors.fg}">${rows.map(([label, text]) => `<div class="lbl">${label}</div><pre>${ansiToHtml(text, colors)}</pre>`).join('')}</div></div>`;

function shoot(html, file, width, height) {
  const htmlFile = path.join(tmp, `${path.basename(file)}.html`);
  fs.writeFileSync(htmlFile, html);
  const r = spawnSync('nice', ['-n', '15', CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', `--force-device-scale-factor=2`, `--window-size=${width},${height}`, `--screenshot=${file}`, `file://${htmlFile}`], { stdio: 'ignore', timeout: 60000 });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error(`screenshot failed: ${file}`);
}

fs.mkdirSync(OUT, { recursive: true });
shoot(page(panel('On a white terminal', 'The background is transparent', [['New session', bar('fresh')], ['Normal session', bar('working')], ['Close to the limit', bar('danger')]]) + panel('On a black terminal', 'The same colours', [['Normal session', bar('working')], ['Close to the limit', bar('danger')]], { bg: '#0b0b10', fg: '#e8e8f0' })), path.join(OUT, 'neon.png'), 1040, 760);
shoot(page(panel('neon', 'The same config at four terminal widths', [140, 100, 64, 40].map((cols) => [`${cols} columns`, bar('working', { cols })])), 1160), path.join(OUT, 'responsive.png'), 1160, 620);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Wrote images to ${OUT}`);
