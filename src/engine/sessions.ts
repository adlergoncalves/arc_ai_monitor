/**
 * Sessoes registradas em ~/.claude/sessions/*.json e quais delas ainda estao
 * vivas.
 *
 * Spawnar `tasklist` a cada sondagem custaria ~1s de processo por vez. A
 * checagem primaria e `process.kill(pid, 0)`, que nao mata nada, nao cria
 * processo e responde na hora. O `tasklist` entra so como filtro de
 * seguranca em segundo plano (a cada 30s): sem ele, um PID reciclado pelo
 * Windows para outro programa qualquer apareceria como sessao viva.
 */
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SESS_DIR } from './paths';

export interface SessionMeta {
  pid: number;
  sessionId: string;
  cwd?: string;
  startedAt?: number;
  name?: string;
  version?: string;
  kind?: string;
  entrypoint?: string;
}

/** existe um processo com esse pid? (nao diz QUAL processo) */
function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = existe, mas nao temos permissao para sinalizar. Vivo.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

const PROBE_TTL_MS = 30_000;
const probe: { at: number; pids: Set<number> | undefined; running: boolean } = {
  at: 0,
  pids: undefined,
  running: false,
};

function claudePids(): Promise<Set<number> | undefined> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(undefined); // fora do Windows o processExists ja basta
      return;
    }
    execFile(
      'tasklist',
      ['/FI', 'IMAGENAME eq claude.exe', '/NH', '/FO', 'CSV'],
      { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(undefined);
          return;
        }
        const pids = new Set<number>();
        for (const line of stdout.split(/\r?\n/)) {
          const parts = line.split('","').map((s) => s.replace(/^"|"$/g, '').trim());
          if (parts.length >= 2) {
            const n = Number(parts[1]);
            if (Number.isInteger(n) && n > 0) {
              pids.add(n);
            }
          }
        }
        // lista vazia sem erro tambem e resposta valida: nenhum claude.exe
        resolve(pids);
      },
    );
  });
}

/** dispara o refresh do filtro em segundo plano; nunca bloqueia o poll */
function refreshProbe(): void {
  if (probe.running || Date.now() - probe.at < PROBE_TTL_MS) {
    return;
  }
  probe.running = true;
  claudePids()
    .then((pids) => {
      probe.pids = pids;
      probe.at = Date.now();
    })
    .finally(() => {
      probe.running = false;
    });
}

export function isAlive(pid: number): boolean {
  if (!processExists(pid)) {
    return false;
  }
  refreshProbe();
  const known = probe.pids;
  // enquanto a primeira sondagem nao volta, confia no processExists
  if (!known) {
    return true;
  }
  return known.has(pid);
}

/** Todas as sessoes registradas, vivas ou nao. */
export async function readSessions(): Promise<SessionMeta[]> {
  let entries;
  try {
    entries = await fs.readdir(SESS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SessionMeta[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || !e.name.endsWith('.json')) {
      continue;
    }
    try {
      const raw = await fs.readFile(path.join(SESS_DIR, e.name), 'utf8');
      const m = JSON.parse(raw);
      if (m && typeof m === 'object' && typeof m.sessionId === 'string') {
        out.push(m as SessionMeta);
      }
    } catch {
      continue; // arquivo pela metade ou json invalido: ignora
    }
  }
  return out;
}
