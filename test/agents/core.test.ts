import { describe, expect, it } from 'vitest';
import { describeTool, shortModel } from '../../src/agents/core/describe';
import { encodeCwd } from '../../src/agents/core/claude/paths';
import { displayName, parseSessionRecord, readSessionRecords, toState } from '../../src/agents/core/claude/sessions';
import { readSubagents, subagentState } from '../../src/agents/core/claude/subagents';
import { summarize, summarizeFile } from '../../src/agents/core/claude/transcript';
import { parseStatus, parseWorktreeList } from '../../src/agents/core/git';
import type { WorktreeView } from '../../src/agents/core/types';
import { canRemove } from '../../src/agents/core/worktree-rules';

describe('describeTool', () => {
  it('resume cada ferramenta pelo que importa nela', () => {
    expect(describeTool('Edit', { file_path: 'C:\\repo\\src\\billing\\invoice.ts' })).toBe('Edit · invoice.ts');
    expect(describeTool('Bash', { command: 'npm test', description: 'Roda os testes' })).toBe('Bash · Roda os testes');
    expect(describeTool('Bash', { command: 'npm   test\n --watch' })).toBe('Bash · npm test --watch');
    expect(describeTool('Grep', { pattern: 'charge(' })).toBe('Grep · charge(');
    expect(describeTool('mcp__azure-devops__wit_query', {})).toBe('azure-devops · wit_query');
    expect(describeTool('TodoWrite', {})).toBe('TodoWrite');
  });
  it('corta linha longa', () => {
    expect(describeTool('Bash', { command: 'x'.repeat(200) }).length).toBe(80);
  });
});

describe('shortModel', () => {
  it('lê os ids do Claude', () => {
    expect(shortModel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(shortModel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(shortModel('claude-haiku-5-5')).toBe('Haiku 5.5');
    expect(shortModel(undefined)).toBeUndefined();
  });
});

describe('encodeCwd', () => {
  it('troca tudo que não é letra ou número por hífen, como o Claude Code', () => {
    expect(encodeCwd('c:\\PROJETOS\\HBA TOOLS\\feira-principal')).toBe('c--PROJETOS-HBA-TOOLS-feira-principal');
  });
});

describe('registro de sessão', () => {
  const base = { pid: 10, sessionId: 's1', cwd: 'c:\\r', kind: 'interactive', status: 'waiting', waitingFor: 'input needed', needs: 'choose: allow or deny', statusUpdatedAt: 5 };
  it('lê o registro e o estado', () => {
    const r = parseSessionRecord(base)!;
    expect(r.waitingFor).toBe('input needed');
    expect(r.needs).toBe('choose: allow or deny');
    expect(toState(r.status)).toBe('waiting');
    expect(toState('busy')).toBe('working');
    expect(toState('idle')).toBe('idle');
    expect(toState(undefined)).toBe('idle');
  });
  it('nome de exibição: o que a pessoa deu; derivado perde para o título da conversa', () => {
    expect(displayName({ ...parseSessionRecord(base)!, name: 'feira-principal-ca', nameSource: 'derived' }, 'Projeto Mission Control')).toBe('Projeto Mission Control');
    expect(displayName({ ...parseSessionRecord(base)!, name: 'pagamentos', nameSource: 'user' }, 'Outro título')).toBe('pagamentos');
    expect(displayName({ ...parseSessionRecord(base)!, name: 'feira-principal-ca', nameSource: 'derived' }, undefined)).toBe('feira-principal-ca');
    expect(parseSessionRecord({ ...base, nameSource: 'derived' })!.nameSource).toBe('derived');
  });
  it('recusa registro incompleto e tipo de sessão que não é de pessoa', () => {
    expect(parseSessionRecord({ pid: 1 })).toBeUndefined();
    expect(parseSessionRecord({ ...base, kind: 'sdk' })).toBeUndefined();
  });
  it('lê a pasta e deixa de fora processo morto', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'mc-'));
    await writeFile(join(dir, '10.json'), JSON.stringify(base));
    await writeFile(join(dir, '11.json'), JSON.stringify({ ...base, pid: 11, sessionId: 's2' }));
    await writeFile(join(dir, '12.json'), '{"pid": 12, "sessio');
    const got = await readSessionRecords(dir, pid => pid === 10);
    expect(got.map(r => r.sessionId)).toEqual(['s1']);
  });
});

