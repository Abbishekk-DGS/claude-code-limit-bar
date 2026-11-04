import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NOW = 1800000000;

export function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-bar-test-'));
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    XDG_CACHE_HOME: path.join(dir, 'cache'),
    XDG_STATE_HOME: path.join(dir, 'state'),
    XDG_DATA_HOME: path.join(dir, 'data'),
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'),
    COLORTERM: 'truecolor',
  };
  return { dir, env, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function writeConfig(env, text, name = 'config.toml') {
  const file = path.join(env.XDG_CONFIG_HOME, 'limit-bar', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '');
