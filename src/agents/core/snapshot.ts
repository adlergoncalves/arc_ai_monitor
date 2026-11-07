// Junta as sessões do provedor com o git: cada sessão cai no worktree que contém o seu cwd; os outros
// worktrees do mesmo repositório entram vazios.
import { basename } from 'node:path';
import { collectClaude } from './claude/provider';
import { Git, pathKey, projectName } from './git';
import type { SessionView, Snapshot, WorktreeView } from './types';
import { canRemove } from './worktree-rules';

export interface SnapshotOptions { claudeHome: string; recentSubagentMs: number; recentMessageMs?: number }

const rank = (w: WorktreeView) =>
  w.sessions.some(s => s.state === 'waiting') ? 0 : w.sessions.some(s => s.state === 'working' || s.subagents.some(a => a.state === 'working')) ? 1 : w.sessions.length ? 2 : 3;

export async function buildSnapshot(o: SnapshotOptions, git: Git): Promise<Snapshot> {
  const now = Date.now();
  const { sessions, messages } = await collectClaude({ home: o.claudeHome, now, recentSubagentMs: o.recentSubagentMs, recentMessageMs: o.recentMessageMs ?? 10 * 60_000 });

  const trees = new Map<string, WorktreeView>();
  const repos = new Set<string>();
  const mainOf = new Map<string, string>(); // worktree → checkout principal do repositório
  const loose: SessionView[] = [];
  for (const s of sessions) {
    const top = await git.toplevel(s.cwd);
    if (!top) { loose.push(s); continue; }
    const list = await git.worktrees(top);
    const main = list?.[0]?.path ?? top;
    if (!repos.has(pathKey(main))) {
      repos.add(pathKey(main));
      for (const w of list ?? [{ path: top, detached: false, bare: false }]) {
        const isMain = pathKey(w.path) === pathKey(main);
        trees.set(pathKey(w.path), { path: w.path, project: projectName(main), folder: isMain ? undefined : basename(w.path), branch: w.branch, isMain, sessions: [] });
        mainOf.set(pathKey(w.path), main);
      }
    }
    // sessão aberta numa subpasta do worktree também é dele
    (trees.get(pathKey(top)) ?? trees.set(pathKey(top), { path: top, project: projectName(main), isMain: false, folder: basename(top), sessions: [] }).get(pathKey(top))!).sessions.push(s);
  }
  for (const s of loose) {
    const k = pathKey(s.cwd);
    if (!trees.has(k)) trees.set(k, { path: s.cwd, project: basename(s.cwd), isMain: true, sessions: [] });
    trees.get(k)!.sessions.push(s);
  }

  const worktrees = [...trees.values()];
  await Promise.all(worktrees.map(async w => {
    const main = mainOf.get(pathKey(w.path));
    const [st, base] = await Promise.all([git.status(w.path), main ? git.base(main) : Promise.resolve(undefined)]);
    if (st) { w.branch = st.branch ?? w.branch; w.ahead = st.ahead; w.behind = st.behind; w.dirty = st.dirty; w.upstreamGone = st.upstreamGone; }
    w.base = base;
    const info = main ? await git.info(w.path, base) : undefined;
    if (info) { w.lastCommitAt = info.lastCommitAt; w.lastCommitSubject = info.lastCommitSubject; w.merged = info.merged; }
    w.repoPath = main;
    w.removal = main ? canRemove(w) : { ok: false, reason: 'não é um repositório git' };
  }));
  // com sessão: quem precisa de você primeiro; sem sessão: o mais recente primeiro
  worktrees.sort((a, b) => rank(a) - rank(b) || (rank(a) === 3 ? (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0) : 0) || a.project.localeCompare(b.project) || Number(b.isMain) - Number(a.isMain) || (a.folder ?? '').localeCompare(b.folder ?? ''));
  return { at: now, worktrees, messages };
}
