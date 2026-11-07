// O registro de sessões vivas do Claude Code: ~/.claude/sessions/<pid>.json, um por processo, apagado
// quando a sessão sai. `status` é busy | idle | waiting; em waiting, `waitingFor` diz o motivo.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionState } from '../types';

export interface SessionRecord {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  /** "derived" quando o Claude Code inventou o nome a partir da pasta ("feira-principal-ca") */
  nameSource?: string;
  status?: string;
  waitingFor?: string;
  needs?: string;
  statusUpdatedAt?: number;
  startedAt?: number;
  kind?: string;
  entrypoint?: string;
  messagingSocketPath?: string;
}

const KINDS = new Set(['interactive', 'bg']);

export function parseSessionRecord(raw: unknown): SessionRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.pid !== 'number' || typeof o.sessionId !== 'string' || typeof o.cwd !== 'string') return undefined;
  if (typeof o.kind === 'string' && !KINDS.has(o.kind)) return undefined;
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const n = (k: string) => (typeof o[k] === 'number' ? (o[k] as number) : undefined);
  return {
    pid: o.pid, sessionId: o.sessionId, cwd: o.cwd,
    name: s('name'), nameSource: s('nameSource'), status: s('status'), waitingFor: s('waitingFor'), needs: s('needs'), kind: s('kind'), entrypoint: s('entrypoint'), messagingSocketPath: s('messagingSocketPath'),
    statusUpdatedAt: n('statusUpdatedAt'), startedAt: n('startedAt'),
  };
}

/** O nome que a pessoa deu (`claude -n`) vale; o derivado da pasta não diz nada e perde para o título da conversa. */
export const displayName = (r: SessionRecord, title: string | undefined) =>
  (r.nameSource === 'derived' || !r.name) && title ? title : r.name || r.sessionId.slice(0, 8);

export const toState = (status: string | undefined): SessionState => (status === 'busy' ? 'working' : status === 'waiting' ? 'waiting' : 'idle');

/** O arquivo some quando a sessão sai, mas um processo morto à força deixa o registro para trás. */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export async function readSessionRecords(dir: string, alive: (pid: number) => boolean = isAlive): Promise<SessionRecord[]> {
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const out: SessionRecord[] = [];
  await Promise.all(names.filter(n => n.endsWith('.json')).map(async n => {
    try {
      const r = parseSessionRecord(JSON.parse(await readFile(join(dir, n), 'utf8')));
      if (r && alive(r.pid)) out.push(r);
    } catch { /* registro sendo reescrito agora: entra na próxima leitura */ }
  }));
  return out.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}
