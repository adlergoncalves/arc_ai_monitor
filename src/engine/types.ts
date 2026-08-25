/**
 * Formato do payload entregue aos webviews.
 *
 * Chaves em snake_case (age_s, resets_at, cwd_full): o payload atravessa a
 * fronteira do postMessage e e consumido por JS puro — o estilo segue o do
 * consumidor, nao o do TypeScript.
 */

export interface Turn {
  ts: string;
  model: string;
  i: number;
  o: number;
  cw: number;
  cr: number;
  /** contexto daquele turno: tudo que entrou (input + cache write + cache read) */
  ctx: number;
  cost: number;
}

export interface FileMeta {
  title?: string;
  branch?: string;
  /** pasta em que a sessao rodou, lida do proprio transcript */
  cwd?: string;
}

export interface QuotaBar {
  kind: string;
  group?: string | null;
  label: string;
  percent: number | null;
  severity: string;
  resets_at?: string | null;
}

export interface Spend {
  used: number | null;
  limit: number | null;
  currency: string;
  percent: number | null;
  severity: string;
}

export interface Account {
  bars: QuotaBar[];
  spend: Spend | null;
  tier?: string;
  email?: string;
  fetched_ms?: number | null;
  /** idade do dado em segundos */
  age_s: number | null;
  source: 'live' | 'cache' | 'none';
  /** tipo de assinatura devolvido pela consulta ao vivo */
  account?: string;
  notices?: string[];
}

export interface SessionCard {
  pid: number;
  sid: string;
  short: string;
  name: string;
  /** titulo que o proprio Claude Code gera conforme a conversa evolui */
  title?: string;
  branch?: string;
  product: string;
  cwd_full: string;
  started?: string;
  model: string;
  output: number;
  context: number;
  cost: number;
  turns: number;
  idle: number | null;
  /** a sessao roda numa pasta aberta nesta janela do VS Code */
  here: boolean;
  /** quantos subagentes esta sessao disparou (ja somados em output/cost) */
  subagents: number;
  /** saida gerada pelos subagentes, do total acima */
  sub_output: number;
}

/** soma de tokens de um recorte qualquer (dia, projeto, modelo) */
export interface Bucket {
  i: number;
  o: number;
  cw: number;
  cr: number;
  total: number;
  cost: number;
  turns: number;
}

export interface HistorySnapshot {
  ready: boolean;
  /** tamanho da janela em dias */
  window: number;
  days: { d: string; output: number; total: number; cost: number; turns: number }[];
  projects: { n: string; output: number; total: number; cost: number }[];
  models: { n: string; output: number; total: number; cost: number }[];
  totals: Bucket;
  scanned_at: number;
}

/**
 * Configuracao de telemetria OpenTelemetry do Claude Code, lida do bloco
 * `env` do ~/.claude/settings.json. Generica: qualquer organizacao pode
 * configurar esse export. Credenciais NUNCA aparecem aqui — o objeto vai
 * para o webview; so a PRESENCA do cabecalho de autenticacao e informada.
 */
export interface TelemetryStatus {
  /** existe alguma configuracao OTel no settings */
  configured: boolean;
  /** CLAUDE_CODE_ENABLE_TELEMETRY=1 */
  enabled: boolean;
  /** existe cabecalho de autenticacao (o valor jamais trafega) */
  hasAuth: boolean;
  endpoint?: string;
  protocol?: string;
  metricsExporter?: string;
  logsExporter?: string;
  metricIntervalMs?: number;
  logIntervalMs?: number;
  /** flags OTEL_LOG_* que capturariam CONTEUDO, com o estado real */
  privacy: { key: string; label: string; on: boolean }[];
}

/**
 * Reconstrucao do que o exporter OTLP desta maquina reporta.
 * Espelho calculado dos MESMOS transcripts — nao e interceptacao da rede,
 * e o equivalente local do que as metricas claude_code.* carregam.
 */
export interface DayWire {
  /** tamanho da janela de export (s) */
  win_s: number;
  /** o que entrou na ultima janela — e o que o proximo export leva */
  win: { i: number; o: number; cw: number; cr: number; total: number; cost: number; requests: number };
  /** claude_code.session.count — sessoes principais com atividade hoje */
  sessions: number;
  /** claude_code.active_time.total — estimado dos intervalos entre turnos */
  active_s: number;
}

export interface DaySlice {
  output: number;
  cost: number;
  turns: number;
  hours: { h: number; o: number }[];
  models: { n: string; o: number }[];
  /** composicao do que circulou hoje: entrada, saida, cache write, cache read */
  comp: { i: number; o: number; cw: number; cr: number; total: number };
  wire: DayWire;
}

export interface LiveData {
  now: string;
  date: string;
  account: Account;
  sessions: SessionCard[];
  active: number;
  day: DaySlice;
  /** ausente enquanto a primeira varredura nao termina */
  history?: HistorySnapshot;
  telemetry?: TelemetryStatus;
  /** intervalo de poll em vigor, so para o rodape do painel */
  every_ms: number;
  /** janela de contexto usada como 100% na barra das sessoes */
  ctx_max: number;
  error?: string;
}