const T = (iso: string) => ({ timestamp: iso });
const assistant = (iso: string, content: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'assistant', ...T(iso), message: { model: 'claude-opus-5-5', content, ...extra } });
const user = (iso: string, content: unknown[]) => ({ type: 'user', ...T(iso), message: { content } });

describe('summarize (transcript)', () => {
  it('pega modelo, contexto e a última ferramenta, pendente até o resultado voltar', () => {
    const s = summarize([
      assistant('2026-10-30T10:00:00Z', [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x/a.ts' } }], { usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, output_tokens: 20 } }),
      user('2026-10-30T10:00:01Z', [{ type: 'tool_result', tool_use_id: 'a' }]),
      assistant('2026-10-30T10:00:02Z', [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm test' } }]),
    ]);
    expect(s.model).toBe('claude-opus-5-5');
    expect(s.contextTokens).toBe(1035);
    expect(s.lastTool).toMatchObject({ text: 'Bash · npm test', pending: true });
    expect(s.firstAt).toBe(Date.parse('2026-10-30T10:00:00Z'));
  });
  it('marca resultado com erro, mensagem enviada e handback', () => {
    const s = summarize([
      assistant('2026-10-30T10:00:00Z', [{ type: 'tool_use', id: 'ag', name: 'Agent', input: { description: 'Testes' } }]),
      user('2026-10-30T10:00:05Z', [{ type: 'tool_result', tool_use_id: 'ag', is_error: true }]),
      assistant('2026-10-30T10:00:06Z', [{ type: 'tool_use', id: 'm', name: 'SendMessage', input: { to: 'uds:\\\\.\\pipe\\x', message: 'mudou o contrato?' } }]),
      assistant('2026-10-30T10:00:07Z', [{ type: 'tool_use', id: 'h', name: 'SubagentHandback', input: {} }]),
    ]);
    expect(s.errors.has('ag')).toBe(true);
    expect(s.sends).toEqual([{ to: 'uds:\\\\.\\pipe\\x', text: 'mudou o contrato?', at: Date.parse('2026-10-30T10:00:06Z') }]);
    expect(s.handback).toBe(true);
    expect(s.lastTool?.name).toBe('SendMessage'); // o handback não conta como "fazendo"
  });
  it('guarda o título mais recente da conversa', () => {
    const s = summarize([{ type: 'ai-title', aiTitle: 'Primeiro' }, { type: 'ai-title', aiTitle: 'Projeto Mission Control' }]);
    expect(s.title).toBe('Projeto Mission Control');
  });
  it('linha estranha não derruba o resumo', () => {
    const s = summarize([null, 7, { type: 'assistant' }, { type: 'user', message: { content: 'texto' } }, assistant('2026-10-30T10:00:00Z', [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'a.ts' } }])]);
    expect(s.lastTool?.text).toBe('Read · a.ts');
  });
  it('ignora o modelo sintético', () => {
    expect(summarize([assistant('2026-10-30T10:00:00Z', [], { model: '<synthetic>' })]).model).toBeUndefined();
  });
});

describe('subagentState', () => {
  const parent = summarize([user('2026-10-30T10:00:00Z', [{ type: 'tool_result', tool_use_id: 'bad', is_error: true }])]);
  it('falhou quando o tool_use que o lançou voltou com erro', () => {
    expect(subagentState({ toolUseId: 'bad', finished: true }, undefined, parent)).toBe('failed');
  });
  it('terminou pelo meta ou pelo handback', () => {
    expect(subagentState({ toolUseId: 'ok', finished: true }, undefined, parent)).toBe('done');
    expect(subagentState({ toolUseId: 'ok' }, summarize([assistant('2026-10-30T10:00:00Z', [{ type: 'tool_use', id: 'h', name: 'SubagentHandback', input: {} }])]), parent)).toBe('done');
  });
  it('senão, está trabalhando', () => {
    expect(subagentState({ toolUseId: 'ok' }, undefined, parent)).toBe('working');
  });
  it('meta ilegível só some do mapa', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'mc-sub-'));
    await writeFile(join(dir, 'agent-a.meta.json'), 'null');
    await writeFile(join(dir, 'agent-b.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'ok' }));
    await writeFile(join(dir, 'agent-b.jsonl'), JSON.stringify(assistant(new Date().toISOString(), [])) + '\n');
    const got = await readSubagents(dir, parent, { now: Date.now(), recentMs: 60_000, staleMs: 60_000 });
    expect(got.map(a => a.description)).toEqual(['ok']);
  });
});

describe('summarizeFile', () => {
  it('arquivo que some no meio da leitura vira "sem resumo", não erro', async () => {
    expect(await summarizeFile('C:\\nao\\existe\\x.jsonl')).toBeUndefined();
  });
});

describe('git', () => {
  it('lê a lista de worktrees', () => {
    const out = 'worktree C:/r\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/r/.claude/worktrees/x\nHEAD def\ndetached\n\n';
    expect(parseWorktreeList(out)).toEqual([
      { path: 'C:/r', branch: 'main', detached: false, bare: false },
      { path: 'C:/r/.claude/worktrees/x', branch: undefined, detached: true, bare: false },
    ]);
  });
  it('lê branch, à frente/atrás e sujos do status v2', () => {
    const out = '# branch.oid abc\n# branch.head feat/x\n# branch.upstream origin/feat/x\n# branch.ab +3 -1\n1 .M N... 100644 100644 100644 a b src/a.ts\n? novo.ts\n';
    expect(parseStatus(out)).toEqual({ branch: 'feat/x', upstream: 'origin/feat/x', upstreamGone: false, ahead: 3, behind: 1, dirty: 2 });
    expect(parseStatus('# branch.head (detached)\n').branch).toBeUndefined();
  });
  it('upstream configurado sem à-frente/atrás = branch apagada no remoto', () => {
    expect(parseStatus('# branch.head feat/x\n# branch.upstream origin/feat/x\n')).toMatchObject({ upstreamGone: true });
    expect(parseStatus('# branch.head feat/x\n')).toMatchObject({ upstreamGone: false });
  });
});

describe('canRemove (worktree)', () => {
  const wt = (o: Partial<WorktreeView>): WorktreeView => ({ path: 'C:\\r\\.claude\\worktrees\\x', project: 'r', folder: 'x', branch: 'feat/x', isMain: false, dirty: 0, merged: true, sessions: [], ...o });
  it('recusa o checkout principal, worktree com sessão aberta e worktree com arquivo sujo', () => {
    expect(canRemove(wt({ isMain: true }))).toMatchObject({ ok: false, reason: expect.stringContaining('principal') });
    expect(canRemove(wt({ sessions: [{ id: 's' } as never] }))).toMatchObject({ ok: false, reason: expect.stringContaining('sessão') });
    expect(canRemove(wt({ dirty: 3 }))).toMatchObject({ ok: false, reason: expect.stringContaining('3 arquivos') });
  });
  it('limpo e já na branch padrão: remove sem aviso', () => {
    expect(canRemove(wt({}))).toEqual({ ok: true });
  });
  it('limpo mas com commits fora da padrão: remove avisando que os commits ficam na branch', () => {
    expect(canRemove(wt({ merged: false, base: 'origin/master' }))).toMatchObject({ ok: true, warning: expect.stringContaining('feat/x') });
  });
  it('sem branch e com commits fora da padrão: recusa, os commits se perderiam', () => {
    expect(canRemove(wt({ branch: undefined, merged: false }))).toMatchObject({ ok: false, reason: expect.stringContaining('sem branch') });
  });
  it('status desconhecido (git não respondeu): recusa', () => {
    expect(canRemove(wt({ dirty: undefined }))).toMatchObject({ ok: false });
  });
});
