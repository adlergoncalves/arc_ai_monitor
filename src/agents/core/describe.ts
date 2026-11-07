// Uma chamada de ferramenta em uma linha que se lê de relance: "Edit · invoice.ts", "Bash · npm test".

const MAX = 80;

const base = (p: unknown) => (typeof p === 'string' ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : '');
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clip = (s: string) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > MAX ? one.slice(0, MAX - 1) + '…' : one;
};

export function describeTool(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  let detail = '';
  switch (name) {
    case 'Bash': case 'PowerShell': detail = str(i.description) || str(i.command); break;
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': detail = base(i.file_path ?? i.notebook_path); break;
    case 'Grep': detail = str(i.pattern); break;
    case 'Glob': detail = str(i.pattern); break;
    case 'Agent': case 'Task': detail = str(i.description); break;
    case 'Skill': detail = str(i.skill); break;
    case 'WebFetch': detail = str(i.url).replace(/^https?:\/\//, ''); break;
    case 'WebSearch': detail = str(i.query); break;
    case 'SendMessage': detail = 'mensagem'; break;
    default: {
      // mcp__servidor__ferramenta → "servidor · ferramenta"
      const m = /^mcp__(.+?)__(.+)$/.exec(name);
      if (m) return clip(`${m[1]} · ${m[2]}`);
    }
  }
  return clip(detail ? `${name} · ${detail}` : name);
}

/** "claude-opus-5-5" → "Opus 5.5"; o que não reconhecer volta como veio */
export function shortModel(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const parts = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-');
  const family = parts.findIndex(p => /^[a-z]+$/i.test(p));
  if (family < 0) return id;
  const name = parts[family]!;
  const nums = parts.filter((p, k) => k !== family && /^\d+$/.test(p));
  return `${name[0]!.toUpperCase()}${name.slice(1)}${nums.length ? ' ' + nums.join('.') : ''}`;
}
