/** Consulta de cotas do Codex pelo app-server local.
 *
 * O app-server e a interface autenticada que o proprio Codex usa. Assim nao
 * precisamos ler nem transportar o token do OpenAI; so pedimos o retrato de
 * cotas da conta ja logada, por JSON-RPC em stdio. Durante o uso, os
 * retratos gravados nos JSONL a cada resposta tomam a frente (ver account()).
 */
import { spawn } from 'child_process';
import { Dirent } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { LimitSnapshot } from './codexUsage';
import { HOME } from './paths';
import { Account, QuotaBar } from './types';

const TTL_MAX_MS = 900_000;
const TIMEOUT_MS = 15_000;

interface Snapshot {
  usedPercent?: number;
  used_percent?: number;
  windowDurationMins?: number;
  window_minutes?: number;
  resetsAt?: number;
  resets_at?: number;
  planType?: string;
  plan_type?: string;
  limitId?: string;
  limit_id?: string;
  limitName?: string | null;
  limit_name?: string | null;
  primary?: Snapshot | null;
  secondary?: Snapshot | null;
}

interface LiveCodex {
  at: number;
  /** um retrato por balde de cota (limit_id), como o app-server devolve */
  rows: Snapshot[];
  identity: unknown;
}

export class CodexReader {
  private live: LiveCodex | undefined;
  private fetching: Promise<void> | undefined;
  private tried = false;
  private lastError: string | undefined;
  /** proxima consulta permitida; em erro recua ate 15min, com ou sem dado anterior */
  private nextAt = 0;
  private backoffMs = 0;

  constructor(private readonly ttlMs: () => number) {}

  get error(): string | undefined {
    return this.lastError;
  }

  /**
   * `logged` sao os retratos que o proprio Codex grava nos JSONL a cada
   * resposta do servidor. Durante o uso eles sao mais novos que qualquer
   * consulta ao app-server — e o que faz a cota andar em tempo real, turno a
   * turno, em vez de em degraus de 150s. O app-server continua sendo a
   * fonte quando nao ha atividade e o que traz e-mail e plano.
   */
  async account(logged: LimitSnapshot[] = []): Promise<Account | undefined> {
    if (Date.now() >= this.nextAt && !this.fetching) {
      this.fetching = this.refresh().finally(() => { this.fetching = undefined; });
      // Primeira consulta: espera, a janela precisa nascer com numero. Depois
      // roda em segundo plano — subir o app-server leva ~1s e travaria o poll.
      if (!this.tried) {
        this.tried = true;
        await this.fetching;
      }
    }

    // balde a balde, fica o retrato mais novo das duas fontes
    const byId = new Map<string, { at: number; row: Snapshot }>();
    const live = this.live;
    for (const row of live?.rows ?? []) byId.set(limitIdOf(row), { at: live!.at, row });
    let fromLog = false;
    for (const snap of logged) {
      const row = snap.row as Snapshot;
      const prior = byId.get(limitIdOf(row));
      if (!prior || snap.at > prior.at) {
        byId.set(limitIdOf(row), { at: snap.at, row });
        fromLog = true;
      }
    }
    if (byId.size === 0) {
      return undefined;
    }
    const at = Math.max(...[...byId.values()].map((v) => v.at));
    const account = parseRows([...byId.values()].map((v) => v.row), live?.identity);
    if (!account) {
      return undefined;
    }
    const age = Math.floor((Date.now() - at) / 1000);
    // retrato do log e oficial, mas so e "ao vivo" enquanto for recente
    const fresh = fromLog ? age * 1000 <= this.ttlMs() : !this.lastError;
    return { ...account, source: fresh ? 'live' : 'cache', age_s: age, fetched_ms: at };
  }

  private async refresh(): Promise<void> {
    try {
      const command = await findCodex();
      const result = await requestAccount(command);
      const rows = rowsOf(result.limits);
      if (!parseRows(rows, result.account)) {
        throw new Error('Codex não devolveu cotas para esta conta');
      }
      this.live = { at: Date.now(), rows, identity: result.account };
      this.lastError = undefined;
      this.backoffMs = 0;
      this.nextAt = Date.now() + this.ttlMs();
    } catch (e) {
      // Sem este recuo, quem nao tem Codex (ou nao esta logado) tentaria abrir
      // o binario a cada poll de 3s.
      this.lastError = (e as Error).message || 'consulta ao Codex indisponível';
      this.backoffMs = Math.min(Math.max(this.backoffMs * 2, this.ttlMs()), TTL_MAX_MS);
      this.nextAt = Date.now() + this.backoffMs;
    }
  }
}

function limitIdOf(row: Snapshot): string {
  return String(row.limitId ?? row.limit_id ?? 'codex');
}

/** app-server novo devolve um mapa por balde; o antigo, um retrato so */
function rowsOf(result: any): Snapshot[] {
  const raw = result?.rateLimitsByLimitId;
  return raw && typeof raw === 'object'
    ? Object.entries(raw).map(([id, value]) => ({ ...(value as Snapshot), limitId: (value as Snapshot).limitId ?? id }))
    : result?.rateLimits ? [result.rateLimits as Snapshot] : [];
}

