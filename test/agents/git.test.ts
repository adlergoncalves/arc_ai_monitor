// Contra um git de verdade, num repositório temporário: as operações destrutivas não podem depender de mock.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Git } from '../../src/agents/core/git';

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let repo: string, done: string, ahead: string, dirty: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'mc-git-'));
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@t'); g(repo, 'config', 'user.name', 't'); g(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), '1'); g(repo, 'add', '.'); g(repo, 'commit', '-q', '-m', 'inicial');
  done = join(repo, 'wt-done'); g(repo, 'worktree', 'add', '-q', '-b', 'feat/done', done);
  ahead = join(repo, 'wt-ahead'); g(repo, 'worktree', 'add', '-q', '-b', 'feat/ahead', ahead);
  writeFileSync(join(ahead, 'b.txt'), '2'); g(ahead, 'add', '.'); g(ahead, 'commit', '-q', '-m', 'trabalho novo');
  dirty = join(repo, 'wt-dirty'); g(repo, 'worktree', 'add', '-q', '-b', 'feat/dirty', dirty);
  writeFileSync(join(dirty, 'c.txt'), 'sujo');
});

describe('Git (repositório real)', () => {
  it('acha a branch padrão sem remoto', async () => {
    expect(await new Git().base(repo)).toBe('main');
  });
  it('diz se o HEAD já está na branch padrão e qual o último commit', async () => {
    const git = new Git();
    expect(await git.info(done, 'main')).toMatchObject({ merged: true, lastCommitSubject: 'inicial' });
    expect(await git.info(ahead, 'main')).toMatchObject({ merged: false, lastCommitSubject: 'trabalho novo' });
  });
  it('não remove worktree com arquivo novo (sem --force)', async () => {
    await expect(new Git().removeWorktree(repo, dirty)).rejects.toThrow();
    expect(existsSync(join(dirty, 'c.txt'))).toBe(true);
  });
  it('cria worktree com branch nova a partir da base, e recusa nome de branch que já existe', async () => {
    const git = new Git(), path = join(repo, '.claude', 'worktrees', 'feat-novo');
    await git.addWorktree(repo, path, 'feat/novo', 'main');
    expect(existsSync(join(path, 'a.txt'))).toBe(true);
    expect(g(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat/novo');
    await expect(git.addWorktree(repo, join(repo, 'outro'), 'feat/novo', 'main')).rejects.toThrow();
  });
  it('remove worktree limpo; a branch com commits continua, e só sai com -d se estiver mergeada', async () => {
    const git = new Git();
    await git.removeWorktree(repo, ahead);
    expect(existsSync(ahead)).toBe(false);
    expect(g(repo, 'branch', '--list', 'feat/ahead').trim()).toContain('feat/ahead');
    await expect(git.deleteBranch(repo, 'feat/ahead')).rejects.toThrow(); // não mergeada: o git recusa
    await git.removeWorktree(repo, done);
    await git.deleteBranch(repo, 'feat/done');
    expect(g(repo, 'branch', '--list', 'feat/done').trim()).toBe('');
  });
  it('remove worktree com arquivo ignorado em caminho acima de 260 caracteres (node_modules fundo no Windows)', async () => {
    const git = new Git(), path = join(repo, 'wt-fundo');
    g(repo, 'worktree', 'add', '-q', '-b', 'feat/fundo', path);
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'deep/\n');
    const dir = join(path, 'deep', ...Array.from({ length: 6 }, (_, i) => `pacote-${i}-`.padEnd(48, 'x')));
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'index.js'), '1');
    expect(join(dir, 'index.js').length).toBeGreaterThan(260);
    await git.removeWorktree(repo, path);
    expect(existsSync(path)).toBe(false);
  });
});
