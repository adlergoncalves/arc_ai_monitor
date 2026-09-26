/**
 * Cotas oficiais da conta.
 *
 * Duas fontes, nesta ordem de preferencia:
 *  1. consulta ao vivo a `api.anthropic.com/api/oauth/usage` — o MESMO JSON
 *     que o `/usage` mostra. NAO e `/v1/messages`: nao ha inferencia, nao
 *     gasta token e nao consome cota, e so uma leitura de saldo;
 *  2. o cache que o proprio Claude Code grava em `~/.claude.json`, quando a
 *     consulta falha, o token expirou ou a rede caiu.
 *
 * O token sai de `~/.claude/.credentials.json` ou, quando esse arquivo nao
 * existe (padrao no macOS), do Keychain — o Claude Code usa um ou outro
 * conforme a plataforma, com o MESMO formato de JSON. Em nenhum dos dois
 * casos ele e reescrito aqui: se expirar, caimos no cache em vez de tentar
 * renovar.
 *
 * O resultado da consulta e compartilhado entre todas as janelas do VS
 * Code, num arquivo em ~/.claude com lock. Sem isso, tres janelas abertas
 * fariam tres consultas independentes, o endpoint devolveria
 * `429 rate_limit_error` e todo mundo ficaria preso ao cache. Com o cache
 * compartilhado, N janelas geram no maximo uma consulta por TTL.
 */
