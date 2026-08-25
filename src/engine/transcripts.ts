/**
 * Leitura INCREMENTAL dos transcripts (~/.claude/projects/**\/*.jsonl).
 *
 * Sao centenas de MB no total: reprocessar tudo a cada poll queimaria CPU a
 * toa. Guardamos por arquivo o offset ja lido + mtime e so decodificamos o
 * trecho novo. Dedup por `message.id`, porque o streaming grava o mesmo turno
 * varias vezes.
 *
 * Dois cuidados, resolvidos por promessas em voo:
 *  - a mesma leitura nunca roda duas vezes em paralelo (senao um turno sem id
 *    seria contado em dobro);
 *  - registros de arquivos que nao sao tocados ha muito tempo sao descartados,
 *    para o processo do VS Code nao crescer sem fim ao longo de dias ligado.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { PROJ_DIR } from './paths';
import { costOf, PriceTable } from './pricing';
import { FileMeta, Turn } from './types';

interface FileRec {
  off: number;
  mtimeMs: number;
  ids: Set<string>;
  turns: Turn[];
  meta: FileMeta;
  seenAt: number;
}

const files = new Map<string, FileRec>();
const pending = new Map<string, Promise<Turn[]>>();

/** registros nao tocados por mais de 48h saem da memoria */
const REC_TTL_MS = 48 * 3600 * 1000;

const NL = 0x0a;

/** tamanho da fatia de leitura — o pico de memoria fica preso a ele */
const READ_CHUNK = 1024 * 1024;

export function fileMeta(p: string): FileMeta {
  const rec = files.get(p);
  return rec ? { ...rec.meta } : {};
}

export function pruneCache(now = Date.now()): void {
  for (const [p, rec] of files) {
    if (now - rec.seenAt > REC_TTL_MS) {
      files.delete(p);
    }
  }
}

/**
 * Devolve TODOS os turnos ja conhecidos do arquivo (acumulado), lendo do disco
 * apenas o que apareceu desde a ultima chamada.
 */
export function scanFile(p: string, table: PriceTable): Promise<Turn[]> {
  const inflight = pending.get(p);
  if (inflight) {
    return inflight;
  }
  const job = doScan(p, table).finally(() => pending.delete(p));
  pending.set(p, job);
  return job;
}

async function doScan(p: string, table: PriceTable): Promise<Turn[]> {
  let st;
  try {
    st = await fs.stat(p);
  } catch {
    return [];
  }

  let rec = files.get(p);
  if (!rec) {
    rec = { off: 0, mtimeMs: 0, ids: new Set(), turns: [], meta: {}, seenAt: 0 };
    files.set(p, rec);
  }
  rec.seenAt = Date.now();

  // arquivo truncado ou rotacionado: recomeca (mas preserva os metadados)
  if (st.size < rec.off) {
    rec.off = 0;
    rec.ids.clear();
    rec.turns = [];
  }
  if (st.size === rec.off && st.mtimeMs === rec.mtimeMs) {
    return rec.turns;
  }

  const start = rec.off;
  if (st.size <= start) {
    rec.mtimeMs = st.mtimeMs;
    return rec.turns;
  }

  // Leitura em FATIAS. O maior transcript aqui tem 29 MB; ler inteiro de uma
  // vez alocava buffer + string + array de linhas do tamanho do arquivo, tudo
  // ao mesmo tempo, dentro do extension host. Em fatias o pico fica preso ao
  // tamanho da fatia, seja o arquivo de 1 MB ou de 1 GB.
  //
  // O StringDecoder segura sequencia UTF-8 partida na borda da fatia; o
  // offset consumido e contado em BYTES, pelo ultimo \n visto — misturar as
  // duas contagens (byte e caractere) corromperia a retomada.
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let pos = start;
  let lastNl = -1;
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(p, 'r');
    const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, st.size - start));
    while (pos < st.size) {
      const want = Math.min(buf.length, st.size - pos);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) {
        break;
      }
      const nl = buf.lastIndexOf(NL, bytesRead - 1);
      if (nl !== -1) {
        lastNl = pos + nl + 1;
      }
      pos += bytesRead;
      carry += decoder.write(buf.subarray(0, bytesRead));
      const lines = carry.split('\n');
      // a ultima pode estar sendo escrita agora: fica para a proxima fatia
      carry = lines.pop() ?? '';
      for (const line of lines) {
        handleLine(line, rec, table);
      }
    }
  } catch {
    return rec.turns;
  } finally {
    await fh?.close().catch(() => undefined);
  }

  if (lastNl === -1) {
    return rec.turns; // nada completo ainda
  }
  rec.off = lastNl;
  rec.mtimeMs = st.mtimeMs;
  return rec.turns;
}

