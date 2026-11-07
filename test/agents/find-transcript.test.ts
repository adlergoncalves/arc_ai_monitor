import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeCwd, findTranscriptDir } from '../../src/agents/core/claude/paths';

describe('findTranscriptDir', () => {
  it('acha a conversa na pasta do cwd e, retomada pelo arquivo de outra pasta, onde ela continua gravando', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-proj-'));
    const main = join(root, encodeCwd('C:\\r')), wt = join(root, encodeCwd('C:\\r\\.claude\\worktrees\\a'));
    mkdirSync(main); mkdirSync(wt);
    writeFileSync(join(wt, 'aqui.jsonl'), '{}\n');
    writeFileSync(join(main, 'retomada.jsonl'), '{}\n'); // `claude --resume <arquivo>` no worktree segue gravando aqui
    expect(await findTranscriptDir(root, 'C:\\r\\.claude\\worktrees\\a', 'aqui')).toBe(wt);
    expect(await findTranscriptDir(root, 'C:\\r\\.claude\\worktrees\\a', 'retomada')).toBe(main);
    expect(await findTranscriptDir(root, 'C:\\r\\.claude\\worktrees\\a', 'nenhuma')).toBe(wt); // nova: a pasta do cwd
    expect(await findTranscriptDir(root, 'C:\\outro', 'nenhuma')).toBeUndefined();
  });
});
