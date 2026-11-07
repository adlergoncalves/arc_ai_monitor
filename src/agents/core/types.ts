// O modelo que o mapa desenha. Não sabe de onde os dados vieram: um provedor (hoje só o Claude Code)
// entrega sessões; o git as agrupa por worktree.

export type SessionState = 'working' | 'waiting' | 'idle';
export type SubagentState = 'working' | 'done' | 'failed';

export interface SubagentView {
  id: string;
  description: string;
  /** `agentType` do Claude Code: Explore, Plan, general-purpose, code-review… */
  type: string;
  state: SubagentState;
  startedAt?: number;
  endedAt?: number;
  /** a última ferramenta que usou, já descrita ("Grep · charge(") */
  activity?: string;
}

export interface SessionView {
  provider: 'claude';
  id: string;
  pid: number;
  name: string;
  cwd: string;
  /** como a sessão foi aberta: claude-vscode, cli… */
  entrypoint?: string;
  state: SessionState;
  /** motivo de `waiting`, como o Claude Code grava ("input needed", "dialog open"…) */
  waitingFor?: string;
  /** quando o estado atual começou */
  since: number;
  startedAt?: number;
  model?: string;
  contextTokens?: number;
  activity?: string;
  /** o que a sessão pede quando está em waiting ("choose: allow or deny…"), como o Claude Code grava */
  needs?: string;
  /** pipe do canal entre sessões; o mini chat manda por ele */
  socket?: string;
  /** o .jsonl da conversa; o mini chat lê o fim dele */
  transcript?: string;
  subagents: SubagentView[];
}

export interface MessageView {
  from: string;
  to: string;
  at: number;
  text: string;
}

export interface WorktreeView {
  /** caminho absoluto, a chave do container */
  path: string;
  /** nome do repositório (pasta do checkout principal) */
  project: string;
  /** pasta do worktree, quando não é o checkout principal */
  folder?: string;
  branch?: string;
  isMain: boolean;
  ahead?: number;
  behind?: number;
  dirty?: number;
  /** a branch tinha upstream e ele sumiu do remoto (PR mergeado e branch apagada, em geral) */
  upstreamGone?: boolean;
  /** branch padrão do repositório contra a qual `merged` foi medido (origin/master, main…) */
  base?: string;
  /** o HEAD do worktree já está contido em `base`: remover não perde commit */
  merged?: boolean;
  lastCommitAt?: number;
  lastCommitSubject?: string;
  /** checkout principal do repositório, de onde os comandos de worktree rodam */
  repoPath?: string;
  /** a pessoa abriu o worktree no mapa: vira caixa mesmo sem sessão (open-worktrees) */
  open?: boolean;
  /** se pode remover e, se não, por quê (worktree-rules) */
  removal?: { ok: boolean; reason?: string; warning?: string };
  sessions: SessionView[];
}

export interface Snapshot {
  at: number;
  worktrees: WorktreeView[];
  messages: MessageView[];
}
