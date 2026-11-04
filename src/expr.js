// Safe expression language used by `if =`, `= style` and {placeholders}.
// It is parsed into a small tree and walked: there is no eval, no property
// access beyond plain dotted paths, and no way to reach the prototype chain.

const CACHE = new Map();

export class ExprError extends Error {
  constructor(message, source) {
    super(`${message} in expression: ${source}`);
    this.name = 'ExprError';
  }
}

const OPS = ['??', '||', '&&', '==', '!=', '>=', '<=', '>', '<', '+', '-', '*', '/', '%', '!', '?', ':', '(', ')', ','];

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; continue; }
        s += src[j++];
      }
      if (j >= src.length) throw new ExprError('unterminated string', src);
      out.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ k: 'num', v: parseFloat(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)*/.exec(src.slice(i));
    if (id) { out.push({ k: 'id', v: id[0] }); i += id[0].length; continue; }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`unexpected "${c}"`, src);
    out.push({ k: 'op', v: op });
    i += op.length;
  }
  return out;
}

const PREC = { '??': 1, '||': 2, '&&': 3, '==': 4, '!=': 4, in: 4, '>': 5, '<': 5, '>=': 5, '<=': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7 };

function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const isOp = (v) => toks[p]?.k === 'op' && toks[p].v === v;

  function ternary() {
    const cond = binary(0);
    if (isOp('?')) {
      p++;
      const a = ternary();
      if (!isOp(':')) throw new ExprError('expected ":"', src);
      p++;
      return { t: 'if', cond, a, b: ternary() };
    }
    return cond;
  }
  function binary(min) {
    let left = unary();
    for (;;) {
      const tok = toks[p];
      if (!tok) break;
      const name = tok.k === 'op' ? tok.v : tok.k === 'id' && tok.v === 'in' ? 'in' : null;
      const prec = name && PREC[name];
      if (!prec || prec <= min) break;
      p++;
      left = { t: 'bin', op: name, l: left, r: binary(prec) };
    }
    return left;
  }
  function unary() {
    if (isOp('!')) { p++; return { t: 'not', x: unary() }; }
    if (isOp('-')) { p++; return { t: 'neg', x: unary() }; }
    return atom();
  }
  function atom() {
    const tok = toks[p];
    if (!tok) throw new ExprError('unexpected end', src);
    p++;
    if (tok.k === 'num' || tok.k === 'str') return { t: 'lit', v: tok.v };
    if (tok.k === 'op' && tok.v === '(') {
      const e = ternary();
      if (!isOp(')')) throw new ExprError('expected ")"', src);
      p++;
      return e;
    }
    if (tok.k === 'id') {
      if (tok.v === 'true') return { t: 'lit', v: true };
      if (tok.v === 'false') return { t: 'lit', v: false };
      if (tok.v === 'null') return { t: 'lit', v: null };
      if (isOp('(')) {
        p++;
        const args = [];
        if (!isOp(')')) {
          for (;;) {
            args.push(ternary());
            if (isOp(',')) { p++; continue; }
            break;
          }
        }
        if (!isOp(')')) throw new ExprError('expected ")"', src);
        p++;
        if (!Object.hasOwn(FUNCS, tok.v)) throw new ExprError(`unknown function ${tok.v}()`, src);
        return { t: 'call', fn: tok.v, args };
      }
      return { t: 'path', path: tok.v.split('.') };
    }
    throw new ExprError(`unexpected "${tok.v}"`, src);
  }

  const tree = ternary();
  if (p < toks.length) throw new ExprError(`unexpected "${toks[p].v}"`, src);
  return tree;
}

export function compile(src) {
  let tree = CACHE.get(src);
  if (!tree) {
    tree = parse(src);
    CACHE.set(src, tree);
  }
  return tree;
}

export function lookup(scope, parts) {
  let cur = scope;
  for (const key of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null;
    if (!Object.hasOwn(cur, key)) return null;
    cur = cur[key];
  }
  return cur === undefined ? null : cur;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v) => (v === null || v === undefined ? '' : String(v));

// Regexes come from the user's own config. Very long patterns are refused so a
// typo cannot stall the render, and a bad pattern is just "no match".
const REGEXES = new Map();
function regex(src) {
  if (REGEXES.has(src)) return REGEXES.get(src);
  let re = null;
  if (src.length <= 200) {
    try { re = new RegExp(src); } catch { re = null; }
  }
  REGEXES.set(src, re);
  return re;
}

