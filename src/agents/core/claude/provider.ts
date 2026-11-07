// Provedor Claude Code: sessões vivas, com modelo, contexto, ação atual, subagentes e mensagens entre elas.
import { join } from 'node:path';
import type { MessageView, SessionView } from '../types';
import { findTranscriptDir } from './paths';
import { displayName, readSessionRecords, toState, type SessionRecord } from './sessions';
import { readSubagents } from './subagents';
import { summarizeFile } from './transcript';

export interface ClaudeOptions { home: string; now: number; recentSubagentMs: number; recentMessageMs: number }

// SendMessage endereça a outra sessão pelo socket dela ("uds:\\.\pipe\LOCAL\cc-msg-…") ou pelo nome
const sockKey = (s: string) => s.replace(/^uds:/, '').replace(/\\\\/g, '\\').toLowerCase();

export async function collectClaude(o: ClaudeOptions): Promise<{ sessions: SessionView[]; messages: MessageView[] }> {
  const records = await readSessionRecords(join(o.home, 'sessions'));
  const projects = join(o.home, 'projects');
  const sends: { from: string; to: string; text: string; at: number }[] = [];

  const sessions = await Promise.all(records.map(async (r: SessionRecord): Promise<SessionView> => {
    // o que falhar ao ler o transcript de uma sessão tira só o detalhe dela, nunca o mapa
    const dir = await findTranscriptDir(projects, r.cwd, r.sessionId).catch(() => undefined);
    const file = dir ? await summarizeFile(join(dir, `${r.sessionId}.jsonl`)).catch(() => undefined) : undefined;
    const t = file?.summary;
    const subagents = dir && t ? await readSubagents(join(dir, r.sessionId, 'subagents'), t, { now: o.now, recentMs: o.recentSubagentMs, staleMs: 20 * 60_000 }).catch(() => []) : [];
    for (const m of t?.sends ?? []) if (o.now - m.at <= o.recentMessageMs) sends.push({ from: r.sessionId, ...m });
    const state = toState(r.status);
    return {
      provider: 'claude', id: r.sessionId, pid: r.pid, name: displayName(r, t?.title), cwd: r.cwd, entrypoint: r.entrypoint,
      state, waitingFor: state === 'waiting' ? r.waitingFor : undefined, needs: state === 'waiting' ? r.needs : undefined,
      since: r.statusUpdatedAt ?? r.startedAt ?? o.now, startedAt: r.startedAt,
      model: t?.model, contextTokens: t?.contextTokens, activity: t?.lastTool?.text, subagents,
      socket: r.messagingSocketPath, transcript: dir ? join(dir, `${r.sessionId}.jsonl`) : undefined,
    };
  }));

  const bySock = new Map(records.filter(r => r.messagingSocketPath).map(r => [sockKey(r.messagingSocketPath!), r.sessionId]));
  const byName = new Map(records.filter(r => r.name).map(r => [r.name!.toLowerCase(), r.sessionId]));
  const messages = sends.flatMap(m => {
    const to = bySock.get(sockKey(m.to)) ?? byName.get(m.to.toLowerCase());
    return to && to !== m.from ? [{ from: m.from, to, at: m.at, text: m.text }] : [];
  });
  return { sessions, messages };
}
