// Subagentes de uma sessão: <pasta do projeto>/<sessionId>/subagents/agent-<id>.meta.json + .jsonl.
// O meta diz tipo, descrição e se terminou (`finished`); o .jsonl, o que está fazendo.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SubagentState, SubagentView } from '../types';
import { summarizeFile, type TranscriptSummary } from './transcript';

export interface SubagentMeta { agentType?: string; description?: string; toolUseId?: string; finished?: boolean }

/** Falhou quando o tool_use que o lançou voltou com erro; terminou quando o meta diz ou quando ele fez o handback. */
export function subagentState(meta: SubagentMeta, own: TranscriptSummary | undefined, parent: TranscriptSummary | undefined): SubagentState {
  if (meta.toolUseId && parent?.errors.has(meta.toolUseId)) return 'failed';
  if (meta.finished || own?.handback) return 'done';
  return 'working';
}

export interface SubagentWindow {
  now: number;
  /** concluído ou com falha continua no mapa por este tempo */
  recentMs: number;
  /** "trabalhando" sem escrever nada há mais que isso é processo que morreu: sai do mapa */
  staleMs: number;
}

export async function readSubagents(dir: string, parent: TranscriptSummary | undefined, w: SubagentWindow): Promise<SubagentView[]> {
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const out: SubagentView[] = [];
  await Promise.all(names.filter(n => n.endsWith('.meta.json')).map(async n => {
    const id = n.slice(0, -'.meta.json'.length);
    let meta: SubagentMeta;
    try { meta = JSON.parse(await readFile(join(dir, n), 'utf8')); } catch { return; }
    if (!meta || typeof meta !== 'object') return;
    const file = await summarizeFile(join(dir, `${id}.jsonl`), 400_000);
    const own = file?.summary, lastWrite = file?.mtime ?? 0;
    const state = subagentState(meta, own, parent);
    const endedAt = state === 'working' ? undefined : own?.lastAt ?? lastWrite;
    if (state === 'working' && w.now - lastWrite > w.staleMs) return;
    if (state !== 'working' && w.now - (endedAt ?? 0) > w.recentMs) return;
    out.push({
      id: id.replace(/^agent-/, ''), description: meta.description || id, type: meta.agentType || 'agent', state,
      startedAt: own?.firstAt, endedAt, activity: state === 'done' && own?.handback ? 'devolveu o resultado' : own?.lastTool?.text,
    });
  }));
  return out.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}