/** Mesmo formato vindo do app-server (camelCase) ou do JSONL (snake_case). */
function parseRows(rows: Snapshot[], identity: any): Account | undefined {
  const bars: QuotaBar[] = [];
  let tier: string | undefined;
  // com mais de um balde, a janela sozinha ("5 h") repetiria o rotulo
  const many = rows.length > 1;
  for (const row of rows) {
    tier ||= row.planType ?? row.plan_type;
    for (const [part, label] of [['primary', 'janela principal'], ['secondary', 'janela semanal']] as const) {
      const value = row[part];
      if (!value || typeof value !== 'object') {
        continue;
      }
      let percent = value.usedPercent ?? value.used_percent;
      if (typeof percent !== 'number') {
        continue;
      }
      const minutes = value.windowDurationMins ?? value.window_minutes;
      const reset = value.resetsAt ?? value.resets_at;
      const renewed = typeof reset === 'number' && reset * 1000 <= Date.now();
      // janela que ja renovou: o percentual do retrato ficou para tras. Sem
      // isto, um log de ontem mostraria cheia uma cota que ja zerou.
      if (renewed) {
        percent = 0;
      }
      const name = row.limitName ?? row.limit_name ?? row.limitId ?? row.limit_id ?? 'Codex';
      const window = typeof minutes === 'number' ? readableWindow(minutes) : label;
      bars.push({
        kind: `codex_${String(name)}_${part}`,
        provider: 'codex',
        group: 'codex',
        label: `Codex · ${many && name !== 'codex' ? `${name} · ` : ''}${window}`,
        percent,
        severity: percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : 'normal',
        resets_at: typeof reset === 'number' && !renewed ? new Date(reset * 1000).toISOString() : null,
      });
    }
  }
  return bars.length ? {
    bars,
    spend: null,
    tier,
    email: typeof identity?.account?.email === 'string' ? identity.account.email : undefined,
    age_s: 0,
    source: 'live',
  } : undefined;
}

function readableWindow(minutes: number): string {
  if (minutes % 10080 === 0) return `${minutes / 10080} sem`;
  if (minutes % 1440 === 0) return `${minutes / 1440} d`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

async function findCodex(): Promise<string> {
  if (process.env.CODEX_BINARY) {
    return process.env.CODEX_BINARY;
  }
  const roots = [path.join(HOME, '.vscode', 'extensions'), path.join(HOME, '.cursor', 'extensions')];
  for (const root of roots) {
    let extensions: Dirent[];
    try { extensions = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const extension of extensions) {
      if (!extension.isDirectory() || !extension.name.startsWith('openai.chatgpt-')) continue;
      const bin = path.join(root, extension.name, 'bin');
      let platforms: Dirent[];
      try { platforms = await fs.readdir(bin, { withFileTypes: true }); } catch { continue; }
      for (const platform of platforms) {
        const candidate = path.join(bin, platform.name, process.platform === 'win32' ? 'codex.exe' : 'codex');
        try { await fs.access(candidate); return candidate; } catch { /* next platform */ }
      }
    }
  }
  // O spawn abaixo tambem atende instalacoes globais que estejam no PATH.
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

function requestAccount(command: string): Promise<{ limits: unknown; account: unknown }> {
  return new Promise((resolve, reject) => {
    // stderr descartado: pipe que ninguem le enche e trava o processo filho
    const child = spawn(command, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    // escrever num filho que nao subiu emite 'error' no stdin; sem ouvinte vira excecao solta
    child.stdin.on('error', () => undefined);
    let done = false;
    let buffer = '';
    let limits: unknown;
    const finish = (error?: Error, value?: { limits: unknown; account: unknown }): void => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolve(value ?? { limits, account: undefined });
    };
    const send = (message: object): void => { child.stdin.write(`${JSON.stringify(message)}\n`); };
    const timeout = setTimeout(() => finish(new Error('Codex app-server não respondeu em 15s')), TIMEOUT_MS);
    child.once('error', () => finish(new Error('Codex não foi encontrado. Instale ou abra a extensão oficial do Codex.')));
    child.once('close', () => finish(new Error('Codex app-server encerrou antes de responder.')));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.error) return finish(new Error(`Codex: ${message.error.message || 'falha na inicialização'}`));
        if (message.id === 1) {
          send({ method: 'initialized', params: {} });
          send({ method: 'account/rateLimits/read', id: 2 });
        }
        if (message.id === 2) {
          if (message.error) finish(new Error(`Codex: ${message.error.message || 'cotas indisponíveis'}`));
          else {
            limits = message.result;
            send({ method: 'account/read', id: 3, params: {} });
          }
        }
        if (message.id === 3) {
          // A conta e informativa: uma versão antiga pode não expor account/read,
          // sem impedir a leitura já concluída das cotas.
          finish(undefined, { limits, account: message.error ? undefined : message.result });
        }
      }
    });
    send({ method: 'initialize', id: 1, params: {
      clientInfo: { name: 'arc_ai_monitor', title: 'Arc AI Monitor', version: '1.0.3' },
      capabilities: null,
    } });
  });
}
