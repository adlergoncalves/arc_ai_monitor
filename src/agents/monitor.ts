// Relê as sessões num intervalo e sempre que a pasta de registros muda; entrega o snapshot a quem ouve.
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { Git } from './core/git';
import { buildSnapshot, type SnapshotOptions } from './core/snapshot';
import type { Snapshot } from './core/types';

export class Monitor {
  private timer?: NodeJS.Timeout;
  private watcher?: FSWatcher;
  private current?: Promise<void>;
  private next?: Promise<void>;
  private debounce?: NodeJS.Timeout;
  readonly git = new Git();
  last?: Snapshot;

  constructor(private options: () => SnapshotOptions & { intervalMs: number }, private readonly onSnapshot: (s: Snapshot) => void, private readonly onError: (e: unknown) => void) {}

  start() {
    this.stop();
    const o = this.options();
    this.timer = setInterval(() => void this.tick(), o.intervalMs);
    // o registro muda no instante em que a sessão troca de estado: não espera o próximo intervalo
    try { this.watcher = watch(join(o.claudeHome, 'sessions'), () => { clearTimeout(this.debounce); this.debounce = setTimeout(() => void this.tick(), 250); }); } catch { /* sem pasta ainda: o intervalo cobre */ }
    void this.tick();
  }

  stop() { clearInterval(this.timer); clearTimeout(this.debounce); this.watcher?.close(); this.watcher = undefined; }

  /** Resolve quando sai uma leitura que começou depois da chamada: com uma em andamento, espera a seguinte. */
  tick(): Promise<void> {
    if (this.current) return this.next ??= this.current.then(() => { this.next = undefined; return this.tick(); });
    this.current = (async () => {
      try { this.last = await buildSnapshot(this.options(), this.git); this.onSnapshot(this.last); }
      catch (e) { this.onError(e); }
    })().finally(() => { this.current = undefined; });
    return this.current;
  }
}
