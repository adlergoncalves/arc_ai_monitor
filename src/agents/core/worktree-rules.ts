// Quando um worktree pode sair. Remover um worktree apaga a pasta (inclusive build e dependências);
// a branch fica. O que se perde de verdade é arquivo sujo e commit que não está em branch nenhuma.
import type { WorktreeView } from './types';

export type Removal = { ok: false; reason: string } | { ok: true; warning?: string };

export function canRemove(w: WorktreeView): Removal {
  if (w.isMain) return { ok: false, reason: 'é o checkout principal do repositório' };
  if (w.sessions.length) return { ok: false, reason: `tem sessão aberta (${w.sessions.map(s => s.name).join(', ')})` };
  if (w.dirty === undefined) return { ok: false, reason: 'não consegui ler o status do git' };
  if (w.dirty > 0) return { ok: false, reason: `tem ${w.dirty} arquivo${w.dirty > 1 ? 's' : ''} sujo${w.dirty > 1 ? 's' : ''} ou novo${w.dirty > 1 ? 's' : ''}` };
  if (!w.branch && w.merged !== true) return { ok: false, reason: 'está sem branch e tem commits que não estão em outra branch' };
  if (w.merged === false) return { ok: true, warning: `os commits que não estão em ${w.base ?? 'a branch padrão'} continuam na branch ${w.branch}` };
  return { ok: true };
}