import { createHash } from 'crypto';
import * as os from 'os';
import { ExecException, execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as https from 'https';
import { CLAUDE_DIR, CONFIG_FILE, CREDS_FILE, QUOTA_CACHE, QUOTA_LOCK } from './paths';
import { Account, QuotaBar, Spend } from './types';

const QUOTA_URL = 'https://api.anthropic.com/api/oauth/usage';
/** item do Keychain (macOS) onde o Claude Code guarda o mesmo JSON do arquivo */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
/** apos erro/429, recua progressivamente ate 15min */
const BACKOFF_MAX_MS = 900_000;
/** lock abandonado (processo morreu no meio) vira lixo depois disso */
const LOCK_STALE_MS = 60_000;

const KIND_PT: Record<string, string> = {
  session: 'Sessão (5h)',
  weekly_all: 'Semanal (7 dias)',
  weekly_scoped: 'Semanal',
  weekly_opus: 'Semanal Opus',
};

interface LiveRecord {
  at: number;
  waitMs: number;
  fetchedAt?: number;
  error?: string;
  bars: QuotaBar[];
  spend: Spend | null;
  sub?: string;
}

/**
 * Converte o bloco `utilization` em barras + gasto.
 * O JSON e IDENTICO vindo do cache local ou da consulta ao vivo — por isso a
 * mesma funcao serve as duas.
 */
export function parseUtilization(util: any): { bars: QuotaBar[]; spend: Spend | null } {
  const bars: QuotaBar[] = [];
  const limits = Array.isArray(util?.limits) ? util.limits : [];

  for (const lim of limits) {
    if (!lim || typeof lim !== 'object') {
      continue;
    }
    const kind: string = lim.kind || '';
    let label = KIND_PT[kind] ?? kind.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
    const model = lim.scope?.model?.display_name;
    if (model) {
      label = `${label} · ${model}`;
    }
    bars.push({
      kind,
      provider: 'claude',
      group: lim.group ?? null,
      label,
      percent: typeof lim.percent === 'number' ? lim.percent : null,
      severity: lim.severity || 'normal',
      resets_at: lim.resets_at ?? null,
    });
  }

  // fallback: se `limits` nao vier, monta a partir dos campos diretos
  if (bars.length === 0) {
    for (const [key, label] of [
      ['five_hour', 'Sessão (5h)'],
      ['seven_day', 'Semanal (7 dias)'],
      ['seven_day_opus', 'Semanal Opus'],
      ['seven_day_sonnet', 'Semanal Sonnet'],
    ] as const) {
      const blk = util?.[key];
      if (blk && typeof blk === 'object' && blk.utilization != null) {
        bars.push({
          kind: ({ five_hour: 'session', seven_day: 'weekly_all', seven_day_opus: 'weekly_opus', seven_day_sonnet: 'weekly_scoped' })[key],
          provider: 'claude',
          group: key,
          label,
          percent: typeof blk.utilization === 'number' ? blk.utilization : null,
          severity: 'normal',
          resets_at: blk.resets_at ?? null,
        });
      }
    }
  }

  let spend: Spend | null = null;
  const sp = util?.spend;
  if (sp?.enabled && sp.used && typeof sp.used === 'object') {
    const amt = (b: any): number | null => {
      if (!b || typeof b !== 'object') {
        return null;
      }
      return (b.amount_minor || 0) / Math.pow(10, b.exponent ?? 2);
    };
    spend = {
      used: amt(sp.used),
      limit: amt(sp.limit),
      currency: sp.used?.currency || '',
      percent: typeof sp.percent === 'number' ? sp.percent : null,
      severity: sp.severity || 'normal',
    };
  }

  return { bars, spend };
}

export class QuotaReader {
  private cfgMtime = 0;
  private cfgData: Account | undefined;
  private live: LiveRecord | undefined;
  private sharedMtime = 0;
  private fetching = false;
  private triedOnce = false;
  private lastError: string | undefined;

  constructor(private readonly ttlMs: () => number) {}

  /** ultimo erro de rede/token, para o tooltip */
  get error(): string | undefined {
    return this.lastError;
  }

  async account(): Promise<Account> {
    const base = (await this.readConfigCache()) ?? {
      bars: [],
      spend: null,
      age_s: null,
      source: 'none' as const,
    };

    await this.syncShared();

    const rec = this.live;
    const stale = !rec || Date.now() - rec.at > rec.waitMs;
    if (stale) {
      if (!this.triedOnce) {
        // primeira vez: sincrono, a janela precisa nascer com numero
        this.triedOnce = true;
        await this.fetchGuarded();
      } else {
        void this.fetchGuarded();
      }
    }

    const q = this.live;
    if (q && (q.bars.length > 0 || q.spend)) {
      const age = Math.floor((Date.now() - (q.fetchedAt ?? q.at)) / 1000);
      // se a consulta ao vivo esta mais velha que o cache do Claude Code, o
      // cache passou a ser a melhor informacao
      if (base.age_s != null && base.age_s < age && base.bars.length > 0) {
        return base;
      }
      return {
        ...base,
        bars: q.bars.length > 0 ? q.bars : base.bars,
        spend: q.spend !== null ? q.spend : base.spend,
        source: q.error ? 'cache' : 'live',
        fetched_ms: q.fetchedAt ?? q.at,
        age_s: age,
        account: q.sub,
      };
    }
    return base;
  }

  // ── cache local do proprio Claude Code (~/.claude.json) ────────────────
  private async readConfigCache(): Promise<Account | undefined> {
    let st;
    try {
      st = await fs.stat(CONFIG_FILE);
    } catch {
      return undefined;
    }
    // a idade e recalculada a cada leitura: congelada, o cache parecia mais
    // novo que a consulta ao vivo e o painel voltava para ele
    const aged = (acct: Account): Account => ({
      ...acct,
      age_s: acct.fetched_ms ? Math.floor((Date.now() - acct.fetched_ms) / 1000) : null,
    });
    if (this.cfgData && st.mtimeMs === this.cfgMtime) {
      return aged(this.cfgData);
    }

    let cfg: any;
    try {
      cfg = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
    } catch {
      // arquivo sendo reescrito: fica com o anterior
      return this.cfgData && aged(this.cfgData);
    }

    const cu = cfg?.cachedUsageUtilization ?? {};
    const oauth = cfg?.oauthAccount ?? {};
    const { bars, spend } = parseUtilization(cu.utilization ?? {});
    const fetched = typeof cu.fetchedAtMs === 'number' ? cu.fetchedAtMs : null;

    const notices: string[] = [];
    const raw = cfg?.cachedGrowthBookFeatures?.tengu_rate_limit_promo_notices;
    if (Array.isArray(raw)) {
      for (const n of raw) {
        if (n && typeof n === 'object' && typeof n.text === 'string' && n.text) {
          notices.push(n.text);
        }
      }
    }

    this.cfgData = {
      bars,
      spend,
      tier: String(oauth.userRateLimitTier || '').replace('default_', ''),
      email: oauth.emailAddress,
      fetched_ms: fetched,
      age_s: fetched ? Math.floor(Date.now() / 1000 - fetched / 1000) : null,
      source: 'cache',
      notices,
    };
    this.cfgMtime = st.mtimeMs;
    return this.cfgData;
  }

  // ── cache compartilhado entre janelas ──────────────────────────────────
  private async syncShared(): Promise<void> {
    let st;
    try {
      st = await fs.stat(QUOTA_CACHE);
    } catch {
      return;
    }
    if (st.mtimeMs === this.sharedMtime) {
      return;
    }
    try {
      const rec = JSON.parse(await fs.readFile(QUOTA_CACHE, 'utf8')) as LiveRecord;
      if (rec && typeof rec.at === 'number') {
        // so adota se for mais novo que o nosso
        if (!this.live || rec.at > this.live.at) {
          this.live = {
            at: rec.at,
            fetchedAt: rec.fetchedAt ?? rec.at,
            error: rec.error,
            waitMs: typeof rec.waitMs === 'number' ? rec.waitMs : this.ttlMs(),
            // caches criados antes da marca de provider pertencem ao Claude.
            bars: Array.isArray(rec.bars) ? rec.bars.map((bar) => ({ ...bar, provider: bar.provider ?? 'claude' })) : [],
            spend: rec.spend ?? null,
            sub: rec.sub,
          };
          this.triedOnce = true;
          this.lastError = rec.error;
        }
      }
      this.sharedMtime = st.mtimeMs;
    } catch {
      // arquivo pela metade: tenta de novo no proximo poll
    }
  }

  private async writeShared(rec: LiveRecord): Promise<void> {
    const tmp = `${QUOTA_CACHE}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(rec), 'utf8');
      await fs.rename(tmp, QUOTA_CACHE);
      const st = await fs.stat(QUOTA_CACHE);
      this.sharedMtime = st.mtimeMs;
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  private async acquireLock(retry = true): Promise<boolean> {
    try {
      await fs.mkdir(CLAUDE_DIR, { recursive: true });
      const fh = await fs.open(QUOTA_LOCK, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        return false;
      }
      if (!retry) {
        return false;
      }
      try {
        const st = await fs.stat(QUOTA_LOCK);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(QUOTA_LOCK, { force: true });
          return this.acquireLock(false);
        }
      } catch {
        return false;
      }
      return false; // outra janela esta buscando agora
    }
  }

  private async releaseLock(): Promise<void> {
    await fs.rm(QUOTA_LOCK, { force: true }).catch(() => undefined);
  }

  // ── consulta ao vivo ───────────────────────────────────────────────────
  private async fetchGuarded(): Promise<void> {
    if (this.fetching) {
      return;
    }
    this.fetching = true;
    try {
      if (!(await this.acquireLock())) {
        return; // outra janela ja esta cuidando disso
      }
      try {
        await this.syncShared();
        if (!this.live || Date.now() - this.live.at >= this.live.waitMs) await this.fetchLive();
      } finally {
        await this.releaseLock();
      }
    } finally {
      this.fetching = false;
    }
  }

  private async fetchLive(): Promise<void> {
    const prevWait = this.live?.waitMs ?? this.ttlMs();
    const fail = async (err: string, hard: boolean) => {
      this.lastError = err;
      // guarda o recuo TAMBEM no arquivo compartilhado, para as outras
      // janelas respeitarem o mesmo silencio
      const rec: LiveRecord = {
        at: Date.now(),
        fetchedAt: this.live?.fetchedAt ?? this.live?.at ?? 0,
        error: err,
        waitMs: hard ? Math.min(prevWait * 2, BACKOFF_MAX_MS) : this.ttlMs(),
        bars: this.live?.bars ?? [],
        spend: this.live?.spend ?? null,
        sub: this.live?.sub,
      };
      this.live = rec;
      await this.writeShared(rec);
    };

    let token: Token;
    try { token = await readToken(); } catch (e) {
      await fail((e as Error).message, false);
      return;
    }

    let body: string;
    try {
      body = await httpGet(QUOTA_URL, {
        authorization: `Bearer ${token.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        accept: 'application/json',
      });
    } catch (e) {
      const msg = (e as Error).message || 'erro de rede';
      await fail(msg, true);
      return;
    }

    let util: any;
    try {
      util = JSON.parse(body);
    } catch {
      await fail('resposta ilegivel', true);
      return;
    }

    const { bars, spend } = parseUtilization(util);
    if (bars.length === 0 && !spend) {
      await fail('resposta sem cotas', true);
      return;
    }

    this.lastError = undefined;
    const rec: LiveRecord = {
      at: Date.now(),
      fetchedAt: Date.now(),
      waitMs: this.ttlMs(), // sucesso: volta ao intervalo normal
      bars,
      spend,
      sub: token.subscriptionType,
    };
    this.live = rec;
    await this.writeShared(rec);
  }
}

