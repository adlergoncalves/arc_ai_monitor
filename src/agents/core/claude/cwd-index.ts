// Em que pastas cada conversa trabalhou. A sessão aberta no checkout principal que entra num worktree
// (EnterWorktree, cd) continua gravando no transcript do principal; o `cwd` de cada registro diz onde ela
// estava. O índice guarda, por transcript, o conjunto desses cwds; transcript só cresce, então a próxima
// passada lê só o que entrou depois do último byte lido.
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { pathKey } from '../git';

interface Entry { size: number; mtime: number; cwds: string[] }
export interface IndexedFile { id: string; file: string }

const CWD = /"cwd":"((?:[^"\\]|\\.)*)"/g;

export class CwdIndex {
  private files = new Map<string, Entry>();

  static from(data: unknown) {
    const i = new CwdIndex(), files = (data as { files?: Record<string, Entry> } | undefined)?.files;
    if (files && typeof files === 'object') for (const [k, v] of Object.entries(files)) if (v && Array.isArray(v.cwds)) i.files.set(k, v);
    return i;
  }
  toJSON() { return { v: 1, files: Object.fromEntries(this.files) }; }

  /** Atualiza com os transcripts da pasta; devolve quantos bytes precisou ler. */
  async refresh(dir: string): Promise<number> {
    let names: string[];
    try { names = (await readdir(dir)).filter(n => n.endsWith('.jsonl')); } catch { return 0; }
    let read = 0;
    for (const n of names) {
      const file = join(dir, n);
      let st;
      try { st = await stat(file); } catch { continue; }
      const prev = this.files.get(file);
      if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) continue;
      const grew = prev && st.size > prev.size, cwds = new Set(grew ? prev.cwds : []);
      try { read += await scan(file, grew ? prev.size : 0, cwds); } catch { continue; }
      this.files.set(file, { size: st.size, mtime: st.mtimeMs, cwds: [...cwds] });
    }
    return read;
  }

  /** Conversas que trabalharam em `path` ou em alguma subpasta dele. */
  sessionsIn(path: string): IndexedFile[] {
    const k = pathKey(path), under = k + sep;
    return [...this.files].filter(([, e]) => e.cwds.some(c => c === k || c.startsWith(under))).map(([file]) => ({ id: basename(file, '.jsonl'), file }));
  }
}

function scan(file: string, from: number, into: Set<string>): Promise<number> {
  return new Promise((ok, fail) => {
    let carry = '', bytes = 0;
    const take = (text: string) => { for (const m of text.matchAll(CWD)) { try { into.add(pathKey(JSON.parse(`"${m[1]}"`))); } catch { /* escape quebrado */ } } };
    const s = createReadStream(file, { start: from, encoding: 'utf8', highWaterMark: 1 << 20 });
    s.on('data', chunk => {
      const text = carry + (chunk as string);
      bytes += Buffer.byteLength(chunk as string);
      const cut = text.lastIndexOf('\n');
      // a linha que ficou pela metade vai para o próximo pedaço; linha gigante (anexo) não segura memória
      carry = cut >= 0 ? text.slice(cut + 1) : text;
      if (cut >= 0) take(text.slice(0, cut));
      if (carry.length > 8 << 20) { take(carry); carry = ''; }
    });
    s.on('end', () => { take(carry); ok(bytes); });
    s.on('error', fail);
  });
}
