// A small per-session sample log. It gives templates sparklines, burn rates and
// time-to-full estimates, which single-shot status lines cannot compute.

import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeAtomic, sha } from './fsutil.js';
import { cacheDir as defaultCache } from './paths.js';

const MAX_SAMPLES = 240;
const MIN_GAP_SECONDS = 5;
const RATE_WINDOW_SECONDS = 15 * 60;
const MIN_SPAN_SECONDS = 60;
const STALE_DAYS = 14;

// Least-squares slope in units per second. Restarts after a drop, because a
// falling series means /compact or a window reset, not negative burn.
export function slope(samples, key, now, windowSec = RATE_WINDOW_SECONDS) {
  const recent = samples.filter((s) => typeof s[key] === 'number' && now - s.t <= windowSec);
  let start = 0;
  for (let i = 1; i < recent.length; i++) if (recent[i][key] < recent[i - 1][key] - 0.5) start = i;
  const pts = recent.slice(start);
  if (pts.length < 3) return null;
  const span = pts[pts.length - 1].t - pts[0].t;
  if (span < MIN_SPAN_SECONDS) return null;
  const mt = pts.reduce((a, s) => a + s.t, 0) / pts.length;
  const mv = pts.reduce((a, s) => a + s[key], 0) / pts.length;
  let num = 0;
  let den = 0;
  for (const s of pts) { num += (s.t - mt) * (s[key] - mv); den += (s.t - mt) ** 2; }
  return den ? num / den : null;
}

function prune(dir, now) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const f = path.join(dir, name);
      if (now * 1000 - fs.statSync(f).mtimeMs > STALE_DAYS * 86400000) fs.unlinkSync(f);
    }
  } catch { /* best effort */ }
}

export function deriveHistory(samples, now, limit = 100, currentPct = null) {
  const col = (k) => samples.map((s) => s[k]).filter((v) => typeof v === 'number');
  const series = { ctx: col('ctx'), cost: col('cost'), h5: col('h5'), d7: col('d7'), tokens: col('tok') };
  const perSec = { ctx: slope(samples, 'ctx', now), cost: slope(samples, 'cost', now), h5: slope(samples, 'h5', now), tok: slope(samples, 'tok', now) };
  const rate = {
    ctx_per_min: perSec.ctx !== null ? perSec.ctx * 60 : null,
    cost_per_hour: perSec.cost !== null ? Math.max(0, perSec.cost) * 3600 : null,
    h5_per_hour: perSec.h5 !== null ? perSec.h5 * 3600 : null,
    tokens_per_min: perSec.tok !== null ? perSec.tok * 60 : null,
  };
  const eta = { ctx: null };
  if (perSec.ctx > 0 && typeof currentPct === 'number' && currentPct < limit) eta.ctx = (limit - currentPct) / perSec.ctx;
  return { series, rate, eta };
}

export function openHistory(scope, { now, cacheDir, limit = 100 }) {
  const id = scope.session?.id;
  if (!id) return deriveHistory([], now, limit);
  const dir = path.join(cacheDir ?? defaultCache(), 'history');
  const file = path.join(dir, `${sha(id).slice(0, 24)}.json`);
  const existing = readJson(file);
  const isNew = !existing;
  let samples = Array.isArray(existing?.samples) ? existing.samples : [];
  const sample = { t: now };
  if (typeof scope.ctx?.pct === 'number') sample.ctx = Number(scope.ctx.pct.toFixed(2));
  if (typeof scope.ctx?.tokens === 'number') sample.tok = scope.ctx.tokens;
  if (typeof scope.cost?.usd === 'number') sample.cost = Number(scope.cost.usd.toFixed(4));
  if (typeof scope.limit?.h5?.pct === 'number') sample.h5 = scope.limit.h5.pct;
  if (typeof scope.limit?.d7?.pct === 'number') sample.d7 = scope.limit.d7.pct;
  const last = samples[samples.length - 1];
  if (!last || now - last.t >= MIN_GAP_SECONDS) {
    samples = [...samples, sample].slice(-MAX_SAMPLES);
    writeAtomic(file, JSON.stringify({ samples }));
    if (isNew) prune(dir, now);
  }
  return deriveHistory(samples, now, limit, scope.ctx?.pct ?? null);
}
