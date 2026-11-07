// Worktrees que a pessoa abriu no mapa: aparecem como caixa, igual ao checkout principal, mesmo sem sessão.
// A caixa fecha no × ou quando a última sessão que ela teve termina; o worktree que some do git sai junto.
import { pathKey } from './git';
import type { Snapshot } from './types';

type State = Record<string, { seen: boolean }>;

export class OpenWorktrees {
  private m: State = {};

  static from(data: unknown) {
    const o = new OpenWorktrees();
    if (data && typeof data === 'object') for (const [k, v] of Object.entries(data as State)) o.m[k] = { seen: !!v?.seen };
    return o;
  }

  toJSON(): State { return this.m; }

  open(path: string) { this.m[pathKey(path)] ??= { seen: false }; }

  close(path: string) { delete this.m[pathKey(path)]; }

  /** Marca `open` nos worktrees do snapshot e fecha o que acabou; devolve true quando o estado mudou. */
  apply(s: Snapshot) {
    let changed = false;
    const present = new Set<string>();
    for (const w of s.worktrees) {
      const k = pathKey(w.path), st = this.m[k];
      present.add(k);
      delete w.open;
      if (!st) continue;
      if (w.sessions.length) { if (!st.seen) { st.seen = true; changed = true; } w.open = true; continue; }
      if (st.seen) { delete this.m[k]; changed = true; continue; }
      w.open = true;
    }
    for (const k of Object.keys(this.m)) if (!present.has(k)) { delete this.m[k]; changed = true; }
    return changed;
  }
}
