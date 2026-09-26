/** Leitura local dos registros JSONL que o Codex grava em ~/.codex/sessions. */
import * as fs from 'fs/promises';
import { Dirent } from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { CODEX_DIR } from './paths';
import { Bucket, HistorySnapshot, SessionCard } from './types';

interface CodexFile {
  /** bytes ja consumidos: so o trecho novo e lido no proximo poll */
  off: number;
  mtimeMs: number;
  session?: { id: string; cwd: string; model: string; started?: string };
  /** o que as contas usam: `records` quando o Codex grava token_usage_record, senao `fallback` */
  entries: UsageEntry[];
  records: UsageEntry[];
  fallback: UsageEntry[];
  seen: Set<string>;
  /** estado que atravessa as fatias: o turno e o modelo vem de linhas anteriores */
  model: string;
  turnId: string;
  lastActivity: number;
  contextMax?: number;
  /** ultimo retrato de cota que o servidor devolveu num turno deste arquivo */
  limits?: LimitSnapshot;
}

export interface LimitSnapshot {
  at: number;
  /** o mesmo formato do app-server (snake_case), um por balde */
  row: Record<string, unknown>;
}

interface UsageEntry {
  at: number;
  i: number;
  o: number;
  cw: number;
  cr: number;
  total: number;
  model: string;
  turnId: string;
}

export interface CodexUsage {
  sessions: SessionCard[];
  history: HistorySnapshot;
  day: {
    i: number; o: number; cw: number; cr: number; total: number; turns: number;
    models: Map<string, number>; hours: Map<number, number>;
  };
  /** retrato de cota mais novo de cada balde, entre todos os registros */
  limits: LimitSnapshot[];
}

export class CodexUsageReader {
  private files = new Map<string, CodexFile>();

  async read(today: string, workspaceDirs: string[], historyDays: number, now = Date.now()): Promise<CodexUsage> {
    const paths = await listFiles(path.join(CODEX_DIR, 'sessions'));
    const seen = new Set(paths);
    for (const p of paths) {
      let rec = this.files.get(p);
      if (!rec) {
        rec = emptyFile();
        this.files.set(p, rec);
      }
      await scanFile(p, rec);
    }
    for (const p of this.files.keys()) if (!seen.has(p)) this.files.delete(p);

    const limits = new Map<string, LimitSnapshot>();
    for (const record of this.files.values()) {
      const snap = record.limits;
      if (!snap) continue;
      const id = String(snap.row.limit_id ?? snap.row.limitId ?? 'codex');
      const prior = limits.get(id);
      if (!prior || snap.at > prior.at) limits.set(id, snap);
    }

    const day = {
      i: 0, o: 0, cw: 0, cr: 0, total: 0, turns: 0,
      models: new Map<string, number>(), hours: new Map<number, number>(),
    };
    const sessions: SessionCard[] = [];
    const history = aggregateHistory(this.files.values(), historyDays, now);
    const todayTurns = new Set<string>();
    for (const record of this.files.values()) {
      const last = record.entries.at(-1);
      for (const entry of record.entries) {
        if (localDay(new Date(entry.at)) !== today) continue;
        day.i += entry.i; day.o += entry.o; day.cw += entry.cw; day.cr += entry.cr; day.total += entry.total;
        todayTurns.add(`${record.session?.id || ''}:${entry.turnId}`);
        day.hours.set(new Date(entry.at).getHours(), (day.hours.get(new Date(entry.at).getHours()) ?? 0) + entry.o);
        day.models.set(entry.model, (day.models.get(entry.model) ?? 0) + entry.o);
      }
      // Não há PID de sessão no Codex. Um JSONL alterado nos últimos 10 min
      // representa uma conversa em atividade e entra no mesmo cartão visual.
      const idle = Math.max(0, Math.floor((now - record.lastActivity) / 1000));
      if (!record.session || idle > 600) continue;
      const cwd = record.session.cwd;
      const turns = new Set(record.entries.map((entry) => entry.turnId)).size;
      sessions.push({
        pid: 0,
        sid: record.session.id,
        short: record.session.id.slice(0, 8),
        name: record.session.id.slice(0, 8),
        provider: 'codex',
        product: path.basename(cwd) || 'Codex',
        cwd_full: cwd,
        started: record.session.started ? new Date(record.session.started).toTimeString().slice(0, 5) : undefined,
        // o provider ja vem em `provider`; repetir "Codex ·" aqui duplicava o rotulo
        model: record.session.model || '?',
        output: record.entries.reduce((sum, item) => sum + item.o, 0),
        context: last ? last.i + last.cr + last.cw : 0,
        context_max: record.contextMax,
        cost: 0,
        turns,
        idle,
        here: cwd !== '' && workspaceDirs.includes(normDir(cwd)),
        subagents: 0,
        sub_output: 0,
      });
    }
    day.turns = todayTurns.size;
    return { sessions, day, history, limits: [...limits.values()] };
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries: Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 4) await walk(target, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(target);
    }
  }
  await walk(root, 0);
  return out;
}

