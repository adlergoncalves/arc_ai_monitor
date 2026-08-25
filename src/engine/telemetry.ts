/**
 * Configuracao de telemetria OpenTelemetry do Claude Code — recurso NATIVO
 * do CLI (CLAUDE_CODE_ENABLE_TELEMETRY + variaveis OTEL_*), que qualquer
 * organizacao pode ter configurado no ~/.claude/settings.json.
 *
 * REGRA DURA: credencial nunca sai daqui. O OTEL_EXPORTER_OTLP_HEADERS
 * carrega o cabecalho de autenticacao; este modulo devolve apenas SE existe
 * um, jamais o valor.
 *
 * Tudo aqui e leitura; nada e escrito.
 */
import * as fs from 'fs/promises';
import { SETTINGS_FILE } from './paths';
import { TelemetryStatus } from './types';

/**
 * As flags que capturariam CONTEUDO — prompt, respostas, codigo, argumentos
 * de ferramenta e corpo cru da API. Todas desligadas por padrao no Claude
 * Code; aqui sao LIDAS do settings e mostradas com o estado real.
 */
const PRIVACY_KEYS: { key: string; label: string }[] = [
  { key: 'OTEL_LOG_USER_PROMPTS', label: 'texto dos prompts' },
  { key: 'OTEL_LOG_ASSISTANT_RESPONSES', label: 'respostas do modelo' },
  { key: 'OTEL_LOG_TOOL_CONTENT', label: 'conteúdo das ferramentas' },
  { key: 'OTEL_LOG_TOOL_DETAILS', label: 'detalhes das ferramentas' },
  { key: 'OTEL_LOG_RAW_API_BODIES', label: 'corpo cru da API' },
];

const NOT_CONFIGURED: TelemetryStatus = {
  configured: false,
  enabled: false,
  hasAuth: false,
  privacy: PRIVACY_KEYS.map(({ key, label }) => ({ key, label, on: false })),
};

export class TelemetryReader {
  private mtime = 0;
  private cached: TelemetryStatus | undefined;

  async read(): Promise<TelemetryStatus> {
    let st;
    try {
      st = await fs.stat(SETTINGS_FILE);
    } catch {
      return NOT_CONFIGURED;
    }
    if (this.cached && st.mtimeMs === this.mtime) {
      return this.cached;
    }

    let cfg: any;
    try {
      cfg = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
    } catch {
      return this.cached ?? NOT_CONFIGURED; // arquivo sendo reescrito
    }
    const env: Record<string, string> = (cfg?.env as Record<string, string>) ?? {};

    const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
    this.cached = {
      configured:
        env.CLAUDE_CODE_ENABLE_TELEMETRY === '1' ||
        !!endpoint ||
        !!env.OTEL_METRICS_EXPORTER ||
        !!env.OTEL_LOGS_EXPORTER,
      enabled: env.CLAUDE_CODE_ENABLE_TELEMETRY === '1',
      // presenca do cabecalho, nunca o valor
      hasAuth: /\S/.test(env.OTEL_EXPORTER_OTLP_HEADERS || ''),
      endpoint,
      protocol: env.OTEL_EXPORTER_OTLP_PROTOCOL,
      metricsExporter: env.OTEL_METRICS_EXPORTER,
      logsExporter: env.OTEL_LOGS_EXPORTER,
      metricIntervalMs: numOrUndef(env.OTEL_METRIC_EXPORT_INTERVAL),
      logIntervalMs: numOrUndef(env.OTEL_LOGS_EXPORT_INTERVAL),
      privacy: PRIVACY_KEYS.map(({ key, label }) => ({ key, label, on: isOn(env[key]) })),
    };
    this.mtime = st.mtimeMs;
    return this.cached;
  }
}

function numOrUndef(v: string | undefined): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function isOn(v: string | undefined): boolean {
  const s = String(v ?? '').toLowerCase();
  return s === '1' || s === 'true';
}
