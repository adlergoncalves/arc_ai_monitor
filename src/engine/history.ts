/**
 * Varredura historica dos transcripts, continua e incremental.
 *
 * A primeira passada le todos os transcripts (medido: 487 MB / 474 arquivos
 * em ~8s). Depois disso so relemos arquivo cujo mtime ou tamanho mudou, e o
 * agregado e reconstruido a partir das contribuicoes por arquivo — nunca por
 * subtracao, que acumularia erro de ponto flutuante ao longo de dias ligado.
 *
 * A varredura cede o event loop a cada punhado de arquivos: travar o
 * extension host por 8s deixaria o VS Code inteiro duro no boot.
 */
import * as path from 'path';
import { PriceTable } from './pricing';
import { fileMeta, scanFile, TranscriptEntry } from './transcripts';
import { Bucket, HistorySnapshot, Turn } from './types';

interface Contribution {
  mtimeMs: number;
  size: number;
  /** pasta crua sob ~/.claude/projects — a chave real do agrupamento */
  projectDir: string;
  /** nome de reserva, derivado do nome da pasta */
  fallback: string;
  /** cwd da SESSAO PRINCIPAL; subagentes nao contribuem com nome */
  cwd?: string;
  days: Map<string, Bucket>;
  models: Map<string, Bucket>;
}

/** arquivos lidos entre uma pausa e outra */
const CHUNK = 8;

export class History {
  private readonly files = new Map<string, Contribution>();
  private snap: HistorySnapshot | undefined;
  private busy = false;

  constructor(private readonly windowDays: () => number) {}

  snapshot(): HistorySnapshot | undefined {
    return this.snap;
  }

  /** dispara a atualizacao em segundo plano; nunca bloqueia o poll */
  update(entries: TranscriptEntry[], table: PriceTable): void {
    if (this.busy) {
      return;
    }
    this.busy = true;
    void this.run(entries, table).finally(() => {
      this.busy = false;
    });
  }

  private async run(entries: TranscriptEntry[], table: PriceTable): Promise<void> {
    let changed = false;
    let since = 0;
    const seen = new Set<string>();

    for (const e of entries) {
      seen.add(e.path);
      const prev = this.files.get(e.path);
      if (prev && prev.mtimeMs === e.mtimeMs && prev.size === e.size) {
        continue;
      }
      const turns = await scanFile(e.path, table);
      // so a sessao principal batiza o projeto: um subagente pode ter rodado
      // com o cwd numa subpasta ("backend", "Documentos"), e isso viraria um
      // projeto inexistente no ranking
      const cwd = e.parent ? undefined : fileMeta(e.path).cwd;
      this.files.set(e.path, contribute(e, turns, cwd));
      changed = true;
      if (++since >= CHUNK) {
        since = 0;
        await yieldToLoop();
      }
    }

    for (const p of [...this.files.keys()]) {
      if (!seen.has(p)) {
        this.files.delete(p);
        changed = true;
      }
    }

    if (changed || !this.snap) {
      this.snap = this.aggregate();
    }
  }

  private aggregate(): HistorySnapshot {
    const window = Math.max(1, this.windowDays());
    const first = new Date();
    first.setHours(0, 0, 0, 0);
    first.setDate(first.getDate() - (window - 1));
    const cutoff = localDay(first);

    // nome de cada pasta de projeto: o cwd de qualquer sessao principal dela.
    // Assim os subagentes herdam o projeto de quem os disparou, em vez de
    // virarem entradas proprias com o nome da subpasta em que rodaram.
    const names = new Map<string, string>();
    for (const c of this.files.values()) {
      if (names.has(c.projectDir) || !c.cwd) {
        continue;
      }
      const base = path.basename(c.cwd.replace(/[\\/]+$/, ''));
      if (base) {
        names.set(c.projectDir, base);
      }
    }

    const byDay = new Map<string, Bucket>();
    const byProject = new Map<string, Bucket>();
    const byModel = new Map<string, Bucket>();
    const totals = empty();

    for (const c of this.files.values()) {
      const project = names.get(c.projectDir) || c.fallback;
      for (const [day, b] of c.days) {
        if (day < cutoff) {
          continue;
        }
        add(bucketOf(byDay, day), b);
        add(bucketOf(byProject, project), b);
        add(totals, b);
      }
      // modelos so entram se o arquivo tiver algo dentro da janela — senao um
      // projeto antigo continuaria pesando no ranking para sempre
      const inWindow = [...c.days.keys()].some((d) => d >= cutoff);
      if (inWindow) {
        for (const [model, b] of c.models) {
          add(bucketOf(byModel, model), b);
        }
      }
    }

    // preenche os dias sem registro: fim de semana vira barra zerada, nao
    // um buraco que desloca a leitura da serie
    const days: HistorySnapshot['days'] = [];
    const cur = new Date(first);
    const today = localDay(new Date());
    while (localDay(cur) <= today) {
      const d = localDay(cur);
      const b = byDay.get(d) ?? empty();
      days.push({ d, output: b.o, total: b.total, cost: round2(b.cost), turns: b.turns });
      cur.setDate(cur.getDate() + 1);
    }

    return {
      ready: true,
      window,
      days,
      projects: rank(byProject),
      models: rank(byModel),
      totals: { ...totals, cost: round2(totals.cost) },
      scanned_at: Date.now(),
    };
  }
}

function contribute(e: TranscriptEntry, turns: Turn[], cwd: string | undefined): Contribution {
  const days = new Map<string, Bucket>();
  const models = new Map<string, Bucket>();
  for (const t of turns) {
    const when = new Date(t.ts);
    if (Number.isNaN(when.getTime())) {
      continue;
    }
    const one: Bucket = {
      i: t.i,
      o: t.o,
      cw: t.cw,
      cr: t.cr,
      total: t.i + t.o + t.cw + t.cr,
      cost: t.cost,
      turns: 1,
    };
    add(bucketOf(days, localDay(when)), one);
    add(bucketOf(models, t.model.replace('claude-', '')), one);
  }
  return {
    mtimeMs: e.mtimeMs,
    size: e.size,
    projectDir: e.projectDir,
    fallback: e.project,
    cwd,
    days,
    models,
  };
}

function rank(m: Map<string, Bucket>): { n: string; output: number; total: number; cost: number }[] {
  return [...m.entries()]
    // linha zerada e ruido: "<synthetic>" aparece sempre e nunca consumiu nada
    .filter(([, b]) => b.total > 0)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 8)
    .map(([n, b]) => ({ n, output: b.o, total: b.total, cost: round2(b.cost) }));
}

function empty(): Bucket {
  return { i: 0, o: 0, cw: 0, cr: 0, total: 0, cost: 0, turns: 0 };
}

function bucketOf(m: Map<string, Bucket>, k: string): Bucket {
  let b = m.get(k);
  if (!b) {
    b = empty();
    m.set(k, b);
  }
  return b;
}

function add(target: Bucket, src: Bucket): void {
  target.i += src.i;
  target.o += src.o;
  target.cw += src.cw;
  target.cr += src.cr;
  target.total += src.total;
  target.cost += src.cost;
  target.turns += src.turns;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
