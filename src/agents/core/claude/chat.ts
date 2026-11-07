// Mini chat de uma sessão: lê a conversa recente do transcript e manda mensagem pelo canal entre sessões.
// O canal é o mesmo do SendMessage do Claude Code: o pipe `messagingSocketPath` da sessão, JSON por linha,
// a primeira linha autenticando com o `peerToken` que a sessão publica em ~/.claude/sessions/<pid>.*.key.
// A sessão recebe como mensagem de outro agente (origem "peer"), não como se a pessoa tivesse digitado nela.
import { readdir, readFile, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { readTail } from './transcript';

export interface ChatMessage { role: 'user' | 'assistant'; text: string; at: number; peer?: true }

type Rec = { type?: string; isMeta?: boolean; timestamp?: string; origin?: { kind?: string }; message?: { content?: unknown } };
type Block = { type?: string; text?: string };

/**
 * Vai na frente de toda mensagem do mini chat. O canal não diz quem mandou, e a sessão, sem saber, responde
 * por SendMessage a uma sessão qualquer. Não pede autoridade: a sessão continua tratando como mensagem de fora.
 */
export const PANEL_NOTE = '[Enviada pelo painel de agentes do Arc AI Monitor (extensão do VS Code), pela pessoa que acompanha esta sessão, não por outra sessão do Claude. Responda aqui na conversa, não por SendMessage.]';

/** O aviso que a extensão Mission Control (antes de vir para o monitor) gravou nas conversas; continua sendo tirado ao mostrar. */
const LEGACY_NOTE = '[Enviada pelo painel do Mission Control (extensão do VS Code), pela pessoa que acompanha esta sessão, não por outra sessão do Claude. Responda aqui na conversa, não por SendMessage.]';

// a mensagem entre sessões entra no transcript como meta, embrulhada no aviso do Claude Code e, quando há
// remetente, numa tag <cross-session-message>; o mini chat mostra só o que foi enviado
function unwrapPeer(text: string) {
  let t = text.replace(/^Another Claude session sent a message:\n/, '');
  const end = t.indexOf('\n\nThis came from another Claude session');
  if (end >= 0) t = t.slice(0, end);
  t = t.replace(/^\s*<cross-session-message\b[^>]*>([\s\S]*?)<\/cross-session-message>\s*$/, '$1');
  const note = [PANEL_NOTE, LEGACY_NOTE].find(n => t.startsWith(n));
  return note ? t.slice(note.length) : t;
}

export function recentMessages(records: unknown[], n: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Rec, peer = r.origin?.kind === 'peer';
    if ((r.type !== 'user' && r.type !== 'assistant') || (r.isMeta && !peer)) continue;
    const c = r.message?.content;
    const body = typeof c === 'string' ? c
      : Array.isArray(c) ? (c as Block[]).filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
    const text = peer ? unwrapPeer(body) : body;
    if (!text.trim()) continue; // resultado de ferramenta, pensamento e chamada de ferramenta não entram
    const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    out.push({ role: r.type, text: text.trim(), at: Number.isNaN(at) ? 0 : at, ...(peer && { peer: true as const }) });
  }
  return out.slice(-n);
}

// sessão que usa muita ferramenta tem pouco texto no fim do arquivo: a leitura cresce (×4) até achar as N
// mensagens, chegar ao começo ou ao teto. O painel pede a cada 3 s; arquivo do mesmo tamanho sai do cache.
const loaded = new Map<string, { size: number; n: number; msgs: ChatMessage[] }>();
export async function loadRecentMessages(file: string, n: number, firstBytes = 600_000, maxBytes = 10_000_000): Promise<ChatMessage[]> {
  const { size } = await stat(file);
  const hit = loaded.get(file);
  if (hit && hit.size === size && hit.n === n) return hit.msgs;
  let msgs: ChatMessage[] = [];
  for (let b = firstBytes; ; b *= 4) {
    msgs = recentMessages(await readTail(file, b), n);
    if (msgs.length >= n || b >= size || b >= maxBytes) break;
  }
  loaded.set(file, { size, n, msgs });
  return msgs;
}

async function peerToken(sessionsDir: string, pid: number): Promise<string | undefined> {
  let names: string[];
  try { names = await readdir(sessionsDir); } catch { return undefined; }
  for (const n of names.filter(n => n.startsWith(`${pid}.`) && n.endsWith('.key'))) {
    try { const k = JSON.parse(await readFile(join(sessionsDir, n), 'utf8')); if (typeof k?.peerToken === 'string') return k.peerToken; } catch { /* sendo reescrita */ }
  }
  return undefined;
}

export async function sendToSession(o: { sessionsDir: string; pid: number; socketPath: string; text: string }): Promise<void> {
  const text = o.text.trim();
  if (!text) throw new Error('mensagem vazia');
  const token = await peerToken(o.sessionsDir, o.pid);
  if (!token) throw new Error('a sessão não publicou a chave do canal de mensagens');
  const lines = JSON.stringify({ type: 'auth', token }) + '\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: `${PANEL_NOTE}\n\n${text}` } }) + '\n';
  await new Promise<void>((ok, fail) => {
    const c = connect(o.socketPath);
    const timer = setTimeout(() => { c.destroy(); fail(new Error('a sessão não respondeu no canal de mensagens')); }, 5000);
    c.on('connect', () => c.end(lines));
    c.on('error', e => { clearTimeout(timer); fail(e); });
    c.on('close', hadError => { clearTimeout(timer); if (!hadError) ok(); });
  });
}
