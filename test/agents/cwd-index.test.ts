import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CwdIndex } from '../../src/agents/core/claude/cwd-index';

const rec = (cwd: string) => JSON.stringify({ type: 'user', cwd, message: { content: 'x' } }) + '\n';

describe('CwdIndex (em que pastas cada conversa trabalhou)', () => {
  it('acha a conversa pelo cwd gravado nos registros, inclusive subpasta do worktree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-idx-'));
    writeFileSync(join(dir, 'a.jsonl'), rec('C:\\repo') + rec('C:\\repo\\.claude\\worktrees\\feat-x') + rec('C:\\repo\\.claude\\worktrees\\feat-x\\web'));
    writeFileSync(join(dir, 'b.jsonl'), rec('C:\\repo'));
    const idx = new CwdIndex();
    await idx.refresh(dir);
    expect(idx.sessionsIn('C:/repo/.claude/worktrees/feat-x').map(f => f.id)).toEqual(['a']);
    expect(idx.sessionsIn('C:\\repo').map(f => f.id).sort()).toEqual(['a', 'b']);
  });
  it('lê só o que foi acrescentado desde a última passada', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-idx-'));
    writeFileSync(join(dir, 'a.jsonl'), rec('C:\\repo'));
    const idx = new CwdIndex();
    await idx.refresh(dir);
    appendFileSync(join(dir, 'a.jsonl'), rec('C:\\repo\\.claude\\worktrees\\novo'));
    const read = await idx.refresh(dir);
    expect(read).toBeLessThan(200); // bytes lidos na segunda passada: só a linha nova
    expect(idx.sessionsIn('C:\\repo\\.claude\\worktrees\\novo').map(f => f.id)).toEqual(['a']);
  });
  it('sobrevive a salvar e carregar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-idx-'));
    writeFileSync(join(dir, 'a.jsonl'), rec('C:\\repo\\x'));
    const a = new CwdIndex(); await a.refresh(dir);
    const b = CwdIndex.from(a.toJSON());
    expect(b.sessionsIn('C:\\repo\\x').map(f => f.id)).toEqual(['a']);
    expect(await b.refresh(dir)).toBe(0); // nada mudou: nada relido
  });
});
