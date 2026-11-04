import os from 'node:os';
import path from 'node:path';

const home = () => os.homedir();

export const configDir = (env = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(home(), '.config'), 'limit-bar');
export const cacheDir = (env = process.env) => env.LIMITBAR_CACHE_DIR || path.join(env.XDG_CACHE_HOME || path.join(home(), '.cache'), 'limit-bar');
export const stateDir = (env = process.env) => path.join(env.XDG_STATE_HOME || path.join(home(), '.local', 'state'), 'limit-bar');
export const dataDir = (env = process.env) => path.join(env.XDG_DATA_HOME || path.join(home(), '.local', 'share'), 'limit-bar');
export const claudeDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude');
