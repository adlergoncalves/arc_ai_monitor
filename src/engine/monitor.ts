/**
 * Orquestra o poll e monta o payload que os paineis consomem.
 *
 * Nao importa `vscode`: tudo que vem do editor (configuracao e pastas do
 * workspace) chega por callback. Isso mantem o motor testavel fora do editor
 * e deixa claro o que e leitura de disco e o que e integracao.
 */
import { EventEmitter } from 'events';
import * as path from 'path';
import { History } from './history';
import { mergePricing, PriceTable } from './pricing';
import { isAlive, readSessions } from './sessions';
import { QuotaReader } from './quota';
import { TelemetryReader } from './telemetry';
import {
  fileMeta,
  findTranscript,
  listTranscripts,
  pruneCache,
  scanFile,
  TranscriptEntry,
} from './transcripts';
import { DaySlice, LiveData, SessionCard, Turn } from './types';

export interface MonitorConfig {
  refreshInterval: number;
  idleRefreshInterval: number;
  /** segundos entre consultas de cota */
  quotaTtl: number;
  contextWindow: number;
  historyDays: number;
  pricing: unknown;
}

/** janela do acumulado "de hoje": arquivo mais velho que isso nao e relido */
const DAY_WINDOW_MS = 26 * 3600 * 1000;

export class Monitor {
  readonly events = new EventEmitter();

  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private polling = false;
  private busy = false;
  private table: PriceTable;
  private pricingSource: unknown;
  private readonly quota: QuotaReader;
  private readonly history: History;
  private readonly telemetry = new TelemetryReader();
  private lastData: LiveData | undefined;
  private lastPrune = 0;

  constructor(
    private readonly getConfig: () => MonitorConfig,
    private readonly getWorkspaceDirs: () => string[],
  ) {
    const cfg = this.getConfig();
    this.pricingSource = cfg.pricing;
    this.table = mergePricing(cfg.pricing);
    this.quota = new QuotaReader(() => this.getConfig().quotaTtl * 1000);
    this.history = new History(() => this.getConfig().historyDays);
  }

  get last(): LiveData | undefined {
    return this.lastData;
  }

  get quotaError(): string | undefined {
    return this.quota.error;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.loop();
  }

  dispose(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.events.removeAllListeners();
  }

  /** true quando algum painel esta visivel: poll rapido; false: poll lento */
  setBusy(busy: boolean): void {
    if (this.busy === busy) {
      return;
    }
    this.busy = busy;
    if (busy) {
      void this.refreshNow();
    }
  }

