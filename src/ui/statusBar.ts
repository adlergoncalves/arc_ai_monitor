/**
 * Cotas na status bar: `● 5h 37%  7d 33%  fable 21%`, em menta enquanto
 * tudo esta normal.
 *
 * Le como um componente unico, mas cada cota e um StatusBarItem proprio —
 * e a unica forma de dar severidade INDIVIDUAL: se o fable esta critico, so
 * ele acende vermelho; o semanal ao lado continua menta. Os itens ficam
 * adjacentes por prioridade fracionada (base, base-0.01, ...) e sem
 * separadores, para nao ler como pilulas soltas.
 *
 * Limites da status bar: texto + codicon, cor livre so no texto, fundo so
 * warning/error tematicos. Nada de fonte, tamanho ou SVG.
 */
import * as vscode from 'vscode';
import { LiveData, QuotaBar } from '../engine/types';

export type StatusKey =
  | 'session'
  | 'weekly_all'
  | 'weekly_opus'
  | 'weekly_scoped'
  | 'spend'
  | 'day_output'
  | 'day_cost'
  | 'sessions';

export interface StatusBarOptions {
  enabled: boolean;
  alignment: 'left' | 'right';
  priority: number;
  show: StatusKey[];
  /** barrinha ▰▰▱▱▱ ao lado do percentual de cada cota */
  meter: boolean;
}

const ABBR: Record<string, string> = {
  session: '5h',
  weekly_all: '7d',
  weekly_opus: 'opus',
  weekly_scoped: 'sem',
};

const SEV_RANK: Record<string, number> = { normal: 0, warning: 1, critical: 2 };

/** a menta — mesma identidade visual do painel */
const ACCENT = '#3ddc97';

interface Piece {
  text: string;
  sev: number;
}

export class StatusBar implements vscode.Disposable {
  private items: vscode.StatusBarItem[] = [];

  constructor(private options: StatusBarOptions) {
    this.update(undefined);
  }

  /** alignment e priority entram na criacao: derruba e recria no update */
  setOptions(options: StatusBarOptions): void {
    this.options = options;
    this.disposeItems();
    this.update(undefined);
  }

  update(d: LiveData | undefined, quotaError?: string): void {
    if (!this.options.enabled) {
      this.disposeItems();
      return;
    }
    const pieces = this.pieces(d);
    const tooltip = d
      ? this.tooltip(d, quotaError)
      : new vscode.MarkdownString('Arc AI Monitor: ainda lendo os arquivos locais…');

    this.ensure(pieces.length);
    pieces.forEach((p, i) => {
      const item = this.items[i];
      if (item.text !== p.text) {
        item.text = p.text;
      }
      // menta em estado normal; em warning/critical a cor sai — o fundo
      // tematico traz o proprio par de contraste
      item.color = p.sev === 0 ? ACCENT : undefined;
      item.backgroundColor =
        p.sev >= 2
          ? new vscode.ThemeColor('statusBarItem.errorBackground')
          : p.sev === 1
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;
      item.tooltip = tooltip;
    });
  }

  // ── montagem das pecas ───────────────────────────────────────────────
  private pieces(d: LiveData | undefined): Piece[] {
    if (!d) {
      return [{ text: '$(pulse) Claude', sev: 0 }];
    }

    const bars = d.account.bars;
    const byKind = new Map(bars.map((b) => [b.kind, b]));
    const out: Piece[] = [];

    for (const key of this.options.show) {
      switch (key) {
        case 'session':
        case 'weekly_all':
        case 'weekly_opus':
        case 'weekly_scoped': {
          const b = byKind.get(key);
          if (!b) {
            break;
          }
          // weekly_scoped e a cota de um modelo ("Semanal · Fable"): o nome
          // do modelo e o rotulo que informa
          let abbr = ABBR[key] ?? key;
          if (key === 'weekly_scoped') {
            const model = (b.label.split('·')[1] || '').trim().toLowerCase();
            if (model) {
              abbr = model;
            }
          }
          out.push({
            text: `${abbr} ${this.gauge(b.percent)}${pct(b.percent)}`,
            sev: SEV_RANK[(b.severity || 'normal').toLowerCase()] ?? 0,
          });
          break;
        }
        case 'spend': {
          const s = d.account.spend;
          if (!s) {
            break;
          }
          out.push({
            text: `cred ${this.gauge(s.percent)}${pct(s.percent)}`,
            sev: SEV_RANK[(s.severity || 'normal').toLowerCase()] ?? 0,
          });
          break;
        }
        case 'day_output':
          out.push({ text: short(d.day.output), sev: 0 });
          break;
        case 'day_cost':
          out.push({ text: `US$ ${Math.round(d.day.cost)}`, sev: 0 });
          break;
        case 'sessions':
          out.push({ text: `${d.active} ses`, sev: 0 });
          break;
      }
    }

    if (out.length === 0) {
      out.push({ text: 'Claude', sev: 0 });
    }

    // circulo cheio = numero veio da consulta oficial; vazio = cache local.
    // O icone mora no primeiro item.
    const fresh = d.account.source === 'live';
    const icon = d.error ? '$(warning)' : fresh ? '$(circle-filled)' : '$(circle-outline)';
    out[0] = { ...out[0], text: `${icon} ${out[0].text}` };
    return out;
  }

