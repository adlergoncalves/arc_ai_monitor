import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Monitor } from '../../src/agents/monitor';

describe('Monitor.tick', () => {
  it('com uma leitura em andamento, só resolve depois da leitura seguinte (quem espera vê o estado novo)', async () => {
    let reads = 0;
    const m = new Monitor(() => ({ claudeHome: mkdtempSync(join(tmpdir(), 'mc-mon-')), intervalMs: 60_000, recentSubagentMs: 0 }), () => { reads++; }, e => { throw e; });
    const first = m.tick(), second = m.tick(), third = m.tick();
    await second;
    expect(reads).toBe(2);
    await Promise.all([first, third]);
    expect(reads).toBe(2); // pedidos durante a mesma leitura viram uma só leitura seguinte
  });
});
