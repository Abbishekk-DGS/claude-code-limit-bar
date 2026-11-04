#!/usr/bin/env node
// Render path first: this runs on every status line tick, so nothing but the
// renderer is loaded unless a subcommand was asked for.
import module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { renderBar, renderSubagents } from '../src/render.js';
import { cacheDir } from '../src/paths.js';
import { writeAtomic } from '../src/fsutil.js';

module.enableCompileCache?.(path.join(cacheDir(), 'v8'));

const args = process.argv.slice(2);

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

if (args[0] === 'render' || (args.length === 0 && !process.stdin.isTTY)) {
  const text = readStdin();
  let input = {};
  try { input = JSON.parse(text || '{}'); } catch { input = {}; }
  try {
    const { text: out } = renderBar(input);
    // `limit-bar explain` and `limit-bar fields` replay the last real payload.
    if (text && process.env.LIMITBAR_NO_CAPTURE !== '1') writeAtomic(path.join(cacheDir(), 'last.json'), text);
    process.stdout.write(`${out}\n`);
  } catch (e) {
    process.stdout.write(`${String(e.message).split('\n')[0]}\n`);
  }
} else if (args[0] === 'subagent') {
  // Any failure prints nothing, which keeps Claude Code's own row for that agent.
  try {
    const rows = renderSubagents(JSON.parse(readStdin() || '{}'));
    if (rows.length) process.stdout.write(`${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  } catch { /* default rows stay */ }
} else {
  const { runCli } = await import('../src/cli.js');
  process.exitCode = await runCli(args);
}
