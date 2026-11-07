import { describe, expect, it } from 'vitest';
import { OpenWorktrees } from '../../src/agents/core/open-worktrees';
import type { SessionView, Snapshot, WorktreeView } from '../../src/agents/core/types';

const ses = { id: 's1' } as SessionView;
const wt = (path: string, sessions: SessionView[] = []) => ({ path, project: 'p', isMain: false, sessions }) as WorktreeView;
const snap = (...worktrees: WorktreeView[]): Snapshot => ({ at: 0, worktrees, messages: [] });

describe('OpenWorktrees (caixa do worktree no mapa)', () => {
  it('worktree aberto sem sessão fica aberto até alguém fechar', () => {
    const o = new OpenWorktrees();
    o.open('C:\\r\\wt');
    const s = snap(wt('c:/r/wt/'));
    o.apply(s);
    expect(s.worktrees[0]!.open).toBe(true);
    o.apply(s);
    expect(s.worktrees[0]!.open).toBe(true);
    o.close('C:\\r\\wt');
    o.apply(s);
    expect(s.worktrees[0]!.open).toBeUndefined();
  });

  it('fecha sozinho quando a última sessão que ele teve termina', () => {
    const o = new OpenWorktrees();
    o.open('C:\\r\\wt');
    expect(o.apply(snap(wt('C:\\r\\wt', [ses])))).toBe(true); // "já teve sessão" também se salva
    expect(o.apply(snap(wt('C:\\r\\wt', [ses])))).toBe(false);
    const s = snap(wt('C:\\r\\wt'));
    expect(o.apply(s)).toBe(true); // mudou: quem guarda o estado precisa salvar
    expect(s.worktrees[0]!.open).toBeUndefined();
    expect(o.toJSON()).toEqual({});
  });

  it('esquece o worktree que saiu do mapa (removido)', () => {
    const o = new OpenWorktrees();
    o.open('C:\\r\\wt');
    expect(o.apply(snap(wt('C:\\r\\outro')))).toBe(true);
    expect(o.toJSON()).toEqual({});
  });

  it('volta do estado salvo', () => {
    const o = new OpenWorktrees();
    o.open('C:\\r\\wt');
    o.apply(snap(wt('C:\\r\\wt', [ses])));
    const back = OpenWorktrees.from(JSON.parse(JSON.stringify(o)));
    const s = snap(wt('C:\\r\\wt'));
    back.apply(s);
    expect(s.worktrees[0]!.open).toBeUndefined(); // já tinha tido sessão: fecha
    expect(OpenWorktrees.from(null).toJSON()).toEqual({});
  });
});
