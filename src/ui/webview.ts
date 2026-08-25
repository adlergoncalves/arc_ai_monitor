import * as vscode from 'vscode';

/**
 * HTML do painel. Serve a view da barra lateral (compacta) e o painel do
 * editor (completo) — a diferenca e uma classe no body.
 *
 * Layout de painel de monitoramento: reator arc no topo, cotas em stat
 * tiles com filete na base e sessoes em linha densa com trilho lateral.
 *
 * CSP fechada: nada de rede, nada de inline. O script so entra pelo nonce e
 * todo estilo mora no .css — por isso o dashboard.js nunca escreve
 * `style="..."` em markup (usa classes ou CSSOM, que a CSP permite).
 */
export function buildHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  opts: { compact: boolean; theme: string },
): string {
  const nonce = makeNonce();
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'dashboard.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'dashboard.js'));
  const cls = [opts.compact ? 'compact' : '', opts.theme === 'vscode' ? 'theme-vscode' : '']
    .filter(Boolean)
    .join(' ');

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}">
<title>Arc AI Monitor</title>
</head>
<body class="${cls}">
<div class="shell">

  <header class="top">
    ${reactorSvg()}
    <span class="wordmark">ARC AI</span>
    <span class="fresh" id="fresh"></span>
    <span class="spacer"></span>
    <!-- agrupado para a coluna estreita poder descer TUDO junto para a
         segunda linha, em vez de quebrar no meio de "QUINTA-FEIRA" -->
    <span class="topmeta">
      <span class="who acct" id="sess-acct"></span>
      <span class="sep acct">·</span>
      <span class="count" id="d-date"></span>
      <span class="sep">·</span>
      <span class="count" id="clock">--:--:--</span>
    </span>
  </header>

  <div id="alert"></div>

  <!-- faixa de KPI: cota e consumo com o mesmo peso visual. As cotas entram
       aqui pelo JS, antes dos tres tiles fixos. -->
  <div class="kpis" id="kpis">
    <div class="empty full" id="q-empty" hidden>
      Cotas não encontradas. Abra o Claude Code e rode <code>/usage</code>.
    </div>
    <div class="k" id="k_out">
      <div class="knum"><b id="d-out">—</b><i id="d-unit"></i></div>
      <div class="klbl">SAÍDA HOJE</div>
      <div class="kfoot" id="d-turns"></div>
    </div>
    <div class="k" id="k_mov">
      <div class="knum"><b id="d-mov">—</b><i id="d-movu"></i></div>
      <div class="klbl">MOVIMENTADO</div>
      <div class="kfoot">entrada + cache + saída</div>
    </div>
    <div class="k" id="k_cost">
      <div class="knum"><b id="d-cost">—</b><i>US$</i></div>
      <div class="klbl">EQUIVALENTE API</div>
      <div class="kfoot">estimativa, não fatura</div>
    </div>
  </div>

  <div class="grid-main">
    <section class="panel">
      <h2><span id="sess-count">—</span><span class="who" id="sess-note"></span></h2>
      <div class="sessions" id="cards"></div>
    </section>

    <section class="panel">
      <h2><span>HOJE · 24 HORAS</span><span class="who" id="d-peak"></span></h2>
      <div class="chart" id="d-chart"></div>
      <div class="axis"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
      <div class="comp">
        <div class="gauge" id="c-gauge"></div>
        <div class="ctable" id="c-rows"></div>
      </div>
    </section>
  </div>

  <div class="grid-hist wide-only">
    <section class="panel">
      <h2><span id="h-title">HISTÓRICO</span><span class="who" id="h-sum"></span></h2>
      <div class="chart" id="h-chart"></div>
      <div class="hscale" id="h-scale"></div>
    </section>
    <section class="panel">
      <h2><span>POR PROJETO</span></h2>
      <div class="rank" id="h-projects"></div>
    </section>
    <section class="panel">
      <h2><span>POR MODELO</span></h2>
      <div class="rank" id="h-models"></div>
    </section>
  </div>

  <section class="panel wide-only" id="tel-panel">
    <h2><span>INFORMAÇÕES ADICIONAIS · O QUE SAI DESTA MÁQUINA</span><span class="who" id="t-state"></span></h2>
    <div class="telgrid">
      <div class="telcol">
        <div class="tsub" id="t-win-lbl">ATIVIDADE · ÚLTIMOS 60s</div>
        <div class="trows" id="t-wire"></div>
      </div>
      <div class="telcol">
        <div class="tsub">MÉTRICAS claude_code.* · HOJE, DESTA MÁQUINA</div>
        <div class="trows" id="t-metrics"></div>
      </div>
      <div class="telcol">
        <div class="tsub">EXPORTADOR E PRIVACIDADE · lido do settings.json</div>
        <div class="trows" id="t-conn"></div>
      </div>
    </div>
  </section>

  <footer>
    <b>Cotas da conta</b> são os números oficiais — os mesmos do <code>/usage</code>. Vêm de uma
    consulta direta a <code>api.anthropic.com/api/oauth/usage</code> com o token que o Claude Code
    já mantém no disco; esse endpoint não faz inferência, então <b>não gasta tokens nem consome
    cota</b>. Se o token expirar ou a rede cair, o painel volta sozinho a ler o cache local em
    <code>~/.claude.json</code> — aí o ponto ao lado de CLAUDE fica vazio e mostra a idade do dado.
    <br>
    <b>Consumo</b> e <b>sessões</b> vêm dos transcripts em <code>~/.claude/projects</code> e das
    sessões em <code>~/.claude/sessions</code>; o uso é gravado <b>ao fim de cada turno</b>, então
    durante uma resposta longa o número fica parado e salta quando ela termina. O valor em dólar é
    o <b>equivalente em API pay-per-token</b> — referência de peso, não fatura.
  </footer>
</div>
<div class="tip" id="tip" hidden></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}

/**
 * Reator arc: anel interno fino, 10 bobinas no anel externo e nucleo.
 * Geometria normalizada para 0-100:
 * anel r=19 espessura 2.5; bobinas r=37 espessura 14, cada uma cobrindo 36°
 * menos 4° de folga em cada ponta; nucleo r=9.5.
 * A sequencia de acendimento e o giro sao CSS — cada bobina tem o mesmo
 * keyframe, defasado por --i.
 */
function reactorSvg(): string {
  const coils = [
    'M52.58 13.09A37 37 0 0 1 69.61 18.62',
    'M73.78 21.66A37 37 0 0 1 84.31 36.14',
    'M85.90 41.05A37 37 0 0 1 85.90 58.95',
    'M84.31 63.86A37 37 0 0 1 73.78 78.34',
    'M69.61 81.38A37 37 0 0 1 52.58 86.91',
    'M47.42 86.91A37 37 0 0 1 30.39 81.38',
    'M26.22 78.34A37 37 0 0 1 15.69 63.86',
    'M14.10 58.95A37 37 0 0 1 14.10 41.05',
    'M15.69 36.14A37 37 0 0 1 26.22 21.66',
    'M30.39 18.62A37 37 0 0 1 47.42 13.09',
  ]
    // sem `style="--i:.."`: atributo de estilo inline e barrado pela CSP.
    // O indice de cada bobina vem de :nth-of-type() no css.
    .map((d) => `<path class="coil" d="${d}"/>`)
    .join('');
  return `<svg class="core" id="core" viewBox="0 0 100 100" aria-hidden="true">${coils}<circle class="ring" cx="50" cy="50" r="19"/><circle class="pit" cx="50" cy="50" r="9.5"/></svg>`;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