  async refreshNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.loop();
  }

  private async loop(): Promise<void> {
    if (!this.running || this.polling) {
      return;
    }
    this.polling = true;
    try {
      const data = await this.build();
      this.lastData = data;
      this.events.emit('data', data);
    } catch (e) {
      const msg = (e as Error)?.message || String(e);
      const data: LiveData = {
        ...emptyData(this.getConfig()),
        error: msg,
      };
      this.lastData = data;
      this.events.emit('data', data);
    } finally {
      this.polling = false;
    }

    if (this.running) {
      const cfg = this.getConfig();
      const wait = this.busy ? cfg.refreshInterval : cfg.idleRefreshInterval;
      this.timer = setTimeout(() => void this.loop(), Math.max(1000, wait));
    }
  }

  private async build(): Promise<LiveData> {
    const cfg = this.getConfig();
    if (cfg.pricing !== this.pricingSource) {
      this.pricingSource = cfg.pricing;
      this.table = mergePricing(cfg.pricing);
    }

    const now = new Date();
    const todayLocal = localDay(now);
    const dirs = this.getWorkspaceDirs().map(normDir);

    // uma unica listagem serve aos cartoes, ao dia e ao historico: percorrer
    // a arvore tres vezes por poll seria 1400 stat() sem ganho nenhum
    const entries = await listTranscripts();
    const kids = new Map<string, TranscriptEntry[]>();
    for (const e of entries) {
      if (e.parent) {
        const arr = kids.get(e.parent);
        if (arr) {
          arr.push(e);
        } else {
          kids.set(e.parent, [e]);
        }
      }
    }

    // ── sessoes vivas ──────────────────────────────────────────────────
    const cards: SessionCard[] = [];
    for (const meta of await readSessions()) {
      if (typeof meta.pid !== 'number' || !isAlive(meta.pid)) {
        continue; // arquivo orfao: o processo morreu sem limpar
      }
      const tpath = await findTranscript(meta.sessionId);
      const turns = tpath ? await scanFile(tpath, this.table) : [];
      const fm = tpath ? fileMeta(tpath) : {};
      const lastTurn = turns.length > 0 ? turns[turns.length - 1] : undefined;

      // o que os subagentes desta sessao gastaram entra no cartao dela: foi
      // ela que mandou rodar. O CONTEXTO nao — esse e da conversa principal.
      const subs = kids.get(meta.sessionId) ?? [];
      let subOut = 0;
      let subCost = 0;
      let subTurns = 0;
      for (const s of subs) {
        for (const t of await scanFile(s.path, this.table)) {
          subOut += t.o;
          subCost += t.cost;
          subTurns += 1;
        }
      }

      const lt = lastTurn ? parseIso(lastTurn.ts) : undefined;
      const cwdFull = meta.cwd || '';

      cards.push({
        pid: meta.pid,
        sid: meta.sessionId,
        short: meta.sessionId.slice(0, 8),
        name: meta.name || meta.sessionId.slice(0, 8),
        title: fm.title,
        branch: fm.branch,
        product: path.basename(cwdFull.replace(/[\\/]+$/, '')) || meta.name || '',
        cwd_full: cwdFull,
        started:
          typeof meta.startedAt === 'number'
            ? new Date(meta.startedAt).toTimeString().slice(0, 5)
            : undefined,
        model: (lastTurn?.model || '').replace('claude-', ''),
        output: sum(turns, (t) => t.o) + subOut,
        context: lastTurn?.ctx ?? 0,
        cost: round2(sum(turns, (t) => t.cost) + subCost),
        turns: turns.length + subTurns,
        idle: lt ? Math.floor((now.getTime() - lt.getTime()) / 1000) : null,
        here: cwdFull !== '' && dirs.includes(normDir(cwdFull)),
        subagents: subs.length,
        sub_output: subOut,
      });
    }
    cards.sort((a, b) => (a.idle ?? Number.MAX_SAFE_INTEGER) - (b.idle ?? Number.MAX_SAFE_INTEGER));

    // ── acumulado do dia + historico ───────────────────────────────────
    const day = await this.buildDay(entries, todayLocal);
    this.history.update(entries, this.table);

    if (now.getTime() - this.lastPrune > 3600_000) {
      this.lastPrune = now.getTime();
      pruneCache(now.getTime());
    }

    return {
      now: now.toTimeString().slice(0, 8),
      date: todayLocal,
      account: await this.quota.account(),
      sessions: cards,
      active: cards.length,
      day,
      history: this.history.snapshot(),
      telemetry: await this.telemetry.read(),
      every_ms: this.busy ? cfg.refreshInterval : cfg.idleRefreshInterval,
      ctx_max: cfg.contextWindow,
    };
  }

  private async buildDay(entries: TranscriptEntry[], todayLocal: string): Promise<DaySlice> {
    let cost = 0;
    let turns = 0;
    const comp = { i: 0, o: 0, cw: 0, cr: 0, total: 0 };
    const perHour = new Map<number, number>();
    const perModel = new Map<string, number>();
    const cutoff = Date.now() - DAY_WINDOW_MS;

    // ── espelho do exporter OTLP ─────────────────────────────────────────
    // A "janela" e o delta dos ultimos 60s: e o que o proximo export leva.
    // Cada turno com usage corresponde a um evento claude_code.api_request.
    const WIN_MS = 60_000;
    const winStart = Date.now() - WIN_MS;
    const win = { i: 0, o: 0, cw: 0, cr: 0, total: 0, cost: 0, requests: 0 };
    const mainToday = new Set<string>();
    let activeS = 0;

    for (const e of entries) {
      if (e.mtimeMs < cutoff) {
        continue;
      }
      // active_time: gaps ate 5min entre turnos consecutivos da MESMA sessao
      // principal contam como tempo ativo. Subagentes ficam de fora — rodam
      // em paralelo e inflariam o relogio.
      let prevMs: number | undefined;
      for (const t of await scanFile(e.path, this.table)) {
        const lt = parseIso(t.ts);
        if (!lt || localDay(lt) !== todayLocal) {
          continue;
        }
        comp.i += t.i;
        comp.o += t.o;
        comp.cw += t.cw;
        comp.cr += t.cr;
        comp.total += t.i + t.o + t.cw + t.cr;
        cost += t.cost;
        turns += 1;
        perHour.set(lt.getHours(), (perHour.get(lt.getHours()) ?? 0) + t.o);
        const m = t.model.replace('claude-', '');
        perModel.set(m, (perModel.get(m) ?? 0) + t.o);

        const ms = lt.getTime();
        if (!e.parent) {
          mainToday.add(e.path);
          if (prevMs !== undefined) {
            const gap = (ms - prevMs) / 1000;
            if (gap > 0 && gap <= 300) {
              activeS += gap;
            }
          }
          prevMs = ms;
        }
        if (ms >= winStart) {
          win.i += t.i;
          win.o += t.o;
          win.cw += t.cw;
          win.cr += t.cr;
          win.total += t.i + t.o + t.cw + t.cr;
          win.cost += t.cost;
          win.requests += 1;
        }
      }
    }

    return {
      output: comp.o,
      cost: round2(cost),
      turns,
      hours: Array.from({ length: 24 }, (_, h) => ({ h, o: perHour.get(h) ?? 0 })),
      models: [...perModel.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([n, o]) => ({ n, o })),
      comp,
      wire: {
        win_s: WIN_MS / 1000,
        win: { ...win, cost: round2(win.cost) },
        sessions: mainToday.size,
        active_s: Math.round(activeS),
      },
    };
  }
}

function emptyData(cfg: MonitorConfig): LiveData {
  return {
    now: new Date().toTimeString().slice(0, 8),
    date: localDay(new Date()),
    account: { bars: [], spend: null, age_s: null, source: 'none' },
    sessions: [],
    active: 0,
    day: {
      output: 0,
      cost: 0,
      turns: 0,
      hours: Array.from({ length: 24 }, (_, h) => ({ h, o: 0 })),
      models: [],
      comp: { i: 0, o: 0, cw: 0, cr: 0, total: 0 },
      wire: {
        win_s: 60,
        win: { i: 0, o: 0, cw: 0, cr: 0, total: 0, cost: 0, requests: 0 },
        sessions: 0,
        active_s: 0,
      },
    },
    every_ms: cfg.refreshInterval,
    ctx_max: cfg.contextWindow,
  };
}

function sum(turns: Turn[], pick: (t: Turn) => number): number {
  let total = 0;
  for (const t of turns) {
    total += pick(t);
  }
  return total;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** data local no formato YYYY-MM-DD (nao UTC: o dia do usuario e o local) */
function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseIso(ts: string | undefined): Date | undefined {
  if (!ts) {
    return undefined;
  }
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function normDir(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? clean.toLowerCase().replace(/\//g, '\\') : clean;
}