  /** ▰▰▱▱▱ — 5 segmentos de 20%. Vazio quando o meter esta desligado. */
  private gauge(v: number | null | undefined): string {
    if (!this.options.meter || v == null) {
      return '';
    }
    const filled = Math.max(0, Math.min(5, Math.round(v / 20)));
    return '▰'.repeat(filled) + '▱'.repeat(5 - filled) + ' ';
  }

  // ── ciclo de vida dos itens ──────────────────────────────────────────
  private ensure(n: number): void {
    while (this.items.length < n) {
      const i = this.items.length;
      const item = vscode.window.createStatusBarItem(
        `arcAiMonitor.quotas.${i}`,
        this.options.alignment === 'left'
          ? vscode.StatusBarAlignment.Left
          : vscode.StatusBarAlignment.Right,
        // prioridade fracionada: adjacentes, na ordem da lista `show`
        this.options.priority - i * 0.01,
      );
      item.name = 'Arc AI Monitor';
      item.command = 'arcAiMonitor.openPanel';
      item.show();
      this.items.push(item);
    }
    while (this.items.length > n) {
      this.items.pop()?.dispose();
    }
  }

  private disposeItems(): void {
    for (const item of this.items) {
      item.dispose();
    }
    this.items = [];
  }

  dispose(): void {
    this.disposeItems();
  }

  // ── tooltip (compartilhada por todos os itens) ───────────────────────
  private tooltip(d: LiveData, quotaError?: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    const src =
      d.account.source === 'live'
        ? 'consulta oficial'
        : d.account.source === 'cache'
          ? 'cache do Claude Code'
          : 'sem dado de cota';
    const age = d.account.age_s != null ? ` · lido ${ago(d.account.age_s)} atrás` : '';
    md.appendMarkdown(`**Arc AI Monitor**\n\n`);
    md.appendMarkdown(
      `${d.account.tier ? `plano ${d.account.tier.replace(/_/g, ' ')} · ` : ''}${src}${age}\n\n`,
    );

    if (d.account.bars.length > 0) {
      md.appendMarkdown('| cota | uso | |\n|---|---:|---|\n');
      for (const b of d.account.bars) {
        md.appendMarkdown(`| ${b.label} | ${pct(b.percent)} | ${until(b.resets_at)} |\n`);
      }
      md.appendMarkdown('\n');
    }
    const sp = d.account.spend;
    if (sp) {
      md.appendMarkdown(
        `Créditos extras: ${pct(sp.percent)} — ${sp.currency} ${fmt(sp.used)} de ${fmt(sp.limit)}\n\n`,
      );
    }

    md.appendMarkdown(
      `**Hoje** — ${short(d.day.output)} de saída · US$ ${Math.round(d.day.cost)} equiv. API · ${fmt(d.day.turns)} turnos\n\n`,
    );

    if (d.sessions.length > 0) {
      md.appendMarkdown(
        `**${d.sessions.length} ${d.sessions.length === 1 ? 'sessão ativa' : 'sessões ativas'}**\n\n`,
      );
      for (const s of d.sessions.slice(0, 8)) {
        const ctx = d.ctx_max > 0 ? Math.round((s.context / d.ctx_max) * 100) : 0;
        const hot = s.idle != null && s.idle < 90 ? '$(circle-filled) ' : '';
        md.appendMarkdown(
          `- ${hot}\`${s.product || s.name}\`${s.here ? ' _(aqui)_' : ''} · ${s.model || '?'} · ${ago(s.idle)} · ctx ${ctx}%\n`,
        );
      }
      if (d.sessions.length > 8) {
        md.appendMarkdown(`- … e mais ${d.sessions.length - 8}\n`);
      }
      md.appendMarkdown('\n');
    } else {
      md.appendMarkdown('_Nenhuma sessão ativa._\n\n');
    }

    if (quotaError) {
      md.appendMarkdown(`$(warning) cota ao vivo indisponível (${quotaError}) — usando o cache.\n\n`);
    }
    if (d.error) {
      md.appendMarkdown(`$(error) ${d.error}\n\n`);
    }

    md.appendMarkdown(
      '[Abrir painel](command:arcAiMonitor.openPanel) · ' +
        '[Barra lateral](command:arcAiMonitor.focusView)',
    );
    return md;
  }
}

function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${Math.round(v)}%`;
}

function fmt(n: number | null | undefined): string {
  return n == null ? '—' : new Intl.NumberFormat('pt-BR').format(Math.round(n));
}

function short(n: number): string {
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}mi`;
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  }
  return String(Math.round(n));
}

function ago(s: number | null | undefined): string {
  if (s == null) {
    return '—';
  }
  if (s < 10) {
    return 'agora';
  }
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}min`;
  }
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

function until(iso: QuotaBar['resets_at']): string {
  if (!iso) {
    return '';
  }
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) {
    return '';
  }
  if (ms <= 0) {
    return 'renovando';
  }
  const m = Math.floor(ms / 60000);
  if (m < 60) {
    return `renova em ${m}min`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `renova em ${h}h${String(m % 60).padStart(2, '0')}`;
  }
  return `renova em ${Math.floor(h / 24)}d${h % 24}h`;
}
