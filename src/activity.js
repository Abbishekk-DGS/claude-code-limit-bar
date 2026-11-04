// Best-effort read of the end of the session transcript: which tool is running
// and the current todo list. The transcript format is not a public contract, so
// any surprise here just yields empty values.

import fs from 'node:fs';

const TAIL_BYTES = 256 * 1024;
const EMPTY = () => ({
  tool: { active: null, target: null, running: 0, agents: 0 },
  todo: { done: 0, total: 0, current: null, pct: null },
});

function targetOf(input) {
  if (!input || typeof input !== 'object') return null;
  const file = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof file === 'string') return file.split(/[/\\]/).pop();
  for (const key of ['description', 'pattern', 'query', 'skill', 'url']) {
    if (typeof input[key] === 'string') return input[key];
  }
  if (typeof input.command === 'string') return input.command.trim().split(/\s+/)[0];
  return null;
}

export function readActivity(transcriptPath) {
  const out = EMPTY();
  if (typeof transcriptPath !== 'string' || !transcriptPath) return out;
  let text;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
      if (size > len) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return out;
  }
  const open = new Map();
  let todos = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use') {
        open.set(block.id, block);
        if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) todos = block.input.todos;
      } else if (block?.type === 'tool_result') {
        open.delete(block.tool_use_id);
      }
    }
  }
  const running = [...open.values()];
  if (running.length) {
    const last = running[running.length - 1];
    out.tool = {
      active: typeof last.name === 'string' ? last.name : null,
      target: targetOf(last.input),
      running: running.length,
      agents: running.filter((b) => b.name === 'Agent' || b.name === 'Task').length,
    };
  }
  if (todos) {
    const done = todos.filter((t) => t?.status === 'completed').length;
    const current = todos.find((t) => t?.status === 'in_progress');
    out.todo = {
      done,
      total: todos.length,
      current: current?.activeForm ?? current?.content ?? null,
      pct: todos.length ? (done / todos.length) * 100 : null,
    };
  }
  return out;
}