const NL = 0x0a;
/** tamanho da fatia de leitura — o pico de memoria fica preso a ele */
const READ_CHUNK = 1024 * 1024;

function emptyFile(): CodexFile {
  return {
    off: 0, mtimeMs: 0, entries: [], records: [], fallback: [], seen: new Set(),
    model: '', turnId: '', lastActivity: 0,
  };
}

/**
 * Leitura INCREMENTAL, no mesmo molde dos transcripts do Claude: guarda o
 * offset em bytes e decodifica so o que foi acrescentado. Um log de sessao
 * longa passa de dezenas de MB e muda a cada turno — reler inteiro a cada
 * poll alocaria o arquivo todo dentro do extension host.
 */
async function scanFile(p: string, rec: CodexFile): Promise<void> {
  let st;
  try { st = await fs.stat(p); } catch { return; }
  rec.lastActivity = st.mtimeMs;
  // arquivo truncado ou reescrito: recomeca do zero
  if (st.size < rec.off) Object.assign(rec, emptyFile(), { lastActivity: st.mtimeMs });
  if (st.size === rec.off) {
    rec.mtimeMs = st.mtimeMs;
    return;
  }

  // O StringDecoder segura sequencia UTF-8 partida na borda da fatia; o
  // offset e contado em BYTES, pelo ultimo \n visto.
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let pos = rec.off;
  let lastNl = -1;
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(p, 'r');
    const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, st.size - pos));
    while (pos < st.size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - pos), pos);
      if (bytesRead <= 0) break;
      const nl = buf.lastIndexOf(NL, bytesRead - 1);
      if (nl !== -1) lastNl = pos + nl + 1;
      pos += bytesRead;
      carry += decoder.write(buf.subarray(0, bytesRead));
      const lines = carry.split('\n');
      // a ultima pode estar sendo escrita agora: fica para a proxima leitura
      carry = lines.pop() ?? '';
      for (const line of lines) handleLine(line, rec, p);
    }
  } catch {
    return;
  } finally {
    await fh?.close().catch(() => undefined);
  }
  if (lastNl !== -1) rec.off = lastNl;
  rec.mtimeMs = st.mtimeMs;
  rec.entries = rec.records.length ? rec.records : rec.fallback;
}

function handleLine(line: string, rec: CodexFile, p: string): void {
  if (!line.includes('"session_meta"') && !line.includes('"token_count"') && !line.includes('"turn_context"') &&
    !line.includes('"token_usage_record"') && !line.includes('"task_started"')) return;
  let value: any;
  try { value = JSON.parse(line); } catch { return; }
  const payload = value?.payload;
  if (value?.type === 'session_meta' && payload && typeof payload === 'object') {
    rec.session = {
      id: typeof payload.id === 'string' ? payload.id : typeof payload.session_id === 'string' ? payload.session_id : path.basename(p, '.jsonl'),
      cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
      model: rec.model,
      started: typeof payload.timestamp === 'string' ? payload.timestamp : undefined,
    };
  } else if (value?.type === 'turn_context') {
    if (typeof payload?.model === 'string') rec.model = payload.model;
    if (typeof payload?.turn_id === 'string') rec.turnId = payload.turn_id;
    if (rec.session) rec.session.model = rec.model;
  } else if (value?.type === 'token_usage_record' && payload?.usage) {
    const at = Date.parse(value.timestamp || '');
    if (Number.isNaN(at)) return;
    const id = typeof payload.response_id === 'string' ? payload.response_id : `${at}:${rec.records.length}`;
    if (rec.seen.has(id)) return;
    rec.seen.add(id);
    rec.records.push(usageEntry(payload.usage, at, rec.model || 'Codex', payload.turn_id || rec.turnId || id));
  } else if (value?.type === 'event_msg' && (payload?.type === 'token_count' || payload?.type === 'task_started')) {
    const max = payload?.info?.model_context_window ?? payload?.model_context_window;
    if (typeof max === 'number' && max > 0) rec.contextMax = max;
    if (payload.type !== 'token_count') return;
    const at = Date.parse(value.timestamp || '');
    if (Number.isNaN(at)) return;
    // o servidor devolve o saldo de cota a cada resposta: e o dado mais
    // fresco que existe, sem precisar consultar nada
    const limits = payload.rate_limits;
    if (limits && typeof limits === 'object' && (!rec.limits || at >= rec.limits.at)) {
      rec.limits = { at, row: limits };
    }
    const use = payload.info?.last_token_usage;
    if (use) rec.fallback.push(usageEntry(use, at, rec.model || 'Codex', rec.turnId || String(at)));
  }
}