export const FUNCS = {
  min: (...a) => { const n = a.map(num).filter((x) => x !== null); return n.length ? Math.min(...n) : null; },
  max: (...a) => { const n = a.map(num).filter((x) => x !== null); return n.length ? Math.max(...n) : null; },
  round: (v, d = 0) => (num(v) === null ? null : Number(v.toFixed(d))),
  floor: (v) => (num(v) === null ? null : Math.floor(v)),
  ceil: (v) => (num(v) === null ? null : Math.ceil(v)),
  abs: (v) => (num(v) === null ? null : Math.abs(v)),
  len: (v) => (v === null || v === undefined ? 0 : Array.isArray(v) || typeof v === 'string' ? v.length : 0),
  contains: (v, s) => (Array.isArray(v) ? v.includes(s) : text(v).includes(text(s))),
  starts: (v, s) => text(v).startsWith(text(s)),
  ends: (v, s) => text(v).endsWith(text(s)),
  lower: (v) => text(v).toLowerCase(),
  upper: (v) => text(v).toUpperCase(),
  matches: (v, s) => { const re = regex(text(s)); return re ? re.test(text(v)) : false; },
  concat: (...a) => a.map(text).join(''),
  severity: (v, warn, hot) => null, // replaced per render, see evaluate()
  coalesce: (...a) => { for (const v of a) if (v !== null && v !== undefined) return v; return null; },
  every: (n) => null, // replaced per render, true once every n seconds of wall clock
};

export const truthy = (v) => (Array.isArray(v) ? v.length > 0 : Boolean(v));

function walk(n, scope, env) {
  switch (n.t) {
    case 'lit': return n.v;
    case 'path': return lookup(scope, n.path);
    case 'not': return !truthy(walk(n.x, scope, env));
    case 'neg': { const v = num(walk(n.x, scope, env)); return v === null ? null : -v; }
    case 'if': return truthy(walk(n.cond, scope, env)) ? walk(n.a, scope, env) : walk(n.b, scope, env);
    case 'call': {
      const args = n.args.map((a) => walk(a, scope, env));
      if (n.fn === 'severity') {
        const v = num(args[0]);
        if (v === null) return 'muted';
        const warn = num(args[1]) ?? env?.warn ?? 60;
        const hot = num(args[2]) ?? env?.hot ?? 85;
        return v >= hot ? 'hot' : v >= warn ? 'warn' : 'ok';
      }
      if (n.fn === 'every') return Math.floor((env?.now ?? 0) / Math.max(1, num(args[0]) ?? 1)) % 2 === 0;
      return FUNCS[n.fn](...args);
    }
    case 'bin': {
      if (n.op === '&&') { const l = walk(n.l, scope, env); return truthy(l) ? walk(n.r, scope, env) : l; }
      if (n.op === '||') { const l = walk(n.l, scope, env); return truthy(l) ? l : walk(n.r, scope, env); }
      if (n.op === '??') { const l = walk(n.l, scope, env); return l ?? walk(n.r, scope, env); }
      const l = walk(n.l, scope, env);
      const r = walk(n.r, scope, env);
      switch (n.op) {
        case '==': return l === r;
        case '!=': return l !== r;
        case 'in': return Array.isArray(r) ? r.includes(l) : text(r).includes(text(l));
        case '>': return num(l) !== null && num(r) !== null && l > r;
        case '<': return num(l) !== null && num(r) !== null && l < r;
        case '>=': return num(l) !== null && num(r) !== null && l >= r;
        case '<=': return num(l) !== null && num(r) !== null && l <= r;
        case '+':
          if (typeof l === 'string' || typeof r === 'string') return text(l) + text(r);
          return num(l) === null || num(r) === null ? null : l + r;
        case '-': return num(l) === null || num(r) === null ? null : l - r;
        case '*': return num(l) === null || num(r) === null ? null : l * r;
        case '/': return num(l) === null || !num(r) ? null : l / r;
        case '%': return num(l) === null || !num(r) ? null : l % r;
        default: return null;
      }
    }
    default: return null;
  }
}

export function evaluate(src, scope, env) {
  return walk(compile(src), scope, env);
}

// Every dotted path an expression reads, used by `limit-bar validate`.
export function pathsOf(src) {
  const out = [];
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.t === 'path') out.push(n.path.join('.'));
    for (const key of ['cond', 'a', 'b', 'x', 'l', 'r']) visit(n[key]);
    if (n.args) n.args.forEach(visit);
  };
  visit(compile(src));
  return out;
}
