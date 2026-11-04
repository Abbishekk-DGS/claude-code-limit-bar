// Colour parsing, OKLab gradients, depth downgrade and ANSI emission.

export const ANSI_NAMES = {
  black: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7,
  bright_black: 8, gray: 8, grey: 8, bright_red: 9, bright_green: 10, bright_yellow: 11,
  bright_blue: 12, bright_magenta: 13, bright_cyan: 14, bright_white: 15,
};
const ANSI_RGB = [
  [0, 0, 0], [205, 49, 49], [13, 188, 121], [229, 229, 16], [36, 114, 200], [188, 63, 188], [17, 168, 205], [229, 229, 229],
  [102, 102, 102], [241, 76, 76], [35, 209, 139], [245, 245, 67], [59, 142, 234], [214, 112, 214], [41, 184, 219], [255, 255, 255],
];

export function parseColor(str) {
  const s = String(str).trim();
  let m = /^#([0-9a-fA-F]{3})$/.exec(s);
  if (m) {
    const h = m[1];
    return { rgb: [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)] };
  }
  m = /^#([0-9a-fA-F]{6})$/.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255] };
  }
  if (/^\d{1,3}$/.test(s) && Number(s) <= 255) return { idx: Number(s) };
  const key = s.toLowerCase();
  if (Object.hasOwn(ANSI_NAMES, key)) return { idx: ANSI_NAMES[key] };
  return null;
}

const srgbToLinear = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const linearToSrgb = (v) => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};
function toOklab([r, g, b]) {
  const R = srgbToLinear(r); const G = srgbToLinear(g); const B = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}

// Perceptual interpolation through colour stops, t in 0..1.
export function gradientAt(stops, t) {
  const rgbs = stops.map((c) => (c.rgb ? c.rgb : ANSI_RGB[c.idx] ?? [128, 128, 128]));
  if (rgbs.length === 1) return { rgb: rgbs[0] };
  const clamped = Math.max(0, Math.min(1, t));
  const pos = clamped * (rgbs.length - 1);
  const i = Math.min(Math.floor(pos), rgbs.length - 2);
  const f = pos - i;
  const a = toOklab(rgbs[i]);
  const b = toOklab(rgbs[i + 1]);
  return { rgb: fromOklab([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]) };
}

function to256([r, g, b]) {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}
function to16(rgb) {
  let best = 0;
  let bestD = Infinity;
  ANSI_RGB.forEach((c, i) => {
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}
function idxTo16Code(i, bg) {
  const base = i < 8 ? 30 + i : 90 + (i - 8);
  return String(bg ? base + 10 : base);
}

export function colorCode(color, depth, bg = false) {
  if (!color || depth === 'none') return '';
  const lead = bg ? '48' : '38';
  if (color.idx !== undefined) {
    if (color.idx < 16) return idxTo16Code(color.idx, bg);
    if (depth === '16') return idxTo16Code(to16(idx256Rgb(color.idx)), bg);
    return `${lead};5;${color.idx}`;
  }
  if (depth === 'truecolor') return `${lead};2;${color.rgb.join(';')}`;
  if (depth === '256') return `${lead};5;${to256(color.rgb)}`;
  return idxTo16Code(to16(color.rgb), bg);
}
function idx256Rgb(i) {
  if (i < 16) return ANSI_RGB[i];
  if (i >= 232) { const v = 8 + (i - 232) * 10; return [v, v, v]; }
  const n = i - 16;
  const step = (v) => (v ? 55 + v * 40 : 0);
  return [step(Math.floor(n / 36)), step(Math.floor(n / 6) % 6), step(n % 6)];
}

const DEPTHS = new Set(['truecolor', '256', '16', 'none']);

export function detectDepth(env, setting = 'auto') {
  // NO_COLOR outranks a config file, but not a one-off LIMITBAR_COLOR.
  if (DEPTHS.has(env.LIMITBAR_COLOR)) return env.LIMITBAR_COLOR;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  if (env.FORCE_COLOR === '0') return 'none';
  if (DEPTHS.has(setting)) return setting;
  const colorterm = (env.COLORTERM || '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor';
  const prog = env.TERM_PROGRAM || '';
  if (['iTerm.app', 'WezTerm', 'ghostty', 'vscode', 'Hyper', 'Tabby', 'rio', 'zed'].includes(prog)) return 'truecolor';
  if (env.KITTY_WINDOW_ID || env.ALACRITTY_SOCKET || env.WT_SESSION) return 'truecolor';
  const term = env.TERM || '';
  if (/truecolor|24bit|kitty|alacritty|ghostty|wezterm/.test(term)) return 'truecolor';
  if (/256/.test(term) || prog === 'Apple_Terminal') return '256';
  if (term === 'dumb') return 'none';
  return term ? '16' : '256';
}
