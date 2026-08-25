import * as os from 'os';
import * as path from 'path';

export const HOME = os.homedir();
export const CLAUDE_DIR = path.join(HOME, '.claude');
export const SESS_DIR = path.join(CLAUDE_DIR, 'sessions');
export const PROJ_DIR = path.join(CLAUDE_DIR, 'projects');
/** cache que o proprio Claude Code grava (mesmos numeros do /usage) */
export const CONFIG_FILE = path.join(HOME, '.claude.json');
/** token OAuth mantido pelo Claude Code. Somente leitura, nunca reescrito. */
export const CREDS_FILE = path.join(CLAUDE_DIR, '.credentials.json');
/** cache de cota compartilhado entre as janelas do VS Code */
export const QUOTA_CACHE = path.join(CLAUDE_DIR, '.monitor-quota.json');
export const QUOTA_LOCK = path.join(CLAUDE_DIR, '.monitor-quota.lock');

/** settings do Claude Code — o bloco `env` carrega a configuracao OTel */
export const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
