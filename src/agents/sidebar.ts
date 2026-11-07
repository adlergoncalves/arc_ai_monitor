import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Snapshot } from './core/types';

/** A lista compacta na barra de atividades: quem trabalha, quem espera; o selo conta quem espera você. */
export class Sidebar implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private last?: Snapshot;

  constructor(private readonly extensionUri: vscode.Uri, private readonly theme: () => string, private readonly onOpen: (sessionId?: string) => void) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: { type: string; sessionId?: string }) => {
      if (m.type === 'ready' && this.last) void view.webview.postMessage({ type: 'snapshot', data: this.last });
      if (m.type === 'open') this.onOpen(m.sessionId);
    });
    view.onDidDispose(() => { this.view = undefined; });
    if (this.last) this.update(this.last);
  }

  /** troca de paleta do monitor: remonta com a classe nova (o snapshot volta no "ready") */
  reload() { if (this.view) this.view.webview.html = this.html(this.view.webview); }

  // a mesma base da view "Ao vivo" do monitor: dashboard.css, modo compacto e a paleta escolhida
  private html(webview: vscode.Webview) {
    const nonce = randomBytes(16).toString('base64'), uri = (...f: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', ...f));
    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('dashboard.css')}"><link rel="stylesheet" href="${uri('agents', 'side.css')}"></head>
<body class="compact${this.theme() === 'vscode' ? ' theme-vscode' : ''}"><button class="ov-open open" id="open">ABRIR MAPA DE AGENTES</button><div id="list"></div>
<script nonce="${nonce}" src="${uri('agents', 'side.js')}"></script></body></html>`;
  }

  update(s: Snapshot) {
    this.last = s;
    if (!this.view) return;
    const waiting = s.worktrees.flatMap(w => w.sessions).filter(x => x.state === 'waiting');
    this.view.badge = waiting.length ? { value: waiting.length, tooltip: `Aguardando você: ${waiting.map(x => x.name).join(', ')}` } : undefined;
    void this.view.webview.postMessage({ type: 'snapshot', data: s });
  }
}
