import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CLAUDE_DIR } from '../../../engine/paths';

/** A pasta configurada vale; vazia, a mesma do resto do monitor (respeita CLAUDE_CONFIG_DIR). */
export const claudeHome = (configured?: string) => (configured && configured.trim()) || CLAUDE_DIR;

/** Como o Claude Code nomeia a pasta de transcripts de um cwd: todo caractere fora de [A-Za-z0-9] vira "-". */
export const encodeCwd = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

// o Windows guarda o mesmo cwd com a letra do disco ora maiúscula, ora minúscula ("C--…" e "c--…")
const listings = new Map<string, { at: number; names: string[] }>();
async function projectNames(projectsRoot: string) {
  let listing = listings.get(projectsRoot);
  if (!listing || Date.now() - listing.at > 30_000) {
    try { listing = { at: Date.now(), names: await readdir(projectsRoot) }; listings.set(projectsRoot, listing); } catch { return undefined; }
  }
  return listing.names;
}

export async function findProjectDir(projectsRoot: string, cwd: string): Promise<string | undefined> {
  const want = encodeCwd(cwd), names = await projectNames(projectsRoot);
  const exact = names?.find(n => n === want) ?? names?.find(n => n.toLowerCase() === want.toLowerCase());
  return exact ? join(projectsRoot, exact) : undefined;
}

const exists = (f: string) => stat(f).then(() => true, () => false);
const elsewhere = new Map<string, string>(); // root|sessão → pasta onde a conversa está

/**
 * Pasta da conversa de uma sessão viva. Em geral, a do cwd; mas a sessão retomada pelo arquivo
 * (`claude --resume <arquivo>.jsonl`) continua gravando no arquivo original, na pasta de outro cwd.
 * Sem a conversa em lugar nenhum (sessão nova), fica a pasta do cwd.
 */
export async function findTranscriptDir(projectsRoot: string, cwd: string, sessionId: string): Promise<string | undefined> {
  const dir = await findProjectDir(projectsRoot, cwd), file = `${sessionId}.jsonl`;
  if (dir && await exists(join(dir, file))) return dir;
  const key = projectsRoot + '|' + sessionId, known = elsewhere.get(key);
  if (known && await exists(join(known, file))) return known;
  for (const n of await projectNames(projectsRoot) ?? []) {
    const d = join(projectsRoot, n);
    if (d !== dir && await exists(join(d, file))) { elsewhere.set(key, d); return d; }
  }
  return dir;
}
