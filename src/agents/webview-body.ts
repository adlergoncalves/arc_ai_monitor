import { areasNav, reactorSvg } from '../ui/webview';

/**
 * O corpo do mapa, na estrutura do monitor: a mesma moldura (`.shell`), o mesmo topo (reator, ARC AI,
 * MONITOR | AGENTES, conta · data · hora), a faixa de KPI e, embaixo, um painel por repositório.
 * É um produto só: trocar de área não move nada do que é comum às duas.
 */
export function mapBody(): string {
  return `<div class="shell agents">
  <header class="top">
    ${reactorSvg()}
    <span class="wordmark">ARC AI</span>
    ${areasNav('agents')}
    <span class="freshes"><span class="fresh" id="fresh-claude" hidden></span></span>
    <span class="spacer"></span>
    <span class="topmeta">
      <span class="who acct" id="acct"></span>
      <span class="sep acct" id="acct-sep">·</span>
      <span class="count" id="d-date"></span>
      <span class="sep">·</span>
      <span class="count" id="clock">--:--:--</span>
    </span>
  </header>
  <div class="kpis" id="akpis"></div>
  <section class="canvas" id="canvas" aria-label="Mapa de agentes por worktree">
    <div class="world" id="world"><svg id="lines"></svg><svg id="top" class="overlay"></svg></div>
  </section>
</div>`;
}
