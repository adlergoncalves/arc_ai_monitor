/**
 * O painel completo — uma aba comum, e por isso mesmo arrastavel para uma
 * janela flutuante ("Move Into New Window"), que por sua vez aceita
 * `workbench.action.enableWindowAlwaysOnTop`.
 *
 * `retainContextWhenHidden` fica LIGADO de proposito: sem ele, mover a aba
 * para outra janela ou trocar de aba recria o webview e o painel pisca vazio
 * ate o proximo poll.
 */
import * as vscode from 'vscode';
import { LiveData } from '../engine/types';
import { buildHtml } from './webview';

export class LivePanel {
  static readonly viewType = 'arcAiMonitor.panel';
  private static instance: LivePanel | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly theme: () => string,
    private readonly onReady: () => void,
    private readonly onVisibility: () => void,
  ) {
    this.render();
    panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'ready') {
        this.onReady();
      }
    });
    panel.onDidChangeViewState(() => this.onVisibility());
    panel.onDidDispose(() => {
      LivePanel.instance = undefined;
      this.onVisibility();
    });
  }

  static get current(): LivePanel | undefined {
    return LivePanel.instance;
  }

  static show(
    extensionUri: vscode.Uri,
    theme: () => string,
    onReady: () => void,
    onVisibility: () => void,
  ): LivePanel {
    if (LivePanel.instance) {
      LivePanel.instance.panel.reveal(undefined, false);
      return LivePanel.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      LivePanel.viewType,
      'Arc AI Monitor',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');
    LivePanel.instance = new LivePanel(panel, extensionUri, theme, onReady, onVisibility);
    return LivePanel.instance;
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  post(data: LiveData): void {
    if (this.panel.visible) {
      void this.panel.webview.postMessage({ type: 'data', payload: data });
    }
  }

  reload(): void {
    this.render();
  }

  private render(): void {
    this.panel.webview.html = buildHtml(this.panel.webview, this.extensionUri, {
      compact: false,
      theme: this.theme(),
    });
  }
}