/** Uma linha do jsonl: metadados e, quando houver, o consumo do turno. */
function handleLine(line: string, rec: FileRec, table: PriceTable): void {
  const hasUsage = line.includes('"usage"');
  // aiTitle/gitBranch aparecem em linhas SEM usage, entao a checagem de
  // metadados precisa vir antes do filtro de consumo
  const hasMeta = line.includes('"aiTitle"') || line.includes('"gitBranch"');
  if (!hasUsage && !hasMeta) {
    return;
  }

  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return;
  }
  if (!d || typeof d !== 'object') {
    return;
  }

  if (hasMeta) {
    if (typeof d.aiTitle === 'string' && d.aiTitle) {
      rec.meta.title = d.aiTitle;
    }
    if (typeof d.gitBranch === 'string' && d.gitBranch) {
      rec.meta.branch = d.gitBranch;
    }
  }
  if (!hasUsage) {
    return;
  }

  // toda linha com `usage` carrega o cwd real da sessao — e de onde sai o
  // nome do projeto, em vez de tentar desfazer o caminho codificado no nome
  // da pasta. Lido das linhas que ja seriam parseadas: custo zero.
  if (!rec.meta.cwd && typeof d.cwd === 'string' && d.cwd) {
    rec.meta.cwd = d.cwd;
  }

  const msg = d.message;
  if (!msg || typeof msg !== 'object') {
    return;
  }
  const u = msg.usage;
  if (!u || typeof u !== 'object') {
    return;
  }
  const mid = msg.id;
  if (typeof mid === 'string' && mid) {
    // streaming grava o mesmo turno varias vezes
    if (rec.ids.has(mid)) {
      return;
    }
    rec.ids.add(mid);
  }

  const i = num(u.input_tokens);
  const o = num(u.output_tokens);
  const cw = num(u.cache_creation_input_tokens);
  const cr = num(u.cache_read_input_tokens);
  const model = typeof msg.model === 'string' && msg.model ? msg.model : '?';

  rec.turns.push({
    ts: typeof d.timestamp === 'string' ? d.timestamp : '',
    model,
    i,
    o,
    cw,
    cr,
    ctx: i + cw + cr,
    cost: costOf(model, i, o, cw, cr, table),
  });
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** ~/.claude/projects/<projeto>/<sessionId>.jsonl */
export async function findTranscript(sessionId: string): Promise<string | undefined> {
  const target = `${sessionId}.jsonl`;
  let dirs: string[];
  try {
    dirs = (await fs.readdir(PROJ_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const p = path.join(PROJ_DIR, d, target);
    try {
      await fs.access(p);
      return p;
    } catch {
      // segue procurando
    }
  }
  return undefined;
}

export interface TranscriptEntry {
  path: string;
  /** nome cru da pasta sob ~/.claude/projects — chave de agrupamento */
  projectDir: string;
  /** nome legivel de reserva, quando o cwd nao estiver disponivel */
  project: string;
  mtimeMs: number;
  size: number;
  /** sessionId que disparou este subagente — ausente na sessao principal */
  parent?: string;
}

/** profundidade maxima da varredura: projeto/sessao/subagents/arquivo */
const MAX_DEPTH = 3;

/**
 * TODOS os transcripts sob ~/.claude/projects, com mtime e tamanho. Uma
 * passada so serve o acumulado do dia (filtrando por mtime), a varredura
 * historica e os cartoes de sessao.
 *
 * A varredura e RECURSIVA de proposito. Cada sessao que dispara subagentes
 * grava o consumo deles em `<projeto>/<sessionId>/subagents/*.jsonl` — e
 * costuma ser a MAIORIA dos arquivos; varrer so um nivel deixaria esse
 * consumo de fora. Como a pasta avo e o proprio sessionId, da para devolver
 * cada subagente para a sessao que o criou.
 */
export async function listTranscripts(): Promise<TranscriptEntry[]> {
  const out: TranscriptEntry[] = [];
  let projects: string[];
  try {
    projects = (await fs.readdir(PROJ_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return out;
  }

  for (const d of projects) {
    await walk(path.join(PROJ_DIR, d), d, 0, undefined, out);
  }
  return out;
}

async function walk(
  dir: string,
  projectDir: string,
  depth: number,
  parent: string | undefined,
  out: TranscriptEntry[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth >= MAX_DEPTH) {
        continue;
      }
      // .../<sessionId>/subagents/ -> os arquivos la dentro pertencem a essa
      // sessao; o nome da pasta atual e o proprio sessionId
      const nextParent = e.name === 'subagents' ? path.basename(dir) : parent;
      await walk(p, projectDir, depth + 1, nextParent, out);
      continue;
    }
    if (!e.isFile() || !e.name.endsWith('.jsonl')) {
      continue;
    }
    try {
      const st = await fs.stat(p);
      out.push({
        path: p,
        projectDir,
        project: prettyProject(projectDir),
        mtimeMs: st.mtimeMs,
        size: st.size,
        parent,
      });
    } catch {
      continue;
    }
  }
}

/**
 * Nome legivel do projeto a partir do NOME DA PASTA — usado so como reserva,
 * quando o transcript ainda nao revelou o `cwd`.
 *
 * O Claude Code codifica o caminho inteiro na pasta
 * ("c--Projetos-meu-app"). Nao da para desfazer isso sem chutar: os
 * separadores viraram o mesmo hifen que existe dentro dos nomes —
 * "meu-app-2" e indistinguivel de "meu/app/2". Por isso aqui so tiramos o
 * prefixo de unidade e cortamos o comprimento; a atribuicao boa vem do cwd.
 */
export function prettyProject(dirname: string): string {
  const n = /^[a-zA-Z]--(.*)$/.exec(dirname)?.[1] || dirname;
  return n.length > 42 ? `${n.slice(0, 39)}...` : n;
}
