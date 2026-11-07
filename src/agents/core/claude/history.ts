// Sessões anteriores de uma pasta: os transcripts que o Claude Code guardou para aquele cwd e, vindos do
// índice de cwds, os de outras pastas (o checkout principal, em geral) que trabalharam nela. Lido sob
// demanda (quando a pessoa abre o detalhe do worktree), nunca no ciclo de 2 s.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { IndexedFile } from './cwd-index';
import { findProjectDir } from './paths';
import { summarizeFile } from './transcript';

export interface PastSession { id: string; file: string; title?: string; lastAt: number; model?: string }

export async function pastSessions(home: string, cwd: string, o: { exclude: Set<string>; limit: number; extra?: IndexedFile[] }): Promise<PastSession[]> {
  const files = new Map<string, string>(); // id → arquivo
  const dir = await findProjectDir(join(home, 'projects'), cwd);
  if (dir) { try { for (const n of await readdir(dir)) if (n.endsWith('.jsonl')) files.set(n.slice(0, -6), join(dir, n)); } catch { /* sem pasta */ } }
  for (const f of o.extra ?? []) if (!files.has(f.id)) files.set(f.id, f.file);
  for (const id of o.exclude) files.delete(id);

  const stats = (await Promise.all([...files].map(async ([id, file]) => {
    try { const s = await stat(file); return s.size ? { id, file, mtime: s.mtimeMs } : undefined; } catch { return undefined; }
  }))).filter((f): f is { id: string; file: string; mtime: number } => !!f).sort((a, b) => b.mtime - a.mtime).slice(0, o.limit);

  const out = await Promise.all(stats.map(async f => {
    const s = (await summarizeFile(f.file, 400_000).catch(() => undefined))?.summary;
    return { id: f.id, file: f.file, title: s?.title, lastAt: s?.lastAt ?? f.mtime, model: s?.model };
  }));
  return out.sort((a, b) => b.lastAt - a.lastAt);
}