interface Token {
  accessToken: string;
  subscriptionType?: string;
}

/**
 * O payload e o MESMO nos dois lugares (arquivo ou Keychain): um JSON com
 * `claudeAiOauth`. So muda de onde o texto vem.
 */
export function parseToken(raw: string): Token | undefined {
  let data: any;
  try {
    const value = raw.trim();
    data = JSON.parse(/^(?:[0-9a-f]{2})+$/i.test(value) ? Buffer.from(value, 'hex').toString('utf8') : value);
  } catch {
    return undefined;
  }
  const oa = data?.claudeAiOauth;
  if (!oa?.accessToken) {
    return undefined;
  }
  if (typeof oa.expiresAt === 'number' && oa.expiresAt <= Date.now()) {
    return undefined; // expirado: nao renovamos, cai para o cache
  }
  return { accessToken: oa.accessToken, subscriptionType: oa.subscriptionType };
}

/**
 * Le o item que o Claude Code guarda no Keychain do macOS. E o unico lugar
 * onde o token existe quando `.credentials.json` nao foi escrito — caso
 * comum no macOS. Somente leitura, como o arquivo: nunca reescrevemos.
 */
export function keychainService(configDir = process.env.CLAUDE_CONFIG_DIR): string {
  return KEYCHAIN_SERVICE + (configDir ? `-${createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)}` : '');
}

