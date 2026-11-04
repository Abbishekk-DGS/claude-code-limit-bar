import test from 'node:test';
import assert from 'node:assert/strict';
import { parseToml, TomlError } from '../src/toml.js';
import { evaluate, truthy } from '../src/expr.js';
import { parseTemplate } from '../src/template.js';
import { sanitize, textWidth, truncateText, truncateRuns, runsWidth } from '../src/width.js';
import { parseColor, gradientAt, colorCode, detectDepth } from '../src/color.js';
import { slope, deriveHistory } from '../src/history.js';
import { parsePorcelain } from '../src/git.js';
import { formatDuration, formatTokens } from '../src/template.js';
import { shapeValue } from '../src/sources.js';

test('toml reads the forms config files use', () => {
  const v = parseToml(`
# comment
theme = "neon" # trailing
n = 1_000
f = 1.5
b = true
arr = ["a", 'b',
  "c", # inner comment
]
inline = { a = 1, b.c = "x" }
"quoted key" = 1
multi = """
hello \\
  world"""
lit = '''C:\\x'''
esc = "\\ue0b0 \\e"
[a.b]
c = 1
[[line]]
left = ["x"]
[[line]]
left = ["y"]
[[when]]
if = "x"
[[when.line]]
left = "z"
`);
  assert.equal(v.theme, 'neon');
  assert.equal(v.n, 1000);
  assert.deepEqual(v.arr, ['a', 'b', 'c']);
  assert.equal(v.inline.b.c, 'x');
  assert.equal(v['quoted key'], 1);
  assert.equal(v.multi, 'hello world');
  assert.equal(v.lit, 'C:\\x');
  assert.equal(v.esc, '\ue0b0 \x1b');
  assert.equal(v.a.b.c, 1);
  assert.equal(v.line.length, 2);
  assert.equal(v.when[0].line[0].left, 'z');
});

test('toml errors name the line', () => {
  assert.throws(() => parseToml('a = 1\nb = \n'), (e) => e instanceof TomlError && e.line >= 2);
  assert.throws(() => parseToml('a = 1\na = 2'), /line 2: duplicate key/);
  assert.throws(() => parseToml('a = bare'), /strings need quotes/);
  assert.throws(() => parseToml('[x\n'), /expected/);
});

test('toml refuses prototype keys', () => {
  assert.throws(() => parseToml('__proto__ = 1'), /not allowed/);
  assert.throws(() => parseToml('[constructor]\nx = 1'), /not allowed/);
  assert.equal({}.polluted, undefined);
});

test('expressions: precedence, nulls and types', () => {
  const s = { a: { b: 5 }, s: 'main', n: null, list: [1, 2] };
  assert.equal(evaluate('1 + 2 * 3', s), 7);
  assert.equal(evaluate('(1 + 2) * 3', s), 9);
  assert.equal(evaluate('a.b >= 5 && s == "main"', s), true);
  assert.equal(evaluate('a.missing.deep', s), null);
  assert.equal(evaluate('n > 5', s), false);
  assert.equal(evaluate('n < 5', s), false);
  assert.equal(evaluate('n + 1', s), null);
  assert.equal(evaluate('n ?? "x"', s), 'x');
  assert.equal(evaluate('a.b > 1 ? "big" : "small"', s), 'big');
  assert.equal(evaluate('1 / 0', s), null);
  assert.equal(evaluate('contains(s, "ai")', s), true);
  assert.equal(evaluate('matches(s, "^ma")', s), true);
  assert.equal(evaluate('matches(s, "(")', s), false);
  assert.equal(evaluate('severity(90)', s, { warn: 60, hot: 85 }), 'hot');
  assert.equal(evaluate('severity(70)', s, { warn: 60, hot: 85 }), 'warn');
  assert.equal(evaluate('severity(70, 80, 90)', s), 'ok');
  assert.equal(evaluate('severity(n)', s), 'muted');
  assert.equal(evaluate('2 in list', s), true);
  assert.equal(truthy([]), false);
});

test('expressions cannot reach the prototype chain or run code', () => {
  const s = { a: {} };
  assert.equal(evaluate('a.constructor', s), null);
  assert.equal(evaluate('a.__proto__', s), null);
  assert.equal(evaluate('constructor', s), null);
  assert.throws(() => evaluate('process()', s), /unknown function/);
  assert.throws(() => evaluate('a[0]', s));
  assert.throws(() => evaluate('require("fs")', s), /unknown function/);
});

test('templates report syntax mistakes', () => {
  assert.throws(() => parseTemplate('{unclosed'), /unclosed/);
  assert.throws(() => parseTemplate('{if a}no end'), /without \{end\}/);
  assert.throws(() => parseTemplate('{end}'), /without \{if\}/);
  assert.throws(() => parseTemplate('{a | nofilter}'), /unknown filter/);
  assert.throws(() => parseTemplate('{1 +}'), /unexpected end/);
});

test('sanitize removes every terminal control sequence', () => {
  assert.equal(sanitize('a\x1b[31mb\x1b[0mc'), 'abc');
  assert.equal(sanitize('x\x1b]0;evil title\x07y'), 'xy');
  assert.equal(sanitize('x\x1b]8;;http://evil\x1b\\y'), 'xy');
  assert.equal(sanitize('a\nb\tc\x07d\x9be'), 'abcde');
  assert.equal(sanitize('safe\u202eevil'), 'safeevil');
});

