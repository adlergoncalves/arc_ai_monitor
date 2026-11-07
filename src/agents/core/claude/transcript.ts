// Lê um transcript (.jsonl) do Claude Code pelo fim e resume o que o mapa precisa. Transcripts passam de
// dezenas de MB; só o fim interessa, e o resumo fica em cache enquanto o arquivo não muda.
import { open, stat } from 'node:fs/promises';
import { describeTool } from '../describe';

export interface TranscriptSummary {
  /** o título que o Claude Code dá à conversa (registro ai-title) */
  title?: string;
  model?: string;
  contextTokens?: number;
  /** a última ferramenta chamada, descrita; `pending` enquanto o resultado não voltou */
  lastTool?: { id: string; name: string; text: string; at: number; pending: boolean };
  firstAt?: number;
  lastAt?: number;
  /** tool_use_id cujo tool_result veio com is_error */
  errors: Set<string>;
  sends: { to: string; text: string; at: number }[];
  handback: boolean;
}

type Rec = { type?: string; timestamp?: string; aiTitle?: string; message?: { model?: string; usage?: Record<string, number>; content?: unknown } };
type Block = { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean };

export function summarize(records: unknown[]): TranscriptSummary {
  const s: TranscriptSummary = { errors: new Set(), sends: [], handback: false };
  const results = new Set<string>();
  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Rec;
    const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    if (!Number.isNaN(at)) { s.firstAt ??= at; s.lastAt = at; }
    const blocks = Array.isArray(r.message?.content) ? (r.message!.content as Block[]).filter(b => b && typeof b === 'object') : [];
    if (r.type === 'ai-title' && r.aiTitle) s.title = r.aiTitle;
    else if (r.type === 'assistant' && r.message) {
      const m = r.message;
      if (m.model && m.model !== '<synthetic>') s.model = m.model;
      const u = m.usage;
      if (u) s.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
      for (const b of blocks) {
        if (b.type !== 'tool_use' || !b.id || !b.name) continue;
        if (b.name === 'SubagentHandback') { s.handback = true; continue; }
        s.lastTool = { id: b.id, name: b.name, text: describeTool(b.name, b.input), at, pending: true };
        if (b.name === 'SendMessage') {
          const to = typeof b.input?.to === 'string' ? b.input.to : '';
          const msg = b.input?.summary ?? b.input?.message;
          if (to) s.sends.push({ to, text: typeof msg === 'string' ? msg : '', at });
        }
      }
    } else if (r.type === 'user') {
      for (const b of blocks) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue;
        results.add(b.tool_use_id);
        if (b.is_error) s.errors.add(b.tool_use_id);
      }
    }
  }
  if (s.lastTool) s.lastTool.pending = !results.has(s.lastTool.id);
  return s;
}

/** As linhas inteiras dos últimos `maxBytes` do arquivo, já como JSON; linha que não parseia é ignorada. */
export async function readTail(file: string, maxBytes: number): Promise<unknown[]> {
  const { size } = await stat(file);
  const start = Math.max(0, size - maxBytes), len = size - start, fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // a primeira linha veio cortada
    const out: unknown[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* linha sendo escrita agora */ }
    }
    return out;
  } finally { await fh.close(); }
}

const cache = new Map<string, { size: number; mtime: number; summary: TranscriptSummary }>();
export async function summarizeFile(file: string, maxBytes = 1_500_000): Promise<{ summary: TranscriptSummary; mtime: number } | undefined> {
  let st;
  try { st = await stat(file); } catch { return undefined; }
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return { summary: hit.summary, mtime: st.mtimeMs };
  let summary: TranscriptSummary;
  try { summary = summarize(await readTail(file, maxBytes)); } catch { return undefined; } // apagado entre o stat e o open
  cache.set(file, { size: st.size, mtime: st.mtimeMs, summary });
  return { summary, mtime: st.mtimeMs };
}
