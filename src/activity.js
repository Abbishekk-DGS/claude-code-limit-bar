// What the session has been doing, read from its transcript: the running tool, the
// todo list, subagents, and session totals. Only the bytes added since the last tick
// are read, and the running totals are cached, so a long session costs no more than
// a short one. The transcript format is not a public contract, so any surprise here
// just yields empty values.

import fs from 'node:fs';
import path from 'node:path';
import { readJson, sha, writeAtomic } from './fsutil.js';

const MAX_READ_BYTES = 16 * 1024 * 1024;
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const STATE_VERSION = 2;

export const emptyStats = () => ({ turns: 0, messages: 0, tools: 0, top_tool: null, top_tool_count: 0, compactions: 0, last_turn: null, skills: 0, last_skill: null, mcp: 0, agents_spawned: 0, output_tokens: 0 });

const blank = () => ({ offset: 0, open: {}, todos: null, counts: {}, skills: [], lastSkill: null, servers: [], spawned: 0, compactions: 0, turns: 0, messages: 0, lastTurn: null, pending: 0, asyncSeen: false, bg: [], output: 0, msgOut: {} });

function targetOf(input) {
  if (!input || typeof input !== 'object') return null;
  const file = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof file === 'string') return file.split(/[/\\]/).pop();
  // A command shows its program. Its description is free text and could say anything.
  if (typeof input.command === 'string') return input.command.trim().split(/\s+/)[0];
  for (const key of ['description', 'pattern', 'query', 'skill', 'url']) {
    if (typeof input[key] === 'string') return input[key];
  }
  return null;
}

const INTERESTING = ['"tool_use"', '"tool_result"', '"turn_duration"', '"compact_boundary"', '"output_tokens"', '"queue-operation"'];

function applyRecord(state, rec) {
  if (rec?.isSidechain === true) return;
  // A background agent is done once its completion notice arrives. A notice can
  // repeat, and removing an id twice is harmless.
  if (rec?.type === 'queue-operation') {
    if (rec.operation === 'enqueue' && typeof rec.content === 'string' && rec.content.startsWith('<task-notification>')) {
      const id = /<task-id>([^<]+)<\/task-id>/.exec(rec.content)?.[1];
      if (id) state.bg = state.bg.filter((x) => x !== id);
    }
    return;
  }
  if (rec?.type === 'system') {
    if (rec.subtype === 'compact_boundary') state.compactions++;
    if (rec.subtype === 'turn_duration') {
      state.turns++;
      if (typeof rec.durationMs === 'number') state.lastTurn = rec.durationMs / 1000;
      if (typeof rec.messageCount === 'number') state.messages = rec.messageCount;
      state.pending = typeof rec.pendingBackgroundAgentCount === 'number' ? rec.pendingBackgroundAgentCount : 0;
      if (state.pending === 0) state.bg = [];
      // The turn is over, so an interrupted tool never reports back. Forget it.
      state.open = {};
    }
    return;
  }
  // Other record types can repeat a tool call, for example request logs.
  if (rec?.type !== 'assistant' && rec?.type !== 'user') return;
  if (rec.type === 'user' && rec.toolUseResult?.status === 'async_launched' && typeof rec.toolUseResult.agentId === 'string') {
    state.asyncSeen = true;
    if (!state.bg.includes(rec.toolUseResult.agentId)) state.bg.push(rec.toolUseResult.agentId);
  }
  // A long reply is written in several records that share one id, each with the
  // running total, so only the growth is added.
  const message = rec.message;
  const used = message?.usage?.output_tokens;
  if (rec.type === 'assistant' && typeof message?.id === 'string' && typeof used === 'number') {
    state.output += Math.max(0, used - (state.msgOut[message.id] ?? 0));
    state.msgOut = { ...Object.fromEntries(Object.entries(state.msgOut).slice(-7)), [message.id]: used };
  }
  const content = message?.content;
  if (!Array.isArray(content)) return;
  const at = Date.parse(rec.timestamp);
  for (const block of content) {
    if (block?.type === 'tool_use' && typeof block.name === 'string') {
      state.open[block.id] = { name: block.name, target: targetOf(block.input), at: Number.isFinite(at) ? at / 1000 : null };
      state.counts[block.name] = (state.counts[block.name] ?? 0) + 1;
      if (AGENT_TOOLS.has(block.name)) state.spawned++;
      if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) state.todos = block.input.todos;
      if (block.name === 'Skill' && typeof block.input?.skill === 'string') {
        state.lastSkill = block.input.skill;
        if (!state.skills.includes(block.input.skill)) state.skills.push(block.input.skill);
      }
      const server = /^mcp__(.+?)__/.exec(block.name)?.[1];
      if (server && !state.servers.includes(server)) state.servers.push(server);
    } else if (block?.type === 'tool_result') {
      delete state.open[block.tool_use_id];
    }
  }
}

function readNew(file, state) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    if (size < state.offset) Object.assign(state, blank());
    if (size === state.offset) return false;
    // A huge transcript seen for the first time is read from its recent end.
    const start = Math.max(state.offset, size - MAX_READ_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    // Stop at the last full line. A half-written one is picked up next tick.
    const end = buf.lastIndexOf(10);
    if (end < 0) return false;
    let text = buf.subarray(0, end).toString('utf8');
    if (start > state.offset) text = text.slice(text.indexOf('\n') + 1);
    state.offset = start + end + 1;
    for (const line of text.split('\n')) {
      if (!INTERESTING.some((k) => line.includes(k))) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      applyRecord(state, rec);
    }
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

function view(state, now) {
  const running = Object.values(state.open);
  const last = running[running.length - 1];
  const agentsRunning = running.filter((t) => AGENT_TOOLS.has(t.name)).length;
  const top = Object.entries(state.counts).sort((a, b) => b[1] - a[1])[0];
  const todos = state.todos;
  const done = todos ? todos.filter((t) => t?.status === 'completed').length : 0;
  const current = todos?.find((t) => t?.status === 'in_progress');
  return {
    tool: {
      active: last?.name ?? null,
      target: last?.target ?? null,
      running: running.length,
      agents: agentsRunning,
      elapsed: last?.at ? Math.max(0, now - last.at) : null,
    },
    todo: {
      done,
      total: todos?.length ?? 0,
      current: current?.activeForm ?? current?.content ?? null,
      pct: todos?.length ? (done / todos.length) * 100 : null,
    },
    agents: { running: agentsRunning, background: state.asyncSeen ? state.bg.length : state.pending, spawned: state.spawned },
    stats: {
      turns: state.turns,
      messages: state.messages,
      tools: Object.values(state.counts).reduce((a, b) => a + b, 0),
      top_tool: top?.[0] ?? null,
      top_tool_count: top?.[1] ?? 0,
      compactions: state.compactions,
      last_turn: state.lastTurn,
      skills: state.skills.length,
      last_skill: state.lastSkill,
      mcp: state.servers.length,
      agents_spawned: state.spawned,
      output_tokens: state.output,
    },
  };
}

export function readActivity(transcriptPath, { now = Date.now() / 1000, cacheDir } = {}) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return view(blank(), now);
  // The version is part of the name, so totals from an older reader are never reused.
  const cacheFile = cacheDir ? path.join(cacheDir, 'activity', `${STATE_VERSION}-${sha(transcriptPath).slice(0, 24)}.json`) : null;
  const state = { ...blank(), ...(cacheFile ? readJson(cacheFile) : null) };
  try {
    if (readNew(transcriptPath, state) && cacheFile) writeAtomic(cacheFile, JSON.stringify(state));
  } catch {
    return view(blank(), now);
  }
  return view(state, now);
}