test('width handles wide, combining and emoji text', () => {
  assert.equal(textWidth('abc'), 3);
  assert.equal(textWidth('日本'), 4);
  assert.equal(textWidth('e\u0301'), 1);
  assert.equal(textWidth('🚀'), 2);
  assert.equal(textWidth('\ue0b0'), 1);
  assert.equal(truncateText('hello world', 6), 'hello…');
  assert.equal(textWidth(truncateText('日本語日本語', 5)), 5);
  const runs = truncateRuns([{ t: 'abc', s: { a: 1 } }, { t: 'defgh', s: { b: 1 } }], 5);
  assert.equal(runsWidth(runs), 5);
});

test('colours parse and downgrade', () => {
  assert.deepEqual(parseColor('#fff').rgb, [255, 255, 255]);
  assert.deepEqual(parseColor('#0c7a72').rgb, [12, 122, 114]);
  assert.equal(parseColor('red').idx, 1);
  assert.equal(parseColor('200').idx, 200);
  assert.equal(parseColor('nope'), null);
  const c = parseColor('#ff7a1a');
  assert.equal(colorCode(c, 'truecolor'), '38;2;255;122;26');
  assert.match(colorCode(c, '256'), /^38;5;\d+$/);
  assert.match(colorCode(c, '16'), /^9?[0-7]$|^3\d$/);
  assert.equal(colorCode(c, 'none'), '');
  const mid = gradientAt([parseColor('#000000'), parseColor('#ffffff')], 0.5);
  assert.ok(mid.rgb[0] > 80 && mid.rgb[0] < 200);
  assert.deepEqual(gradientAt([parseColor('#102030')], 0.5).rgb, [16, 32, 48]);
});

test('colour depth respects the environment', () => {
  assert.equal(detectDepth({ NO_COLOR: '1', COLORTERM: 'truecolor' }), 'none');
  assert.equal(detectDepth({ COLORTERM: 'truecolor' }), 'truecolor');
  assert.equal(detectDepth({ TERM_PROGRAM: 'Apple_Terminal' }), '256');
  assert.equal(detectDepth({ TERM: 'xterm-256color' }), '256');
  assert.equal(detectDepth({ TERM: 'dumb' }), 'none');
  assert.equal(detectDepth({ COLORTERM: 'truecolor' }, '16'), '16');
});

test('formatters', () => {
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(3600), '1h');
  assert.equal(formatDuration(8040), '2h14m');
  assert.equal(formatDuration(90061), '1d1h');
  assert.equal(formatDuration(5400, 1), '1h');
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(200000), '200k');
  assert.equal(formatTokens(1000000), '1M');
});

test('burn rate restarts after a drop, because /compact is not negative burn', () => {
  const t0 = 1000;
  const rising = Array.from({ length: 6 }, (_, i) => ({ t: t0 + i * 60, ctx: 10 + i * 2 }));
  assert.ok(Math.abs(slope(rising, 'ctx', t0 + 300) - 2 / 60) < 1e-9);
  const compacted = [...rising, ...[0, 1, 2, 3].map((i) => ({ t: t0 + 360 + i * 60, ctx: 5 + i }))];
  assert.ok(Math.abs(slope(compacted, 'ctx', t0 + 540) - 1 / 60) < 1e-9);
  assert.equal(slope(rising.slice(0, 2), 'ctx', t0 + 60), null);
  const d = deriveHistory(rising, t0 + 300, 100, 20);
  assert.ok(Math.abs(d.eta.ctx - 80 / (2 / 60)) < 1e-6);
  assert.equal(deriveHistory([], t0, 100, 20).eta.ctx, null);
});

test('git porcelain parsing', () => {
  const g = parsePorcelain(`# branch.oid abcdef1234567
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -1
1 M. N... 100644 100644 100644 a b f1
1 .M N... 100644 100644 100644 a b f2
2 R. N... 100644 100644 100644 a b R100 f3\tf4
u UU N... 100644 100644 100644 100644 a b c f5
? f6
`);
  assert.equal(g.branch, 'main');
  assert.equal(g.ahead, 2);
  assert.equal(g.behind, 1);
  assert.equal(g.staged, 2);
  assert.equal(g.modified, 1);
  assert.equal(g.conflicts, 1);
  assert.equal(g.untracked, 1);
  assert.equal(g.dirty, true);
  const d = parsePorcelain('# branch.oid abcdef1234567\n# branch.head (detached)\n');
  assert.equal(d.detached, true);
  assert.equal(d.branch, 'abcdef1');
  assert.equal(d.clean, true);
});

test('source values are shaped and sanitised', () => {
  assert.equal(shapeValue('\n  hello\x1b[31m \nsecond', 'text').value, 'hello');
  assert.deepEqual(shapeValue('{"a":1}', 'json').data, { a: 1 });
  assert.equal(shapeValue('not json', 'json').data, null);
  assert.deepEqual(shapeValue('a\n\nb\n', 'lines').data, ['a', 'b']);
});

test('an unborn repo has no commit id', () => {
  assert.equal(parsePorcelain('# branch.oid (initial)\n# branch.head main\n').oid, null);
});
