import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { loadRecentMessages, sendToSession } from './core/claude/chat';
import { CwdIndex } from './core/claude/cwd-index';
import { pastSessions } from './core/claude/history';
import { claudeHome, findProjectDir } from './core/claude/paths';
import { pathKey } from './core/git';
import { OpenWorktrees } from './core/open-worktrees';
import type { SessionView, Snapshot, WorktreeView } from './core/types';
import { Monitor } from './monitor';
import { MapView, type MapHead, type PanelAction } from './panel';
import { Sidebar } from './sidebar';

const REASON: Record<string, string> = {
  'input needed': 'pede uma resposta sua', 'dialog open': 'tem um diálogo aberto', 'sandbox request': 'pede acesso fora do sandbox',
  'worker request': 'um worker pede aprovação', 'goal proposal': 'propõe um objetivo',
};

// Seção própria, fora de `arcAiMonitor`: mudar um ajuste dos agentes não pode disparar o recarregamento do monitor.
const SECTION = 'arcAiMonitorAgents';
/** Contexto que mostra a área (view, comandos): só existe para quem tem o Claude Code. */
const ENABLED = 'arcAiMonitor.agents.enabled';

/** O que o monitor oferece à área de agentes. O mapa não tem aba própria: vive no painel do monitor. */
export interface AgentsHost {
  /** abre (ou traz) o painel do monitor já na área de agentes */
  openAgents: () => void;
  /** paleta escolhida em `arcAiMonitor.theme`: o mapa segue a mesma */
  theme: () => string;
  /** o topo do mapa é o do monitor: a conta ("CLAUDE · e-mail") e a janela de contexto que conta como 100% */
  head: () => MapHead;
}
/** O que a área de agentes oferece ao monitor. */
export interface AgentsArea {
  /** existe Claude Code nesta máquina: a área aparece */
  enabled: () => boolean;
  /** põe o mapa no webview do painel; o Disposable tira */
  mount: (webview: vscode.Webview) => vscode.Disposable;
}

