// A small, strict TOML reader: tables, arrays of tables, dotted and quoted keys,
// all string forms, numbers, booleans, arrays and inline tables. Dates are not
// supported because no limit-bar setting needs them. Errors carry line numbers.

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export class TomlError extends Error {
  constructor(message, line) {
    super(`line ${line}: ${message}`);
    this.name = 'TomlError';
    this.line = line;
  }
}

export function parseToml(text, { lines } = {}) {
  const src = String(text).replace(/\r\n/g, '\n');
  let i = 0;
  let lineNo = 1;
  const root = {};
  let current = root;
  let currentPath = [];

  const fail = (msg) => { throw new TomlError(msg, lineNo); };
  const peek = () => src[i];
  const advance = () => { if (src[i] === '\n') lineNo++; return src[i++]; };

  function skipInline() {
    while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
  }
  function skipComment() {
    if (src[i] === '#') while (i < src.length && src[i] !== '\n') i++;
  }
  function skipAll() {
    for (;;) {
      while (i < src.length && /[ \t\n]/.test(src[i])) advance();
      if (src[i] === '#') skipComment(); else break;
    }
  }
  function endOfLine() {
    skipInline();
    skipComment();
    if (i < src.length && src[i] !== '\n') fail(`unexpected text "${src.slice(i, i + 12)}" after value`);
  }

  function basicEscape() {
    const c = advance();
    switch (c) {
      case 'b': return '\b';
      case 't': return '\t';
      case 'n': return '\n';
      case 'f': return '\f';
      case 'r': return '\r';
      case 'e': return '\x1b';
      case '"': return '"';
      case '\\': return '\\';
      case 'x': case 'u': case 'U': {
        const n = c === 'x' ? 2 : c === 'u' ? 4 : 8;
        const hex = src.slice(i, i + n);
        if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(hex)) fail(`bad \\${c} escape`);
        i += n;
        return String.fromCodePoint(parseInt(hex, 16));
      }
      default: return fail(`unknown escape \\${c}`);
    }
  }

  function parseString() {
    const q = src[i];
    const triple = src.startsWith(q.repeat(3), i);
    if (triple) {
      i += 3;
      if (src[i] === '\n') advance();
      let out = '';
      for (;;) {
        if (i >= src.length) fail('unterminated multi-line string');
        if (src.startsWith(q.repeat(3), i)) {
          i += 3;
          while (src[i] === q) { out += q; i++; }
          return out;
        }
        if (q === '"' && src[i] === '\\') {
          advance();
          if (/[ \t\n]/.test(src[i] ?? '')) {
            while (i < src.length && /[ \t\n]/.test(src[i])) advance();
          } else out += basicEscape();
          continue;
        }
        out += advance();
      }
    }
    i++;
    let out = '';
    for (;;) {
      if (i >= src.length || src[i] === '\n') fail('unterminated string');
      const c = src[i];
      if (c === q) { i++; return out; }
      if (q === '"' && c === '\\') { i++; out += basicEscape(); continue; }
      out += c;
      i++;
    }
  }

  function parseKeyPart() {
    if (src[i] === '"' || src[i] === "'") {
      if (src.startsWith(src[i].repeat(3), i)) fail('multi-line string cannot be a key');
      return parseString();
    }
    const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i, i + 256));
    if (!m) fail(`expected a key, found "${src[i] ?? 'end of file'}"`);
    i += m[0].length;
    return m[0];
  }
  function parseKey() {
    const parts = [parseKeyPart()];
    for (;;) {
      skipInline();
      if (src[i] !== '.') break;
      i++;
      skipInline();
      parts.push(parseKeyPart());
    }
    for (const p of parts) if (FORBIDDEN.has(p)) fail(`key "${p}" is not allowed`);
    return parts;
  }

  function parseValue() {
    const c = peek();
    if (c === '"' || c === "'") return parseString();
    if (c === '[') return parseArray();
    if (c === '{') return parseInline();
    const m = /^[^\s,\]}#]+/.exec(src.slice(i, i + 128));
    if (!m) fail('expected a value');
    const raw = m[0];
    i += raw.length;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (/^[+-]?(inf|nan)$/.test(raw)) fail('inf and nan are not supported');
    const clean = raw.replace(/_/g, '');
    if (/^[+-]?\d+$/.test(clean)) return parseInt(clean, 10);
    if (/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(clean)) return parseFloat(clean);
    if (/^0x[0-9a-fA-F]+$/.test(clean)) return parseInt(clean.slice(2), 16);
    if (/^0o[0-7]+$/.test(clean)) return parseInt(clean.slice(2), 8);
    if (/^0b[01]+$/.test(clean)) return parseInt(clean.slice(2), 2);
    return fail(`cannot read value "${raw}" (strings need quotes)`);
  }
  function parseArray() {
    i++;
    const out = [];
    for (;;) {
      skipAll();
      if (i >= src.length) fail('unterminated array');
      if (src[i] === ']') { i++; return out; }
      out.push(parseValue());
      skipAll();
      if (src[i] === ',') { i++; continue; }
      if (src[i] === ']') { i++; return out; }
      fail('expected "," or "]" in array');
    }
  }
  function parseInline() {
    i++;
    const out = {};
    skipAll();
    if (src[i] === '}') { i++; return out; }
    for (;;) {
      skipAll();
      const path = parseKey();
      skipInline();
      if (src[i] !== '=') fail('expected "=" in inline table');
      i++;
      skipInline();
      assign(out, path, parseValue(), null);
      skipAll();
      if (src[i] === ',') { i++; skipAll(); if (src[i] === '}') { i++; return out; } continue; }
      if (src[i] === '}') { i++; return out; }
      fail('expected "," or "}" in inline table');
    }
  }

  function descend(obj, key) {
    let next = obj[key];
    if (next === undefined) { next = {}; obj[key] = next; }
    if (Array.isArray(next)) {
      if (!next.length || typeof next[next.length - 1] !== 'object') fail(`"${key}" is not a table`);
      return next[next.length - 1];
    }
    if (typeof next !== 'object' || next === null) fail(`"${key}" is already a value`);
    return next;
  }
  function assign(obj, path, value, recordFrom) {
    let t = obj;
    for (const part of path.slice(0, -1)) t = descend(t, part);
    const last = path[path.length - 1];
    if (Object.hasOwn(t, last)) fail(`duplicate key "${path.join('.')}"`);
    t[last] = value;
    if (lines && recordFrom) lines.set([...recordFrom, ...path].join('.'), lineNo);
  }

  for (;;) {
    skipAll();
    if (i >= src.length) break;
    if (src[i] === '[') {
      const isArray = src[i + 1] === '[';
      i += isArray ? 2 : 1;
      skipInline();
      const path = parseKey();
      skipInline();
      if (!src.startsWith(isArray ? ']]' : ']', i)) fail(`expected "${isArray ? ']]' : ']'}"`);
      i += isArray ? 2 : 1;
      endOfLine();
      let t = root;
      for (const part of path.slice(0, -1)) t = descend(t, part);
      const last = path[path.length - 1];
      if (isArray) {
        if (t[last] === undefined) t[last] = [];
        if (!Array.isArray(t[last])) fail(`"${path.join('.')}" is already a table`);
        const fresh = {};
        t[last].push(fresh);
        current = fresh;
      } else {
        current = descend(t, last);
      }
      currentPath = path;
      if (lines) lines.set(path.join('.'), lineNo);
      continue;
    }
    const startLine = lineNo;
    const path = parseKey();
    skipInline();
    if (src[i] !== '=') fail(`expected "=" after key "${path.join('.')}"`);
    i++;
    skipInline();
    const value = parseValue();
    const saved = lineNo;
    lineNo = startLine;
    assign(current, path, value, currentPath);
    lineNo = saved;
    endOfLine();
  }
  return root;
}
