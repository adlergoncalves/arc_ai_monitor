/**
 * O painel completo — uma aba comum, e por isso mesmo arrastavel para uma
 * janela flutuante ("Move Into New Window"), que por sua vez aceita
 * `workbench.action.enableWindowAlwaysOnTop`.
 *
 * `retainContextWhenHidden` fica LIGADO de proposito: sem ele, mover a aba
 * para outra janela ou trocar de aba recria o webview e o painel pisca vazio
 * ate o proximo poll.
 *
 * A aba tem duas areas, trocadas pelo MONITOR | AGENTES do topo: o monitor
 * (este painel) e o mapa de agentes, que se monta no mesmo webview. E um
 * produto so: a troca nao abre outra aba.
 */
import * as vscode from 'vscode';
import { LiveData } from '../engine/types';
import { buildHtml } from './webview';

export type PanelArea = 'monitor' | 'agents';

/**
 * A area de agentes vista daqui. `agents()` diz se ela existe (so com o
 * Claude Code); `mount` poe o mapa no webview e devolve como tirar.
 */
export interface PanelAreas {
  agents: () => boolean;
  mount: (webview: vscode.Webview) => vscode.Disposable;
}

export class LivePanel {
  static readonly viewType = 'arcAiMonitor.panel';
  private static instance: LivePanel | undefined;

  /** o mapa montado no webview, quando a area e a de agentes */
  private mounted: vscode.Disposable | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly theme: () => string,
    private readonly onReady: () => void,
    private readonly onVisibility: () => void,
    private readonly areas: PanelAreas | undefined,
    private area: PanelArea,
  ) {
    this.render();
    panel.webview.onDidReceiveMessage((msg) => {
      if (msg?.type === 'area' && (msg.area === 'monitor' || msg.area === 'agents')) {
        this.setArea(msg.area);
        return;
      }
      // na area de agentes as mensagens sao do mapa, que as trata no mount
      if (msg?.type === 'ready' && this.area === 'monitor') {
        this.onReady();
      }
    });
    panel.onDidChangeViewState(() => this.onVisibility());
    panel.onDidDispose(() => {
      this.mounted?.dispose();
      this.mounted = undefined;
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
    areas?: PanelAreas,
    /** area a mostrar; vazio = a que ja esta na tela (o monitor, ao criar) */
    area?: PanelArea,
  ): LivePanel {
    if (LivePanel.instance) {
      if (area) {
        LivePanel.instance.setArea(area);
      }
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
    LivePanel.instance = new LivePanel(panel, extensionUri, theme, onReady, onVisibility, areas, area ?? 'monitor');
    return LivePanel.instance;
  }

  /** o MONITOR esta na tela: e o que acelera o poll do monitor */
  get visible(): boolean {
    return this.panel.visible && this.area === 'monitor';
  }

  post(data: LiveData): void {
    if (this.visible) {
      void this.panel.webview.postMessage({ type: 'data', payload: data });
    }
  }

  reload(): void {
    this.render();
  }

  private setArea(area: PanelArea): void {
    if (area === this.area) {
      return;
    }
    this.area = area;
    this.render();
    this.onVisibility();
  }

  private render(): void {
    this.mounted?.dispose();
    this.mounted = undefined;
    if (this.area === 'agents' && this.areas?.agents()) {
      this.mounted = this.areas.mount(this.panel.webview);
      return;
    }
    this.area = 'monitor';
    this.panel.webview.html = buildHtml(this.panel.webview, this.extensionUri, {
      compact: false,
      theme: this.theme(),
      agents: this.areas?.agents() ?? false,
    });
  }
}
