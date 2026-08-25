/**
 * Precos por MILHAO de tokens, conforme a tabela oficial da Anthropic
 * (conferida em 2026-07-30). i=input, o=output, cw=cache write (1.25x do
 * input), cr=cache read (0.1x do input).
 *
 * O valor resultante e o EQUIVALENTE EM API pay-per-token, nao a fatura:
 * numa assinatura voce nao paga isso. Serve para comparar o peso relativo
 * entre modelos, dias e projetos.
 *
 * Para corrigir sem recompilar, use a configuracao `arcAiMonitor.pricing`.
 */

export interface PriceRow {
  i: number;
  o: number;
  cw: number;
  cr: number;
}

export type PriceTable = Record<string, PriceRow>;

export const DEFAULT_PRICING: PriceTable = {
  opus: { i: 5.0, o: 25.0, cw: 6.25, cr: 0.5 },
  fable: { i: 10.0, o: 50.0, cw: 12.5, cr: 1.0 },
  mythos: { i: 10.0, o: 50.0, cw: 12.5, cr: 1.0 },
  sonnet: { i: 3.0, o: 15.0, cw: 3.75, cr: 0.3 },
  haiku: { i: 1.0, o: 5.0, cw: 1.25, cr: 0.1 },
};

/**
 * A ordem importa: familias de preco mais alto primeiro, para que um id novo
 * do tipo "fable-opus-x" nao caia na faixa mais barata por acidente.
 */
const FAMILY_ORDER = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];

export function family(model: string | undefined | null): string | undefined {
  const m = (model || '').toLowerCase();
  return FAMILY_ORDER.find((f) => m.includes(f));
}

export function costOf(
  model: string | undefined | null,
  i: number,
  o: number,
  cw: number,
  cr: number,
  table: PriceTable,
): number {
  const f = family(model);
  if (!f) {
    return 0;
  }
  const p = table[f];
  if (!p) {
    return 0;
  }
  return (i * p.i + o * p.o + cw * p.cw + cr * p.cr) / 1_000_000;
}

/** Mescla a tabela embutida com o override do usuario, campo a campo. */
export function mergePricing(override: unknown): PriceTable {
  const out: PriceTable = {};
  for (const [k, v] of Object.entries(DEFAULT_PRICING)) {
    out[k] = { ...v };
  }
  if (!override || typeof override !== 'object') {
    return out;
  }
  for (const [fam, row] of Object.entries(override as Record<string, unknown>)) {
    if (!row || typeof row !== 'object') {
      continue;
    }
    const base = out[fam] ?? { i: 0, o: 0, cw: 0, cr: 0 };
    const r = row as Record<string, unknown>;
    out[fam] = {
      i: typeof r.i === 'number' ? r.i : base.i,
      o: typeof r.o === 'number' ? r.o : base.o,
      cw: typeof r.cw === 'number' ? r.cw : base.cw,
      cr: typeof r.cr === 'number' ? r.cr : base.cr,
    };
  }
  return out;
}
