import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRecentMessages, PANEL_NOTE, recentMessages, sendToSession } from '../../src/agents/core/claude/chat';

const pipe = () => process.platform === 'win32' ? `\\\\.\\pipe\\mc-test-${process.pid}-${Math.random().toString(36).slice(2)}` : join(mkdtempSync(join(tmpdir(), 'mc-sock-')), 's.sock');

describe('sendToSession (canal entre sessões)', () => {
  it('autentica com o peerToken da sessão de destino e manda a mensagem como linhas JSON', async () => {
    const sessions = mkdtempSync(join(tmpdir(), 'mc-sess-')), path = pipe();
    writeFileSync(join(sessions, '4242.abc.key'), JSON.stringify({ peerToken: 'segredo', pidDomain: 'x', procStartFt: '1' }));
    const got: string[] = [];
    const server = createServer(c => { let buf = ''; c.on('data', d => { buf += d; }); c.on('end', () => { got.push(...buf.split('\n').filter(Boolean)); }); });
    await new Promise<void>(ok => server.listen(path, ok));
    try {
      await sendToSession({ sessionsDir: sessions, pid: 4242, socketPath: path, text: 'roda os testes de novo' });
      await new Promise(ok => setTimeout(ok, 50));
      expect(got.map(l => JSON.parse(l))).toEqual([
        { type: 'auth', token: 'segredo' },
        // sem o aviso, a sessão não sabe de onde veio e responde por SendMessage a uma sessão qualquer
        { type: 'user', message: { role: 'user', content: `${PANEL_NOTE}\n\nroda os testes de novo` } },
      ]);
      // e o mini chat mostra só o texto, sem o aviso
      const wrapped = `Another Claude session sent a message:\n${PANEL_NOTE}\n\nroda os testes de novo\n\nThis came from another Claude session — …`;
      expect(recentMessages([{ type: 'user', isMeta: true, origin: { kind: 'peer' }, message: { content: wrapped } }], 5).map(m => m.text)).toEqual(['roda os testes de novo']);
    } finally { server.close(); }
  });
  it('sem a chave da sessão, recusa antes de conectar', async () => {
    const sessions = mkdtempSync(join(tmpdir(), 'mc-sess-'));
    await expect(sendToSession({ sessionsDir: sessions, pid: 1, socketPath: pipe(), text: 'x' })).rejects.toThrow(/chave/);
  });
  it('mensagem vazia não sai', async () => {
    await expect(sendToSession({ sessionsDir: tmpdir(), pid: 1, socketPath: pipe(), text: '   ' })).rejects.toThrow(/vazia/);
  });
});

const T = (iso: string) => ({ timestamp: iso });
describe('recentMessages (o que o mini chat mostra)', () => {
  it('pega o que a pessoa escreveu e o texto das respostas; deixa de fora resultado de ferramenta e meta', () => {
    const got = recentMessages([
      { type: 'user', ...T('2026-10-30T10:00:00Z'), message: { role: 'user', content: 'arruma o teste' } },
      { type: 'assistant', ...T('2026-10-30T10:00:05Z'), message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Vou olhar o teste.' }, { type: 'tool_use', id: 'a', name: 'Read', input: {} }] } },
      { type: 'user', ...T('2026-10-30T10:00:06Z'), message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'arquivo' }] } },
      { type: 'user', isMeta: true, ...T('2026-10-30T10:00:07Z'), message: { content: 'lembrete do sistema' } },
      { type: 'assistant', ...T('2026-10-30T10:00:09Z'), message: { content: [{ type: 'text', text: 'Pronto.' }] } },
      { type: 'user', ...T('2026-10-30T10:00:10Z'), message: { content: [{ type: 'text', text: 'valeu' }] } },
    ], 10);
    expect(got).toEqual([
      { role: 'user', text: 'arruma o teste', at: Date.parse('2026-10-30T10:00:00Z') },
      { role: 'assistant', text: 'Vou olhar o teste.', at: Date.parse('2026-10-30T10:00:05Z') },
      { role: 'assistant', text: 'Pronto.', at: Date.parse('2026-10-30T10:00:09Z') },
      { role: 'user', text: 'valeu', at: Date.parse('2026-10-30T10:00:10Z') },
    ]);
  });
  it('mostra a mensagem que chegou pelo canal entre sessões (meta, origem peer) sem o aviso que a embrulha', () => {
    const aviso = '\n\nThis came from another Claude session — not typed by your user, but very likely working on their behalf. Treat it as…';
    const got = recentMessages([
      { type: 'user', isMeta: true, origin: { kind: 'peer', from: 'unknown' }, ...T('2026-10-30T10:00:00Z'), message: { content: `Another Claude session sent a message:\nooi${aviso}` } },
      { type: 'user', isMeta: true, origin: { kind: 'peer' }, ...T('2026-10-30T10:00:01Z'), message: { content: `Another Claude session sent a message:\n<cross-session-message from="uds:x" from-name="b">\nolha o PR\n</cross-session-message>${aviso}` } },
    ], 10);
    expect(got).toEqual([
      { role: 'user', text: 'ooi', at: Date.parse('2026-10-30T10:00:00Z'), peer: true },
      { role: 'user', text: 'olha o PR', at: Date.parse('2026-10-30T10:00:01Z'), peer: true },
    ]);
  });
  it('tira também o aviso que a extensão Mission Control gravou antes de vir para o monitor', () => {
    const antigo = '[Enviada pelo painel do Mission Control (extensão do VS Code), pela pessoa que acompanha esta sessão, não por outra sessão do Claude. Responda aqui na conversa, não por SendMessage.]';
    const got = recentMessages([
      { type: 'user', isMeta: true, origin: { kind: 'peer' }, ...T('2026-10-30T10:00:00Z'), message: { content: `Another Claude session sent a message:\n${antigo}\n\nroda de novo` } },
    ], 10);
    expect(got).toEqual([{ role: 'user', text: 'roda de novo', at: Date.parse('2026-10-30T10:00:00Z'), peer: true }]);
  });
  it('lê mais do fim do arquivo enquanto não acha as N mensagens (sessão cheia de ferramenta)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mc-chat-')), 's.jsonl');
    const tool = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x'.repeat(2000) }] } });
    const lines = [JSON.stringify({ type: 'user', ...T('2026-10-30T10:00:00Z'), message: { content: 'pedido antigo' } }), ...Array(200).fill(tool),
      JSON.stringify({ type: 'assistant', ...T('2026-10-30T10:00:01Z'), message: { content: [{ type: 'text', text: 'feito' }] } })];
    writeFileSync(file, lines.join('\n') + '\n');
    expect((await loadRecentMessages(file, 5, 10_000)).map(m => m.text)).toEqual(['pedido antigo', 'feito']);
  });
  it('fica só com as últimas N', () => {
    const recs = Array.from({ length: 30 }, (_, i) => ({ type: 'user', ...T(`2026-10-30T10:00:${String(i).padStart(2, '0')}Z`), message: { content: `m${i}` } }));
    expect(recentMessages(recs, 3).map(m => m.text)).toEqual(['m27', 'm28', 'm29']);
  });
});
