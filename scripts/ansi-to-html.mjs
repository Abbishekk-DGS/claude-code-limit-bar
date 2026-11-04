// Converts limit-bar's ANSI output to HTML so screenshots show exactly what it emits.
// Powerline glyphs are drawn with CSS so the image does not depend on a Nerd Font.
import { cellWidth } from '../src/width.js';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Menlo has no Nerd Font glyphs, so the image shows their closest plain equivalent.
const NERD = { '\ue0a0': '⎇', '\ue0b1': '│', '\ue0b3': '│', '\uf00c': '✓', '\uf062': '↑', '\uf063': '↓', '\uf071': '▲', '\uf017': '◷', '\uf407': '⇄', '\uf0ad': '◐', '\uf0ae': '☰', '\uf1c0': '◉', '\uf1bb': '⑂', '\uf544': '◆' };
const BLOCKS = { '█': 100, '▉': 87.5, '▊': 75, '▋': 62.5, '▌': 50, '▍': 37.5, '▎': 25, '▏': 12.5 };
const ANSI16 = ['#000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#fff'];

export function ansiToHtml(text, { fg, bg }) {
  let out = '';
  const st = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false };
  const open = () => {
    const css = [];
    if (st.fg) css.push(`color:${st.fg}`);
    if (st.bg) css.push(`background:${st.bg}`);
    if (st.bold) css.push('font-weight:700');
    if (st.dim) css.push('opacity:.6');
    if (st.italic) css.push('font-style:italic');
    if (st.underline) css.push('text-decoration:underline');
    return css.join(';');
  };
  const re = /\x1b\[([0-9;]*)m|\x1b\]8;;[^\x1b]*\x1b\\/g;
  let last = 0;
  const flush = (chunk) => {
    if (!chunk) return;
    const css = open();
    let body = '';
    for (const ch of chunk) {
      if (ch === '\ue0b0' || ch === '\ue0b2' || ch === '\ue0b4' || ch === '\ue0b6') {
        const shape = { '\ue0b0': 'polygon(0 0,100% 50%,0 100%)', '\ue0b2': 'polygon(100% 0,0 50%,100% 100%)', '\ue0b4': 'ellipse(100% 50% at 0 50%)', '\ue0b6': 'ellipse(100% 50% at 100% 50%)' }[ch];
        body += `<span class="g" style="background:${st.bg ?? 'transparent'}"><i style="background:${st.fg ?? fg};clip-path:${shape}"></i></span>`;
      } else if (BLOCKS[ch] !== undefined) {
        // Drawn as boxes: browsers leave seams in block glyphs that terminals do not.
        const f = st.fg ?? fg;
        const pct = BLOCKS[ch];
        body += `<span class="g" style="background:linear-gradient(90deg,${f} ${pct}%,${st.bg ?? 'transparent'} ${pct}%)"></span>`;
      } else if (ch > '\u007f') {
        // Fallback fonts ignore the monospace grid, so each symbol gets its terminal cells.
        const shown = NERD[ch] ?? ch;
        body += `<span class="w" style="width:${cellWidth(ch)}ch">${esc(shown)}</span>`;
      } else body += esc(ch);
    }
    // Terminal cells are filled edge to edge, so backgrounds take the full line height.
    const cell = st.bg ? 'class="c" ' : '';
    out += `<span ${cell}style="${css}">${body}</span>`;
  };
  for (let m; (m = re.exec(text));) {
    flush(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] === undefined) continue;
    const c = (m[1] || '0').split(';').map(Number);
    for (let i = 0; i < c.length; i++) {
      const n = c[i];
      if (n === 0) Object.assign(st, { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false });
      else if (n === 1) st.bold = true;
      else if (n === 2) st.dim = true;
      else if (n === 3) st.italic = true;
      else if (n === 4) st.underline = true;
      else if (n === 38 || n === 48) {
        const key = n === 38 ? 'fg' : 'bg';
        if (c[i + 1] === 2) { st[key] = `rgb(${c[i + 2]},${c[i + 3]},${c[i + 4]})`; i += 4; } else if (c[i + 1] === 5) { st[key] = `var(--c${c[i + 2]})`; i += 2; }
      } else if (n >= 30 && n <= 37) st.fg = ANSI16[n - 30];
      else if (n >= 90 && n <= 97) st.fg = ANSI16[n - 82];
      else if (n >= 40 && n <= 47) st.bg = ANSI16[n - 40];
      else if (n >= 100 && n <= 107) st.bg = ANSI16[n - 92];
    }
  }
  flush(text.slice(last));
  return out;
}
