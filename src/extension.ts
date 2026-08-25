import * as vscode from 'vscode';
import { Monitor, MonitorConfig } from './engine/monitor';
import { LiveData } from './engine/types';
import { LivePanel } from './ui/livePanel';
import { LiveViewProvider } from './ui/liveView';
import { StatusBar, StatusBarOptions, StatusKey } from './ui/statusBar';

const SECTION = 'arcAiMonitor';

export function activate(context: vscode.ExtensionContext): void {
  const monitor = new Monitor(readMonitorConfig, workspaceDirs);
  const statusBar = new StatusBar(readStatusBarOptions());

  const view = new LiveViewProvider(
    context.extensionUri,
    () => cfg().get<string>('theme', 'escuro'),
    () => pushLast(),
    () => syncBusy(),
  );

  const showPanel = (): LivePanel =>
    LivePanel.show(
      context.extensionUri,
      () => cfg().get<string>('theme', 'escuro'),
      () => pushLast(),
      () => syncBusy(),
    );

  function pushLast(): void {
    const d = monitor.last;
    if (d) {
      view.post(d);
      LivePanel.current?.post(d);
    }
  }

  function syncBusy(): void {
    monitor.setBusy(view.visible || (LivePanel.current?.visible ?? false));
  }

  const onData = (d: LiveData): void => {
    statusBar.update(d, monitor.quotaError);
    view.post(d);
    LivePanel.current?.post(d);
  };
  monitor.events.on('data', onData);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(LiveViewProvider.viewId, view, {
      webviewOptions: { retainContextWhenHidden: false },
    }),

    vscode.commands.registerCommand('arcAiMonitor.openPanel', () => {
      showPanel();
      syncBusy();
    }),

    vscode.commands.registerCommand('arcAiMonitor.refresh', async () => {
      await monitor.refreshNow();
    }),

    vscode.commands.registerCommand('arcAiMonitor.focusView', () => view.reveal()),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SECTION)) {
        return;
      }
      statusBar.setOptions(readStatusBarOptions());
      if (e.affectsConfiguration(`${SECTION}.theme`)) {
        view.reload();
        LivePanel.current?.reload();
      }
      void monitor.refreshNow();
    }),

    new vscode.Disposable(() => {
      monitor.events.off('data', onData);
      monitor.dispose();
    }),
    statusBar,
  );

  monitor.start();
}

export function deactivate(): void {
  // tudo que precisa de limpeza esta em context.subscriptions
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

function readMonitorConfig(): MonitorConfig {
  const c = cfg();
  return {
    refreshInterval: c.get<number>('refreshInterval', 3000),
    idleRefreshInterval: c.get<number>('idleRefreshInterval', 10000),
    quotaTtl: c.get<number>('quotaTtl', 150),
    contextWindow: c.get<number>('contextWindow', 1_000_000),
    historyDays: c.get<number>('historyDays', 30),
    pricing: c.get<object>('pricing', {}),
  };
}

function readStatusBarOptions(): StatusBarOptions {
  const c = cfg();
  return {
    enabled: c.get<boolean>('statusBar.enabled', true),
    alignment: c.get<'left' | 'right'>('statusBar.alignment', 'right'),
    priority: c.get<number>('statusBar.priority', 100),
    show: c.get<StatusKey[]>('statusBar.show', ['session', 'weekly_all', 'weekly_scoped']),
    meter: c.get<boolean>('statusBar.meter', false),
  };
}

function workspaceDirs(): string[] {
  return (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === 'file')
    .map((f) => f.uri.fsPath);
}