function usageEntry(use: any, at: number, model: string, turnId: string): UsageEntry {
  const cr = number(use.cached_input_tokens);
  const input = number(use.input_tokens);
  const o = number(use.output_tokens); // reasoning_output_tokens já faz parte de output_tokens
  const cw = number(use.cache_write_input_tokens);
  return { at, model, turnId, i: Math.max(0, input - cr), o, cw, cr, total: input + o + cw };
}

function aggregateHistory(records: Iterable<CodexFile>, windowDays: number, now: number): HistorySnapshot {
  const window = Math.max(1, windowDays);
  const first = new Date(now);
  first.setHours(0, 0, 0, 0);
  first.setDate(first.getDate() - window + 1);
  const cutoff = localDay(first);
  const byDay = new Map<string, Bucket>();
  const byProject = new Map<string, Bucket>();
  const byModel = new Map<string, Bucket>();
  const totals = bucket();
  const turnsByDay = new Map<string, Set<string>>();
  for (const record of records) {
    const project = path.basename(record.session?.cwd || '') || 'Sem projeto';
    for (const entry of record.entries) {
      const day = localDay(new Date(entry.at));
      if (day < cutoff) continue;
      const one = { i: entry.i, o: entry.o, cw: entry.cw, cr: entry.cr, total: entry.total, cost: 0, turns: 0 };
      for (const target of [of(byDay, day), of(byProject, project), of(byModel, entry.model), totals]) add(target, one);
      const turns = turnsByDay.get(day) ?? new Set<string>();
      turns.add(`${record.session?.id || ''}:${entry.turnId}`);
      turnsByDay.set(day, turns);
    }
  }
  for (const [day, turns] of turnsByDay) {
    const count = turns.size;
    of(byDay, day).turns = count;
    totals.turns += count;
  }
  const days: HistorySnapshot['days'] = [];
  for (const date = new Date(first); date.getTime() <= now; date.setDate(date.getDate() + 1)) {
    const d = localDay(date);
    const value = byDay.get(d) ?? bucket();
    days.push({ d, output: value.o, total: value.total, cost: 0, turns: value.turns });
  }
  const rank = (map: Map<string, Bucket>) => [...map].filter(([, value]) => value.total > 0)
    .sort((a, b) => b[1].total - a[1].total).slice(0, 8)
    .map(([n, value]) => ({ n, output: value.o, total: value.total, cost: 0 }));
  return { ready: true, window, days, projects: rank(byProject), models: rank(byModel), totals, scanned_at: now };
}

function bucket(): Bucket { return { i: 0, o: 0, cw: 0, cr: 0, total: 0, cost: 0, turns: 0 }; }
function of(map: Map<string, Bucket>, key: string): Bucket { let value = map.get(key); if (!value) { value = bucket(); map.set(key, value); } return value; }
function add(a: Bucket, b: Bucket): void { a.i += b.i; a.o += b.o; a.cw += b.cw; a.cr += b.cr; a.total += b.total; a.cost += b.cost; a.turns += b.turns; }

function number(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }
function localDay(date: Date): string { const p = (n: number) => String(n).padStart(2, '0'); return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`; }
function normDir(value: string): string { const clean = value.replace(/[\\/]+$/, ''); return process.platform === 'win32' ? clean.toLowerCase().replace(/\//g, '\\') : clean; }
