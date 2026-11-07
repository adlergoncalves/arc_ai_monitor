import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Snapshot } from './core/types';
import { mapBody } from './webview-body';

export type PanelAction =
  | { type: 'ready' }
  | { type: 'wtNew'; repo?: string }
  | { type: 'openSession' | 'terminal' | 'copyResume'; sessionId: string }
  | { type: 'wtShow' | 'wtClose' | 'wtOpen' | 'wtTerminal' | 'wtClaude' | 'wtReveal' | 'wtCopy' | 'wtRemove' | 'wtHistory'; path: string }
  | { type: 'pastResume'; path: string; sessionId: string }
  | { type: 'chatLoad'; sessionId: string }
  | { type: 'chatSend'; sessionId: string; text: string };

/**
 * O mapa de agentes. Não tem aba própria: monta-se no painel do monitor quando a pessoa escolhe AGENTES
 * (é um produto só) e sai quando ela volta ao MONITOR. A troca de área (`type: 'area'`) é do painel, não daqui.
 */
/** O que o topo e os cartões do mapa pegam do monitor, para dizer o mesmo que ele. */
export interface MapHead {
  /** "CLAUDE · e-mail", como no topo do monitor; vazio sem cota lida */
  ident: string;
  /** a janela de contexto que conta como 100% na barra de contexto (`arcAiMonitor.contextWindow`) */
  ctxMax: number;
  /** frescor da cota ("CLAUDE ● agora"), com os mesmos dados que o topo do monitor usa */
  fresh: { source: string; ageS: number | null } | null;
}

export class MapView {
  private webview?: vscode.Webview;
  private last?: Snapshot;
  private ready = false;
  private pendingFocus?: string;

  constructor(private readonly extensionUri: vscode.Uri, private readonly theme: () => string, private readonly head: () => MapHead, private readonly onAction: (a: PanelAction) => void) {}

  /** Põe o mapa no webview; o Disposable devolvido tira (o painel chama ao voltar ao monitor ou ao fechar). */
  mount(webview: vscode.Webview): vscode.Disposable {
    this.webview = webview;
    this.ready = false;
    webview.html = html(webview, this.extensionUri, this.theme());
    const sub = webview.onDidReceiveMessage((m: PanelAction | { type: 'area' }) => {
      if (m.type === 'area') return;
      if (m.type !== 'ready') { this.onAction(m); return; }
      this.ready = true;
      if (this.last) void webview.postMessage({ type: 'snapshot', data: this.last, head: this.head() });
      if (this.pendingFocus) { this.focus(this.pendingFocus); this.pendingFocus = undefined; }
    });
    return new vscode.Disposable(() => {
      sub.dispose();
      if (this.webview === webview) { this.webview = undefined; this.ready = false; }
    });
  }

  /** Resposta a um pedido do mapa (histórico, envio do chat). */
  post(message: unknown) { void this.webview?.postMessage(message); }

  /** Seleciona a sessão no mapa; se ele acabou de montar, espera ficar pronto. */
  focus(sessionId: string) {
    if (!this.webview || !this.ready) { this.pendingFocus = sessionId; return; }
    void this.webview.postMessage({ type: 'select', id: sessionId });
  }

  get visible() { return !!this.webview; }

  update(s: Snapshot) {
    this.last = s;
    void this.webview?.postMessage({ type: 'snapshot', data: s, head: this.head() });
  }
}

// o dashboard.css do monitor vem primeiro: paleta, fontes, tema, reator e topo são os dele
function html(webview: vscode.Webview, extensionUri: vscode.Uri, theme: string) {
  const nonce = randomBytes(16).toString('base64');
  const uri = (...f: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', ...f));
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('dashboard.css')}">
<link rel="stylesheet" href="${uri('agents', 'map.css')}">
<title>Arc AI Monitor · Agentes</title>
</head>
<body class="${theme === 'vscode' ? 'theme-vscode' : ''}">
${mapBody()}
<script nonce="${nonce}" src="${uri('agents', 'map.js')}"></script>
</body>
</html>`;
}
