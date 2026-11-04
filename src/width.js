// Terminal cell widths, sanitising and truncation.

const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x20000, 0x3fffd],
];
const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const EMOJI = /^\p{Emoji_Presentation}$/u;
const FLAG_FIRST = 0x1f1e6;
const FLAG_LAST = 0x1f1ff;

export function cellWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if (ZERO.test(ch)) return 0;
  if (cp >= 0xe000 && cp <= 0xf8ff) return 1; // private use: Nerd Font glyphs
  if (cp >= FLAG_FIRST && cp <= FLAG_LAST) return 1;
  for (const [a, b] of WIDE) if (cp >= a && cp <= b) return 2;
  return EMOJI.test(ch) ? 2 : 1;
}

export function textWidth(s) {
  let w = 0;
  let prev = 0;
  for (const ch of String(s)) {
    if (ch === '️' && prev === 1) { w += 1; prev = 2; continue; }
    const cw = cellWidth(ch);
    w += cw;
    if (cw) prev = cw;
  }
  return w;
}

// Removes everything that could steer the terminal: ESC, C0 and C1 controls,
// bidi overrides. Applied to every value interpolated into a template, so a
// hostile branch name or command output cannot inject escape sequences.
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
export function sanitize(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '').replace(CONTROL, '');
}

export function truncateText(s, max, tail = '…') {
  if (max <= 0) return '';
  if (textWidth(s) <= max) return s;
  const room = max - textWidth(tail);
  if (room < 0) return '';
  let w = 0;
  let out = '';
  for (const ch of String(s)) {
    const cw = cellWidth(ch);
    if (w + cw > room) break;
    out += ch;
    w += cw;
  }
  return out + tail;
}

export function truncateLeft(s, max, head = '…') {
  if (max <= 0) return '';
  if (textWidth(s) <= max) return s;
  const room = max - textWidth(head);
  if (room < 0) return '';
  const chars = Array.from(String(s));
  let w = 0;
  let out = '';
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = cellWidth(chars[i]);
    if (w + cw > room) break;
    out = chars[i] + out;
    w += cw;
  }
  return head + out;
}

export const runsWidth = (runs) => runs.reduce((n, r) => n + textWidth(r.t), 0);

// Cuts styled runs to a width, keeping their styles.
export function truncateRuns(runs, max, tail = '…') {
  if (runsWidth(runs) <= max) return runs;
  const room = max - textWidth(tail);
  if (room < 0) return [];
  const out = [];
  let used = 0;
  let lastStyle = {};
  for (const run of runs) {
    const w = textWidth(run.t);
    lastStyle = run.s;
    if (used + w <= room) { out.push(run); used += w; continue; }
    let piece = '';
    for (const ch of run.t) {
      const cw = cellWidth(ch);
      if (used + cw > room) break;
      piece += ch;
      used += cw;
    }
    if (piece) out.push({ t: piece, s: run.s });
    break;
  }
  if (tail) out.push({ t: tail, s: lastStyle });
  return out;
}
