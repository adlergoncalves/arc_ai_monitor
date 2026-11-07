import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeCwd } from '../../src/agents/core/claude/paths';
import { pastSessions } from '../../src/agents/core/claude/history';

const line = (o: unknown) => JSON.stringify(o) + '\n';

describe('pastSessions (sessões anteriores de um worktree)', () => {
  it('lista as conversas da pasta, mais recente primeiro, com título, última atividade e modelo; deixa de fora as vivas', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mc-hist-')), cwd = 'C:\\repo\\.claude\\worktrees\\feat-x';
    const dir = join(home, 'projects', encodeCwd(cwd)); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old.jsonl'), line({ type: 'ai-title', aiTitle: 'Conversa antiga' }) + line({ type: 'assistant', timestamp: '2026-10-20T10:00:00Z', message: { model: 'claude-sonnet-5-5', content: [] } }));
    writeFileSync(join(dir, 'new.jsonl'), line({ type: 'ai-title', aiTitle: 'Conversa nova' }) + line({ type: 'assistant', timestamp: '2026-10-29T10:00:00Z', message: { model: 'claude-opus-5-5', content: [] } }));
    writeFileSync(join(dir, 'live.jsonl'), line({ type: 'ai-title', aiTitle: 'Viva' }));
    writeFileSync(join(dir, 'vazio.jsonl'), '');
    utimesSync(join(dir, 'old.jsonl'), new Date('2026-10-20'), new Date('2026-10-20'));
    utimesSync(join(dir, 'new.jsonl'), new Date('2026-10-29'), new Date('2026-10-29'));
    const got = await pastSessions(home, cwd, { exclude: new Set(['live']), limit: 10 });
    expect(got.map(s => s.id)).toEqual(['new', 'old']);
    expect(got[0]).toMatchObject({ title: 'Conversa nova', model: 'claude-opus-5-5', lastAt: Date.parse('2026-10-29T10:00:00Z') });
  });
  it('inclui conversa guardada em outra pasta que trabalhou no worktree (achada pelo índice), sem repetir', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mc-hist-')), cwd = 'C:\\repo\\.claude\\worktrees\\feat-y';
    const main = join(home, 'projects', encodeCwd('C:\\repo')); mkdirSync(main, { recursive: true });
    writeFileSync(join(main, 'm1.jsonl'), line({ type: 'ai-title', aiTitle: 'Feita do principal' }) + line({ type: 'user', cwd, timestamp: '2026-10-28T10:00:00Z', message: { content: 'x' } }));
    const got = await pastSessions(home, cwd, { exclude: new Set(), limit: 10, extra: [{ id: 'm1', file: join(main, 'm1.jsonl') }, { id: 'm1', file: join(main, 'm1.jsonl') }] });
    // o arquivo vai junto: retomar de dentro do worktree precisa dele (a conversa está na pasta do principal)
    expect(got).toEqual([expect.objectContaining({ id: 'm1', title: 'Feita do principal', file: join(main, 'm1.jsonl') })]);
  });
  it('pasta sem histórico devolve lista vazia', async () => {
    expect(await pastSessions(mkdtempSync(join(tmpdir(), 'mc-hist-')), 'C:\\nada', { exclude: new Set(), limit: 5 })).toEqual([]);
  });
});