/** codigo de saida do `security` quando o item nao existe */
const KEYCHAIN_NOT_FOUND = 44;

function findPassword(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', ['find-generic-password', ...args, '-w'],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function keychainError(e: unknown): Error {
  const err = e as ExecException;
  return new Error(err.killed ? 'Keychain: tempo de autorização esgotado' :
    `Keychain: acesso indisponível (código ${err.code ?? 'desconhecido'}). Verifique a permissão no Acesso às Chaves.`);
}

async function readKeychainToken(): Promise<Token> {
  const service = ['-s', keychainService()];
  let stdout: string;
  try {
    // com a conta: se houver itens antigos de outro usuario, pega o certo
    stdout = await findPassword([...service, '-a', process.env.USER || os.userInfo().username]);
  } catch (e) {
    if ((e as ExecException).code !== KEYCHAIN_NOT_FOUND) {
      throw keychainError(e);
    }
    // conta gravada com outro nome: busca so pelo servico, como a 1.0.2
    try { stdout = await findPassword(service); } catch (e2) { throw keychainError(e2); }
  }
  const token = parseToken(stdout);
  if (!token) {
    throw new Error('Keychain: credencial inválida ou expirada. Faça login novamente no Claude Code.');
  }
  return token;
}

async function readToken(): Promise<Token> {
  // No macOS o Keychain é a fonte principal; um arquivo antigo pode pertencer a outro login.
  let keychainError: Error | undefined;
  if (process.platform === 'darwin') {
    try { return await readKeychainToken(); } catch (e) { keychainError = e as Error; }
  }
  try {
    const token = parseToken(await fs.readFile(CREDS_FILE, 'utf8'));
    if (token) return token;
  } catch { /* credencial ausente */ }
  throw keychainError ?? new Error('Credencial ausente ou expirada. Faça login no Claude Code.');
}

function httpGet(url: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers, timeout: 12_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new Error(`HTTP ${status}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