/** Área de agentes do monitor: worktree → sessões do Claude Code → subagentes. Só Claude; sem ele, a área não aparece. */
export function activateAgents(ctx: vscode.ExtensionContext, host: AgentsHost): AgentsArea {
  const cfg = () => vscode.workspace.getConfiguration(SECTION);
  const log = vscode.window.createOutputChannel('Arc AI Monitor · Agentes', { log: true });
  const sessions = new Map<string, SessionView>();
  const waiting = new Set<string>();
  let warmed = false;

  const panel = new MapView(ctx.extensionUri, host.theme, host.head, a => void act(a));
  const showMap = () => { host.openAgents(); if (monitor.last) panel.update(monitor.last); };
  const sidebar = new Sidebar(ctx.extensionUri, host.theme, id => { showMap(); if (id) panel.focus(id); });
  // prioridade alta: com a barra cheia, o item fica no começo e não some no fim da fila
  const bar = vscode.window.createStatusBarItem('arcAiMonitor.agents.status', vscode.StatusBarAlignment.Left, 10_000);
  bar.name = 'Arc AI Monitor · Agentes';
  bar.command = 'arcAiMonitor.agents.open';

  const monitor = new Monitor(
    () => ({ claudeHome: claudeHome(cfg().get('claudeHome')), intervalMs: Math.max(1, cfg().get('refreshSeconds', 2)) * 1000, recentSubagentMs: cfg().get('recentSubagentMinutes', 15) * 60_000 }),
    s => {
      if (opened.apply(s)) saveOpened();
      remember(s); paintBar(s); notify(s); panel.update(s); sidebar.update(s);
      // na primeira leitura, aquece o índice de conversas dos repositórios do mapa em segundo plano
      if (!warmed) { warmed = true; void indexRepos(s.worktrees.flatMap(w => w.repoPath ? [w.repoPath] : [])); }
    },
    e => log.error(String(e instanceof Error ? e.stack ?? e.message : e)),
  );

  // worktrees abertos no mapa (caixa como a do principal), por workspace
  const opened = OpenWorktrees.from(ctx.workspaceState.get('agents.openWorktrees'));
  const saveOpened = () => void ctx.workspaceState.update('agents.openWorktrees', opened.toJSON());
  function setOpen(path: string, on: boolean) {
    if (on) opened.open(path); else opened.close(path);
    const s = monitor.last;
    if (s) opened.apply(s);
    saveOpened();
    if (s) panel.update(s);
  }

  function remember(s: Snapshot) { sessions.clear(); for (const w of s.worktrees) for (const x of w.sessions) sessions.set(x.id, x); }

  function paintBar(s: Snapshot) {
    const all = s.worktrees.flatMap(w => w.sessions), work = all.filter(x => x.state === 'working').length, wait = all.filter(x => x.state === 'waiting');
    if (!all.length) { bar.hide(); return; }
    bar.text = `$(type-hierarchy) ${work}` + (wait.length ? `  $(bell-dot) ${wait.length}` : '');
    bar.tooltip = `${work} trabalhando · ${all.length - work - wait.length} parada(s)` + (wait.length ? `\nAguardando você: ${wait.map(x => x.name).join(', ')}` : '') + '\n\nAbrir o mapa de agentes';
    bar.backgroundColor = wait.length ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    bar.show();
  }

  // avisa uma vez quando a sessão entra em espera; volta a avisar se ela sair e entrar de novo
  function notify(s: Snapshot) {
    const now = new Set(s.worktrees.flatMap(w => w.sessions).filter(x => x.state === 'waiting').map(x => x.id));
    for (const id of [...waiting]) if (!now.has(id)) waiting.delete(id);
    for (const id of now) {
      if (waiting.has(id)) continue;
      waiting.add(id);
      if (!cfg().get('notifyWhenWaiting', true)) continue;
      const x = sessions.get(id)!;
      const why = x.waitingFor ? REASON[x.waitingFor] ?? x.waitingFor : 'espera você';
      const buttons = x.entrypoint === 'claude-vscode' ? ['Abrir sessão', 'Ver mapa'] : ['Ver mapa'];
      void vscode.window.showWarningMessage(`${x.name} ${why}.`, ...buttons).then(pick => {
        if (pick === 'Abrir sessão') void act({ type: 'openSession', sessionId: id });
        if (pick === 'Ver mapa') showMap();
      });
    }
  }

  const inThisWindow = (cwd: string) => (vscode.workspace.workspaceFolders ?? []).some(f => {
    const a = f.uri.fsPath.toLowerCase().replace(/[\\/]+$/, ''), b = cwd.toLowerCase().replace(/[\\/]+$/, '');
    return b === a || b.startsWith(a + '\\') || b.startsWith(a + '/');
  });

  async function act(a: PanelAction) {
    if (a.type === 'ready') return;
    if (a.type === 'wtNew') { await newWorktree(a.repo); return; }
    if (a.type === 'wtHistory') {
      const w = monitor.last?.worktrees.find(x => pathKey(x.path) === pathKey(a.path));
      await indexRepos([a.path, ...(w?.repoPath ? [w.repoPath] : [])]);
      const items = await pastSessions(claudeHome(cfg().get('claudeHome')), a.path, { exclude: new Set(sessions.keys()), limit: 8, extra: index.sessionsIn(a.path) }).catch(() => []);
      for (const i of items) pastFiles.set(i.id, i.file);
      panel.post({ type: 'history', path: a.path, items: items.map(({ file: _, ...i }) => i) });
      return;
    }
    if (a.type === 'pastResume') { await resume(a.path, a.sessionId); return; }
    if (a.type === 'chatLoad') {
      const s = sessions.get(a.sessionId);
      const items = s?.transcript ? await loadRecentMessages(s.transcript, 24).catch(() => []) : [];
      panel.post({ type: 'chat', sessionId: a.sessionId, items });
      return;
    }
    if (a.type === 'chatSend') {
      const s = sessions.get(a.sessionId);
      try {
        if (!s?.socket) throw new Error('a sessão não tem canal de mensagens');
        await sendToSession({ sessionsDir: join(claudeHome(cfg().get('claudeHome')), 'sessions'), pid: s.pid, socketPath: s.socket, text: a.text });
        log.info(`mensagem enviada para ${s.name} (${s.id})`);
        panel.post({ type: 'chatSent', sessionId: a.sessionId, ok: true });
      } catch (e) {
        log.warn(`mensagem para ${s?.name ?? a.sessionId} falhou: ${String(e)}`);
        panel.post({ type: 'chatSent', sessionId: a.sessionId, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if ('path' in a) { await worktree(a.type, a.path); return; }
    const s = sessions.get(a.sessionId);
    if (!s) return;
    if (a.type === 'terminal') { vscode.window.createTerminal({ name: s.name, cwd: s.cwd }).show(); return; }
    if (a.type === 'copyResume') {
      await vscode.env.clipboard.writeText(`cd "${s.cwd}" && claude --resume ${s.id}`);
      void vscode.window.showInformationMessage(`Comando de retomada de ${s.name} copiado.`);
      return;
    }
    if (a.type === 'openSession') {
      if (!inThisWindow(s.cwd)) {
        const pick = await vscode.window.showInformationMessage(`${s.name} está aberta em outra janela (${s.cwd}).`, 'Mostrar a pasta aqui');
        if (pick) await showHere(s.cwd);
        return;
      }
      // comando da extensão do Claude Code; recebe o id da sessão (interno, sem documentação)
      try { await vscode.commands.executeCommand('claude-vscode.editor.open', s.id); }
      catch (e) {
        log.warn(`claude-vscode.editor.open falhou: ${String(e)}`);
        void vscode.window.showWarningMessage(`Não consegui abrir ${s.name} pela extensão do Claude Code.`, 'Copiar retomada').then(p => { if (p) void act({ type: 'copyResume', sessionId: s.id }); });
      }
    }
  }

  // índice de cwds dos transcripts: salvo entre aberturas; cada passada só lê o que cresceu
  const indexFile = vscode.Uri.joinPath(ctx.globalStorageUri, 'agents-cwd-index.json');
  let index = new CwdIndex();
  let indexing: Promise<unknown> = (async () => { try { index = CwdIndex.from(JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(indexFile)).toString('utf8'))); } catch { /* primeira vez */ } })();
  function indexRepos(paths: string[]) {
    const run = async () => {
      const projects = join(claudeHome(cfg().get('claudeHome')), 'projects');
      let read = 0, t = Date.now();
      for (const p of new Set(paths)) { const d = await findProjectDir(projects, p); if (d) read += await index.refresh(d); }
      if (!read) return;
      log.info(`índice de conversas: ${(read / 1e6).toFixed(0)} MB lidos em ${Date.now() - t} ms`);
      await vscode.workspace.fs.createDirectory(ctx.globalStorageUri);
      await vscode.workspace.fs.writeFile(indexFile, Buffer.from(JSON.stringify(index), 'utf8'));
    };
    indexing = indexing.then(run, run).catch(e => log.warn(`índice de conversas: ${String(e)}`));
    return indexing;
  }

  // sessão antiga: com o repositório aberto nesta janela, volta pelo Claude do VS Code, como o "Abrir sessão";
  // fora dela, num terminal na pasta, pelo arquivo da conversa (`--resume` aceita o .jsonl, de qualquer pasta)
  const pastFiles = new Map<string, string>();
  async function resume(path: string, id: string) {
    if (inThisWindow(path)) {
      try { await vscode.commands.executeCommand('claude-vscode.editor.open', id); return; }
      catch (e) { log.warn(`claude-vscode.editor.open (retomar) falhou: ${String(e)}`); }
    }
    const file = pastFiles.get(id), name = basename(path);
    const t = vscode.window.createTerminal({ name: `claude · ${name}`, cwd: path });
    t.show(); t.sendText(`claude --resume ${file ? `"${file}"` : id}`);
    log.info(`retomando ${id} em ${path}${file ? ` (${file})` : ''}`);
  }

  // o worktree aparece nesta janela: revelado no Explorer se já estiver no workspace; senão, entra no workspace
  async function showHere(path: string) {
    const uri = vscode.Uri.file(path);
    if (!inThisWindow(path)) {
      const n = vscode.workspace.workspaceFolders?.length ?? 0;
      if (!vscode.workspace.updateWorkspaceFolders(n, 0, { uri, name: basename(path) })) { void vscode.window.showWarningMessage(`Não consegui adicionar ${basename(path)} ao workspace.`); return; }
      // o Explorer só enxerga a pasta nova depois que o workspace termina de mudar
      await new Promise<void>(ok => { const d = vscode.workspace.onDidChangeWorkspaceFolders(() => { d.dispose(); ok(); }); setTimeout(() => { d.dispose(); ok(); }, 3000); });
    }
    await vscode.commands.executeCommand('workbench.view.explorer');
    await vscode.commands.executeCommand('revealInExplorer', uri);
  }

  // repositórios conhecidos: os do mapa e os das pastas abertas nesta janela
  async function repos() {
    const out = new Map<string, string>();
    for (const w of monitor.last?.worktrees ?? []) if (w.repoPath) out.set(pathKey(w.repoPath), w.repoPath);
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      const top = await monitor.git.toplevel(f.uri.fsPath);
      const main = top ? (await monitor.git.worktrees(top))?.[0]?.path ?? top : undefined;
      if (main) out.set(pathKey(main), main);
    }
    return [...out.values()];
  }

  // repo: o painel do repositório já diz qual; sem ele (comando), pergunta
  async function newWorktree(repoHint?: string) {
    const list = repoHint ? [repoHint] : await repos();
    if (!list.length) { void vscode.window.showWarningMessage('Nenhum repositório git no mapa nem nesta janela.'); return; }
    const repo = list.length === 1 ? list[0]! : (await vscode.window.showQuickPick(list.map(p => ({ label: p.split(/[\\/]/).pop()!, description: p, p })), { title: 'Novo worktree · repositório' }))?.p;
    if (!repo) return;
    const existing = new Set(await monitor.git.branches(repo).catch(() => [] as string[]));
    const branch = (await vscode.window.showInputBox({
      title: 'Novo worktree · branch nova', prompt: 'Nome da branch; a pasta fica em .claude/worktrees/<nome>', placeHolder: 'feat/minha-tarefa',
      validateInput: v => !v.trim() ? 'Dê um nome à branch' : !/^[\w.\-/]+$/.test(v) || v.includes('..') || v.endsWith('/') ? 'Use letras, números, - _ . e /' : existing.has(v) ? 'Essa branch já existe' : undefined,
    }))?.trim();
    if (!branch) return;
    const base = await monitor.git.base(repo);
    const picks = [...new Set([base, ...existing].filter((b): b is string => !!b))].slice(0, 30);
    const from = (await vscode.window.showQuickPick(picks.map((b, i) => ({ label: b, description: i === 0 && b === base ? 'branch padrão' : undefined })), { title: `Novo worktree · ${branch} sai de` }))?.label;
    if (!from) return;
    const path = join(repo, '.claude', 'worktrees', branch.replace(/[\\/]/g, '-'));
    try { await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Criando ${branch}…` }, () => monitor.git.addWorktree(repo, path, branch, from)); }
    catch (e) { void vscode.window.showErrorMessage(`O git não criou o worktree: ${e instanceof Error ? e.message : String(e)}`); void monitor.tick(); return; }
    log.info(`worktree criado: ${path} (${branch} a partir de ${from})`);
    // o snapshot precisa ter o worktree novo antes de abrir a caixa dele, senão ela é esquecida como "sumiu"
    await monitor.tick();
    setOpen(path, true);
    const pick = await vscode.window.showInformationMessage(`Worktree ${branch} criado.`, 'Nova sessão aqui', 'Mostrar no Explorer');
    if (pick === 'Nova sessão aqui') await worktree('wtClaude', path);
    if (pick === 'Mostrar no Explorer') await showHere(path);
  }

  async function worktree(type: string, path: string) {
    // logo depois de criar, o snapshot ainda pode não ter o worktree: as ações simples não precisam dele
    const w = monitor.last?.worktrees.find(x => pathKey(x.path) === pathKey(path)) ?? (type === 'wtClaude' ? { path, folder: basename(path), project: '' } as WorktreeView : undefined);
    if (!w) return;
    const name = w.folder || w.branch || w.project, uri = vscode.Uri.file(w.path);
    if (type === 'wtShow' || type === 'wtClose') { setOpen(w.path, type === 'wtShow'); return; }
    if (type === 'wtOpen') { await showHere(w.path); return; }
    if (type === 'wtTerminal') { vscode.window.createTerminal({ name, cwd: w.path }).show(); return; }
    if (type === 'wtClaude') { setOpen(w.path, true); const t = vscode.window.createTerminal({ name: `claude · ${name}`, cwd: w.path }); t.show(); t.sendText('claude'); return; }
    if (type === 'wtReveal') { await vscode.commands.executeCommand('revealFileInOS', uri); return; }
    if (type === 'wtCopy') { await vscode.env.clipboard.writeText(w.path); void vscode.window.showInformationMessage(`Caminho de ${name} copiado.`); return; }
    if (type !== 'wtRemove') return;

    // a regra roda de novo aqui, com o estado de agora: o mapa pode estar 2 s atrás
    await monitor.tick();
    const now = monitor.last?.worktrees.find(x => pathKey(x.path) === pathKey(path));
    const rule = now?.removal;
    if (!now || !rule?.ok || !now.repoPath) { void vscode.window.showWarningMessage(`Não dá para remover ${name}: ${rule?.reason ?? 'o worktree sumiu do git'}.`); return; }
    const detail = [
      `Pasta: ${now.path}`,
      now.branch ? `Branch: ${now.branch} (continua no repositório)` : 'Sem branch (detached)',
      now.merged ? `Os commits já estão em ${now.base}.` : rule.warning ? `Atenção: ${rule.warning}.` : '',
      'Build, dependências e arquivos ignorados da pasta saem junto.',
    ].filter(Boolean).join('\n');
    if (await vscode.window.showWarningMessage(`Remover o worktree ${name}?`, { modal: true, detail }, 'Remover') !== 'Remover') return;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Removendo ${name}…` }, () => monitor.git.removeWorktree(now.repoPath!, now.path));
      log.info(`worktree removido: ${now.path}`);
    } catch (e) {
      log.error(`git worktree remove ${now.path}: ${String(e)}`);
      if (!await leftover(now.repoPath, now.path, name, e)) return;
    } finally { void monitor.tick(); }
    // a branch só sai com pedido, e com -d: o git recusa se ela não estiver mergeada
    const base = now.base?.replace(/^origin\//, '');
    if (now.merged && now.branch && now.branch !== base) {
      const pick = await vscode.window.showInformationMessage(`${name} removido. Apagar também a branch ${now.branch}? Ela já está em ${now.base}.`, 'Apagar branch');
      if (pick) {
        try { await monitor.git.deleteBranch(now.repoPath, now.branch); log.info(`branch apagada: ${now.branch}`); }
        catch (e) { void vscode.window.showErrorMessage(`O git não apagou ${now.branch}: ${e instanceof Error ? e.message : String(e)}`); }
        finally { void monitor.tick(); }
      }
    } else void vscode.window.showInformationMessage(`${name} removido.`);
  }

  // o git tira o worktree do registro antes de apagar a pasta: se o apagar falha (arquivo em uso), a pasta fica
  // órfã, já fora do git; só nesse caso o resto sai pelo Node. Devolve true quando a remoção terminou.
  async function leftover(repo: string, path: string, name: string, e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    monitor.git.forget();
    const still = (await monitor.git.worktrees(repo))?.some(w => pathKey(w.path) === pathKey(path)) ?? true;
    if (still || !existsSync(path)) { void vscode.window.showErrorMessage(`O git não removeu ${name}: ${msg}`); return false; }
    const pick = await vscode.window.showErrorMessage(`O git tirou ${name} do registro, mas não apagou a pasta: ${msg}`,
      { modal: true, detail: `Pasta: ${path}\nEla já não é worktree; o que sobrou é build, dependências e arquivos ignorados. Feche o que estiver rodando nela antes.` }, 'Apagar o que sobrou');
    if (!pick) return false;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Apagando o que sobrou de ${name}…` },
        () => rm(path, { recursive: true, maxRetries: 3 }));
      log.info(`pasta órfã apagada: ${path}`);
      return true;
    } catch (e2) {
      log.error(`rm ${path}: ${String(e2)}`);
      void vscode.window.showErrorMessage(`Não consegui apagar ${path}: ${e2 instanceof Error ? e2.message : String(e2)}`);
      return false;
    }
  }

  // Sem a pasta do Claude Code (quem usa só o Codex), a área some e nada é lido.
  let enabled = false;
  function sync() {
    enabled = existsSync(claudeHome(cfg().get('claudeHome')));
    void vscode.commands.executeCommand('setContext', ENABLED, enabled);
    if (enabled) monitor.start(); else { monitor.stop(); bar.hide(); }
  }
  const whenEnabled = (run: () => void) => () => {
    if (enabled) run();
    else void vscode.window.showInformationMessage('A área de agentes acompanha sessões do Claude Code, e ele não foi encontrado nesta máquina.');
  };

  ctx.subscriptions.push(
    log, bar,
    vscode.window.registerWebviewViewProvider('arcAiMonitor.agents', sidebar),
    vscode.commands.registerCommand('arcAiMonitor.agents.open', whenEnabled(() => showMap())),
    vscode.commands.registerCommand('arcAiMonitor.agents.refresh', whenEnabled(() => void monitor.tick())),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(SECTION)) sync();
      // a paleta é a do monitor; o mapa remonta pelo painel, a lista lateral aqui
      if (e.affectsConfiguration('arcAiMonitor.theme')) sidebar.reload();
    }),
    { dispose: () => monitor.stop() },
  );
  sync();
  return { enabled: () => enabled, mount: webview => panel.mount(webview) };
}
