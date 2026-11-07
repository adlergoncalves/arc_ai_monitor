import { execFile } from 'node:child_process';
import { basename, resolve } from 'node:path';

export interface WorktreeEntry { path: string; branch?: string; detached: boolean; bare: boolean }
export interface WorktreeStatus { branch?: string; upstream?: string; upstreamGone: boolean; ahead?: number; behind?: number; dirty: number }
export interface WorktreeInfo { lastCommitAt?: number; lastCommitSubject?: string; merged?: boolean }

/** chave de caminho que não muda com barra, maiúscula ou "\" no fim (Windows) */
export const pathKey = (p: string) => {
  const r = resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.replace(/\//g, '\\').toLowerCase() : r;
};

export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  return porcelain.split(/\r?\n\r?\n/).flatMap(block => {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const wt = lines.find(l => l.startsWith('worktree '));
    if (!wt) return [];
    const br = lines.find(l => l.startsWith('branch '));
    return [{ path: wt.slice(9), branch: br?.slice(7).replace(/^refs\/heads\//, ''), detached: lines.includes('detached'), bare: lines.includes('bare') }];
  });
}

export function parseStatus(porcelainV2: string): WorktreeStatus {
  const s: WorktreeStatus = { dirty: 0, upstreamGone: false };
  for (const l of porcelainV2.split(/\r?\n/)) {
    if (l.startsWith('# branch.head ')) { const h = l.slice(14); s.branch = h === '(detached)' ? undefined : h; }
    else if (l.startsWith('# branch.upstream ')) s.upstream = l.slice(18);
    else if (l.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(l); if (m) { s.ahead = +m[1]!; s.behind = +m[2]!; } }
    else if (/^[12u?] /.test(l)) s.dirty++;
  }
  // o git só escreve branch.ab quando o upstream existe; configurado e sem ab = apagado no remoto
  s.upstreamGone = !!s.upstream && s.ahead === undefined;
  return s;
}

export class GitError extends Error { constructor(message: string, readonly code?: number) { super(message); } }

// core.longpaths: no Windows, sem ele o git não apaga nem cria caminho acima de 260 caracteres (node_modules fundo)
const run = (cwd: string, args: string[], timeout = 5000) => new Promise<string>((ok, fail) =>
  execFile('git', ['-c', 'core.longpaths=true', ...args], { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (e, out, err) =>
    (e ? fail(new GitError((err || e.message).trim(), typeof e.code === 'number' ? e.code : undefined)) : ok(out))));

/** Resultado de git com validade: o mapa relê a cada 2 s, o git não precisa. */
class Ttl<T> {
  private m = new Map<string, { at: number; v: Promise<T | undefined> }>();
  constructor(private ms: number) {}
  get(key: string, load: () => Promise<T>): Promise<T | undefined> {
    const hit = this.m.get(key);
    if (hit && Date.now() - hit.at < this.ms) return hit.v;
    const v = load().catch(() => undefined);
    this.m.set(key, { at: Date.now(), v });
    return v;
  }
  clear() { this.m.clear(); }
}

export class Git {
  private top = new Ttl<string>(60_000);
  private list = new Ttl<WorktreeEntry[]>(15_000);
  private stat = new Ttl<WorktreeStatus>(8_000);
  private info_ = new Ttl<WorktreeInfo>(30_000);
  private base_ = new Ttl<string>(5 * 60_000);

  /** a raiz do worktree que contém `cwd`, ou nada quando não é git */
  toplevel(cwd: string) { return this.top.get(pathKey(cwd), async () => (await run(cwd, ['rev-parse', '--show-toplevel'])).trim()); }
  /** todos os worktrees do repositório; o primeiro é o checkout principal */
  worktrees(anyWorktree: string) { return this.list.get(pathKey(anyWorktree), async () => parseWorktreeList(await run(anyWorktree, ['worktree', 'list', '--porcelain'])).filter(w => !w.bare)); }
  status(worktree: string) { return this.stat.get(pathKey(worktree), async () => parseStatus(await run(worktree, ['status', '--porcelain=v2', '--branch']))); }

  /** a branch padrão: a que origin/HEAD aponta; sem remoto, main ou master locais */
  base(repo: string) {
    return this.base_.get(pathKey(repo), async () => {
      try { return (await run(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim(); } catch { /* sem origin/HEAD */ }
      for (const b of ['main', 'master']) { try { await run(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]); return b; } catch { /* não existe */ } }
      throw new GitError('sem branch padrão');
    });
  }

  /** último commit e se o HEAD já está em `base` (merge-base --is-ancestor: 0 = sim, 1 = não) */
  info(worktree: string, base: string | undefined) {
    return this.info_.get(pathKey(worktree) + '|' + base, async () => {
      const i: WorktreeInfo = {};
      const log = (await run(worktree, ['log', '-1', '--format=%ct%x09%s'])).trim();
      const tab = log.indexOf('\t');
      if (tab > 0) { i.lastCommitAt = +log.slice(0, tab) * 1000; i.lastCommitSubject = log.slice(tab + 1); }
      if (base) {
        try { await run(worktree, ['merge-base', '--is-ancestor', 'HEAD', base]); i.merged = true; }
        catch (e) { if (e instanceof GitError && e.code === 1) i.merged = false; }
      }
      return i;
    });
  }

  /** `git worktree add -b`: branch nova a partir de `base`; o git recusa branch que já existe */
  async addWorktree(mainWorktree: string, path: string, branch: string, base: string) { await run(mainWorktree, ['worktree', 'add', '-b', branch, path, base], 120_000); this.forget(); }
  /** branches locais, para sugerir a base */
  async branches(repo: string) { return (await run(repo, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads'])).split(/\r?\n/).filter(Boolean); }
  /** `git worktree remove` sem --force: o próprio git recusa se houver arquivo sujo */
  async removeWorktree(mainWorktree: string, path: string) { await run(mainWorktree, ['worktree', 'remove', path], 120_000); this.forget(); }
  /** `git branch -d`: o git recusa se a branch não estiver mergeada */
  async deleteBranch(mainWorktree: string, branch: string) { await run(mainWorktree, ['branch', '-d', branch]); this.forget(); }
  forget() { this.list.clear(); this.stat.clear(); this.info_.clear(); }
}

export const projectName = (mainPath: string) => basename(resolve(mainPath));
