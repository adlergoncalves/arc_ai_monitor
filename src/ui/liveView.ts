/**
 * A view da barra lateral — o "cantinho sempre a vista".
 *
 * E arrastavel para a barra lateral secundaria ou para o painel de baixo:
 * quem decide onde fica e o usuario, o VS Code cuida do resto. Nasce em modo
 * compacto porque a coluna tem ~300px e divide espaco com o codigo.
 */
import * as vscode from 'vscode';
import { LiveData } from '../engine/types';
import { buildHtml } from './webview';

export class LiveViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'arcAiMonitor.live';

  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly theme: () => string,
    private readonly onReady: () => void,
    private readonly onVisibility: () => void,
  ) {}

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = buildHtml(view.webview, this.extensionUri, {
      compact: true,
      theme: this.theme(),
    });

    view.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'ready') {
        this.onReady();
      }
    });
    view.onDidChangeVisibility(() => this.onVisibility());
    view.onDidDispose(() => {
      this.view = undefined;
      this.onVisibility();
    });
    // o resolve acontece com a view JA visivel e nao dispara
    // onDidChangeVisibility: sem esta chamada o poll ficaria no ritmo lento
    this.onVisibility();
  }

  post(data: LiveData): void {
    if (this.view?.visible) {
      void this.view.webview.postMessage({ type: 'data', payload: data });
    }
  }

  /** troca de tema exige remontar o HTML (a classe do body muda) */
  reload(): void {
    if (this.view) {
      this.view.webview.html = buildHtml(this.view.webview, this.extensionUri, {
        compact: true,
        theme: this.theme(),
      });
    }
  }

  reveal(): void {
    void vscode.commands.executeCommand(`${LiveViewProvider.viewId}.focus`);
  }
}
