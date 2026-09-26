/* Render do painel. Os dados chegam por postMessage da extensao — nao ha
   servidor nem fetch. Disciplina mantida: so escreve no DOM se o valor mudou,
   e cada grafico so e remontado quando a serie muda de verdade (o painel fica
   aberto o dia inteiro; repaint a cada 3s custa bateria).

   Os graficos sao SVG escrito na mao. Recharts/Chart.js seriam o caminho
   natural para este visual, mas a CSP do webview bloqueia qualquer host
   externo e embutir React so para desenhar 24 barras nao se paga. O que
   importa do padrao e reproduzivel: area com gradiente, gridline discreta,
   linha de referencia tracejada, canto arredondado e tooltip em cartao. */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const SVGNS = 'http://www.w3.org/2000/svg';

  let CTX_MAX = 1000000;
  /* `picked` é a escolha feita no seletor (e o que se persiste); `provider`
     é o que está na tela. Separados porque quem usa uma ferramenta só não
     tem escolha: vai direto para ela, sem gravar isso como preferência — se a
     segunda ferramenta aparecer depois, a visão geral volta a ser o padrão. */
  let picked = 'all';
  let provider = 'all';
  let latest;

  // ── formatadores ──────────────────────────────────────────────────────
  function short(n) {
    n = n || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'bi';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'mi';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k';
    return String(Math.round(n));
  }
  /** separa valor e unidade: a unidade entra rebaixada, tipografia menor */
  function splitUnit(n) {
    n = n || 0;
    if (n >= 1e9) return [(n / 1e9).toFixed(2), 'bi tok'];
    if (n >= 1e6) return [(n / 1e6).toFixed(2), 'mi tok'];
    if (n >= 1e3) return [(n / 1e3).toFixed(0), 'k tok'];
    return [String(Math.round(n)), 'tok'];
  }
  function brl(n) {
    return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(n || 0);
  }
  /** valor pequeno com centavos ("0,42"); grande sem ("1.230") */
  function money(n) {
    n = n || 0;
    return n < 100 ? n.toFixed(2).replace('.', ',') : brl(n);
  }
  function ago(s) {
    if (s == null) return '—';
    if (s < 10) return 'agora';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'min';
    return Math.floor(s / 3600) + 'h' + String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  }
  /** tempo restante ate o reset, sem prefixo — o tile poe o "↻" */
  function until(iso) {
    if (!iso) return '';
    const ms = new Date(iso) - new Date();
    if (isNaN(ms)) return '';
    if (ms <= 0) return 'renovando';
    const m = Math.floor(ms / 60000);
    if (m < 60) return m + 'min';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h' + String(m % 60).padStart(2, '0');
    return Math.floor(h / 24) + 'd' + (h % 24) + 'h';
  }
  function dur(s) {
    return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'min' : Math.floor(s / 3600) + 'h';
  }
  function dmy(iso) {
    const p = (iso || '').split('-');
    return p.length === 3 ? p[2] + '/' + p[1] : iso;
  }
  function pct1(v) {
    return v.toFixed(1).replace('.', ',') + '%';
  }

  const $ = (id) => document.getElementById(id);
  function setText(el, v) {
    if (el && el.textContent !== v) el.textContent = v;
  }
  function setClass(el, v) {
    if (el && el.className !== v) el.className = v;
  }

  const DIAS = [
    'DOMINGO',
    'SEGUNDA-FEIRA',
    'TERÇA-FEIRA',
    'QUARTA-FEIRA',
    'QUINTA-FEIRA',
    'SEXTA-FEIRA',
    'SÁBADO',
  ];

  // ── helpers de SVG ────────────────────────────────────────────────────
  function el(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  /* Catmull-Rom -> Bezier: a curva "natural" do padrão. Sem isso a linha vira
     um zigue-zague de segmentos retos, que é o que denuncia gráfico caseiro. */
  function smooth(pts, minY, maxY) {
    if (!pts.length) return '';
    if (pts.length < 3) return pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ',' + p[1]).join('');
    const clamp = (v) => Math.max(minY, Math.min(maxY, v));
    let d = 'M' + pts[0][0] + ',' + pts[0][1];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = clamp(p1[1] + (p2[1] - p0[1]) / 6);
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = clamp(p2[1] - (p3[1] - p1[1]) / 6);
      d += 'C' + c1x + ',' + c1y + ' ' + c2x + ',' + c2y + ' ' + p2[0] + ',' + p2[1];
    }
    return d;
  }

  // ── tooltip em cartão ─────────────────────────────────────────────────
  const tip = () => $('tip');
  function showTip(ev, html) {
    const t = tip();
    t.innerHTML = html;
    t.hidden = false;
    const r = t.getBoundingClientRect();
    let x = ev.clientX + 12;
    let y = ev.clientY - r.height - 10;
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - 12;
    if (y < 8) y = ev.clientY + 16;
    t.style.left = x + 'px';
    t.style.top = y + 'px';
  }
  function hideTip() {
    tip().hidden = true;
  }
  function bindTip(node, html) {
    node.addEventListener('mousemove', (ev) => showTip(ev, html));
    node.addEventListener('mouseleave', hideTip);
  }

  // ── reator ────────────────────────────────────────────────────────────
  // Nivel = quao recente foi o ultimo turno entre as sessoes vivas: <15s
  // cheio, degradando ate zero em ~3min de silencio. Giro e respiracao
  // aceleram juntos com o nivel.
  function setLevel(level) {
    const core = $('core');
    if (!core) return;
    const spin = 10 / ((0.012 + 0.055 * level) * 6 * (1000 / 70));
    const breath = (2 * Math.PI) / (0.09 + 0.09 * level) / (1000 / 70);
    core.style.setProperty('--spin', spin.toFixed(2) + 's');
    core.style.setProperty('--breath', breath.toFixed(2) + 's');
    core.style.setProperty('--glow', (0.28 + 0.45 * level).toFixed(2));
  }

  function levelOf(sessions) {
    const idles = (sessions || []).map((s) => s.idle).filter((v) => v != null);
    if (!idles.length) return 0;
    const youngest = Math.min.apply(null, idles);
    return youngest < 15 ? 1 : Math.max(0, 1 - (youngest - 15) / 165);
  }

  // ── frescor da cota ───────────────────────────────────────────────────
  function freshState(acct, label) {
    const age = acct ? acct.age_s : null;
    const live = acct && acct.source === 'live';
    let txt = '';
    let cls = 'fresh';
    if (age == null) {
      if (live) {
        txt = label + ' ● ao vivo';
        cls = 'fresh live';
      }
    } else if (live) {
      // mostra a idade mesmo ao vivo: a consulta tem intervalo de ~2min e
      // pode recuar se a API limitar, entao "ao vivo" sozinho esconderia um
      // numero velho
      txt = label + ' ● ' + (age < 30 ? 'agora' : dur(age));
      cls = age < 300 ? 'fresh live' : 'fresh old';
    } else {
      txt = label + ' ○ ' + dur(age);
      cls = age > 600 ? 'fresh old' : 'fresh';
    }
    return { txt, cls };
  }

  function renderFresh(claude, codex, selected) {
    const rows = [
      ['claude', claude, $('fresh-claude'), 'CLAUDE'],
      ['codex', codex, $('fresh-codex'), 'CODEX'],
    ];
    rows.forEach(([name, account, element, label]) => {
      // na visão geral cada cartão mostra o próprio frescor; no topo seria repetição
      const show = selected === name;
      const state = freshState(account, label);
      element.hidden = !show || !state.txt;
      setText(element, state.txt);
      setClass(element, state.cls);
    });
  }

  // ── cotas ─────────────────────────────────────────────────────────────
  const RING_ORDER = ['session', 'weekly_all', 'weekly_scoped', '_spend'];

  function quotaItems(bars, spend) {
    const items = (bars || []).filter((b) => b.percent != null).map((b) => Object.assign({}, b));
    if (spend && spend.percent != null) {
      items.push({
        kind: '_spend',
        label: 'Créditos',
        percent: spend.percent,
        severity: spend.severity,
        foot: (spend.currency || '') + ' ' + brl(spend.used || 0),
      });
    }
    const rank = (k) => {
      const i = RING_ORDER.indexOf(k);
      return i < 0 ? 99 : i;
    };
    items.sort((a, b) => rank(a.kind) - rank(b.kind));
    return items.slice(0, 4);
  }

  /** nome da cota sem a ferramenta: "SESSÃO 5H", "SEMANAL", "FABLE". Serve
      aos cartões da visão geral, onde a ferramenta já está no título. */
  function tileName(b) {
    switch (b.kind) {
      case 'session':
        return 'SESSÃO 5H';
      case 'weekly_all':
        return 'SEMANAL';
      case 'weekly_opus':
        return 'OPUS';
      case '_spend':
        return 'CRÉDITOS';
      case 'weekly_scoped': {
        // "Semanal · Fable" -> "FABLE": o modelo é o que distingue a cota
        const parts = (b.label || '').split('·');
        return (parts.length > 1 ? parts[1].trim() : 'SEMANAL').toUpperCase();
      }
    }
    // Codex: "Codex · 5 h", "Codex · 1 sem" ou "Codex · <balde> · 5 h". As
    // janelas ganham o mesmo nome das do Claude para os cartões se lerem igual.
    const parts = (b.label || '').replace(/^Codex\s*·\s*/i, '').split('·').map((s) => s.trim());
    const win = parts.pop() || '';
    const hours = /^(\d+) h$/.exec(win);
    const name = hours ? 'SESSÃO ' + hours[1] + 'H' : win === '1 sem' ? 'SEMANAL' : win.toUpperCase();
    return (parts.length ? parts.join(' · ').toUpperCase() + ' · ' : '') + name;
  }

  function tileLabel(b) {
    if (b.kind === '_spend') return 'CRÉDITOS';
    return (b.provider === 'codex' ? 'CODEX' : 'CLAUDE') + ' · ' + tileName(b);
  }

  /* Tiles de cota com filete. Mesmo componente na faixa de KPI dos painéis
     e nos cartões da visão geral; `prefix` separa os ids de cada lugar. */
  function syncQuotaTiles(box, items, prefix, before, label, foot) {
    const keep = new Set();
    items.forEach((b, idx) => {
      const key = prefix + String(b.kind || idx).replace(/[^a-zA-Z0-9_]/g, '_');
      keep.add(key);
      let e = document.getElementById(key);
      if (!e) {
        e = document.createElement('div');
        e.id = key;
        e.innerHTML =
          '<div class="qnum"><b></b><i>%</i></div>' +
          '<div class="qlbl"></div>' +
          '<div class="qfoot"></div>' +
          '<div class="qfil"><i></i></div>';
        box.insertBefore(e, before || null);
      }
      const sev = (b.severity || 'normal').toLowerCase();
      setClass(e, 'q ' + sev);
      if (e.style.order !== String(idx)) e.style.order = idx;

      setText(e.querySelector('.qnum b'), String(Math.round(b.percent)));
      setText(e.querySelector('.qlbl'), label(b));
      setText(e.querySelector('.qfoot'), foot(b));
      const fil = e.querySelector('.qfil i');
      const w = Math.min(Math.max(b.percent || 0, 0), 100) + '%';
      if (fil.style.width !== w) fil.style.width = w;
    });

    // só remove o que este lugar criou: os tiles fixos (k_*) e os avisos ficam
    [].slice.call(box.children).forEach((c) => {
      if (c.id.indexOf(prefix) === 0 && !keep.has(c.id)) c.remove();
    });
  }

  function resetText(b) {
    return b.foot || (b.resets_at ? '↻ ' + until(b.resets_at) : '');
  }

  function renderQuotas(acct, codex) {
    const withSource = (account, key) => quotaItems(account && account.bars, account && account.spend)
      .map((item) => Object.assign(item, { source: account && account.source, provider_key: key }));
    const items = withSource(acct, 'claude').concat(withSource(codex, 'codex'));
    $('q-empty').hidden = items.length > 0;
    syncQuotaTiles($('kpis'), items, 'q_', $('k_out'), tileLabel, (b) => {
      const source = b.source === 'live' ? '● oficial' : b.provider_key === 'codex' ? '○ última consulta' : '○ cache';
      const reset = resetText(b);
      return reset ? source + ' · ' + reset : source;
    });
  }

  // ── hoje ──────────────────────────────────────────────────────────────
  function renderDay(d) {
    const day = d.day;
    const now = new Date();

    const [val, unit] = splitUnit(day.output);
    setText($('d-out'), val);
    setText($('d-unit'), unit);
    const providers = day.providers || {};
    const used = Object.keys(providers).filter((key) => providers[key].turns || providers[key].total);
    const names = used.map((key) => key.toUpperCase());
    const breakdown = used.map((key) => key.toUpperCase() + ' ' + short(providers[key].output)).join(' · ');
    setText($('d-out-label'), names.length ? 'SAÍDA HOJE · ' + names.join(' + ') : 'SAÍDA HOJE');
    // com uma ferramenta só, a quebra repetiria o número grande do tile
    setText($('d-turns'), brl(day.turns) + ' turnos' + (used.length > 1 ? ' · ' + breakdown : ''));

    const comp = day.comp || { i: 0, o: 0, cw: 0, cr: 0, total: 0 };
    const [mv, mu] = splitUnit(comp.total);
    setText($('d-mov'), mv);
    setText($('d-movu'), mu);
    setText($('d-mov-label'), names.length > 1 ? 'MOVIMENTADO · COMBINADO' : names.length ? 'MOVIMENTADO · ' + names[0] : 'MOVIMENTADO');
    const isCodex = provider === 'codex';
    setText($('d-cost'), isCodex ? brl(day.turns) : brl(day.cost));
    setText($('d-cost-unit'), isCodex ? '' : 'US$');
    setText($('d-cost-label'), isCodex ? 'TURNOS HOJE · CODEX' : 'EQUIVALENTE API · CLAUDE');
    setText($('d-cost-foot'), isCodex ? 'turnos nos registros locais' : 'estimativa Claude, não fatura');

    hourChart($('d-chart'), day.hours || [], now.getHours());
    renderComp(comp);
  }

  /* Área com gradiente + linha suave + marcador da hora corrente. */
  let hourSig = '';
  function hourChart(box, hours, nowH) {
    const sig = hours.map((h) => h.o).join(',') + '|' + nowH;
    if (sig === hourSig) return;
    hourSig = sig;

    const W = 300;
    const H = 84;
    const PAD = 6;
    const max = Math.max.apply(null, hours.map((h) => h.o).concat([1]));
    setText($('d-peak'), 'pico ' + short(max) + '/h');

    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' });
    const defs = el('defs');
    const g = el('linearGradient', { id: 'gradAccent', x1: '0', y1: '0', x2: '0', y2: '1' });
    // cor no css (.g-top/.g-bot): segue o acento, que muda no painel Codex
    g.appendChild(el('stop', { offset: '0%', class: 'g-top' }));
    g.appendChild(el('stop', { offset: '100%', class: 'g-bot' }));
    defs.appendChild(g);
    svg.appendChild(defs);

    // gridlines horizontais: dão escala sem pedir atenção
    for (let k = 1; k <= 3; k++) {
      const y = PAD + ((H - PAD * 2) * k) / 4;
      svg.appendChild(el('line', { class: 'gridline', x1: 0, y1: y, x2: W, y2: y }));
    }
    svg.appendChild(el('line', { class: 'axisline', x1: 0, y1: H - PAD, x2: W, y2: H - PAD }));

    const pts = hours.map((h, i) => [
      (i / Math.max(hours.length - 1, 1)) * W,
      H - PAD - (h.o / max) * (H - PAD * 2),
    ]);
    const line = smooth(pts, PAD, H - PAD);
    svg.appendChild(
      el('path', { class: 'area', d: line + 'L' + W + ',' + (H - PAD) + 'L0,' + (H - PAD) + 'Z' }),
    );
    svg.appendChild(el('path', { class: 'spark-line', d: line }));

    if (pts[nowH]) {
      svg.appendChild(
        el('line', { class: 'vline', x1: pts[nowH][0], y1: pts[nowH][1], x2: pts[nowH][0], y2: H - PAD }),
      );
      svg.appendChild(el('circle', { class: 'dot', cx: pts[nowH][0], cy: pts[nowH][1], r: 3 }));
    }

    // faixas invisíveis de captura: a curva é fina demais para servir de alvo
    const bw = W / Math.max(hours.length, 1);
    hours.forEach((h, i) => {
      const hit = el('rect', { class: 'hit', x: i * bw, y: 0, width: bw, height: H });
      bindTip(
        hit,
        '<b>' + String(h.h).padStart(2, '0') + 'h</b><span><u>' + brl(h.o) + '</u> de saída</span>',
      );
      svg.appendChild(hit);
    });

    box.innerHTML = '';
    box.appendChild(svg);
  }

  /* composição do que circulou: 98% costuma ser cache read, e é isso que
     explica o custo — o número de "saída" sozinho esconde a conta */
  const COMP_PARTS = [
    ['cr', 'cache read', 'sw-cr'],
    ['cw', 'cache write', 'sw-cw'],
    ['o', 'saída', 'sw-o'],
    ['i', 'entrada', 'sw-i'],
  ];

  function renderComp(comp) {
    const total = comp.total || 0;
    const share = total > 0 ? ((comp.cr || 0) / total) * 100 : 0;

    const G = $('c-gauge');
    if (!G.dataset.built) {
      const R = 34;
      const C = 2 * Math.PI * R;
      const svg = el('svg', { viewBox: '0 0 84 84' });
      svg.appendChild(el('circle', { class: 'track', cx: 42, cy: 42, r: R }));
      const fill = el('circle', {
        class: 'fill',
        cx: 42,
        cy: 42,
        r: R,
        transform: 'rotate(-90 42 42)',
        'stroke-dasharray': '0 ' + C,
      });
      svg.appendChild(fill);
      const num = el('text', { class: 'gnum', x: 42, y: 44 });
      const lbl = el('text', { class: 'glbl', x: 42, y: 56 });
      lbl.textContent = 'CACHE';
      svg.appendChild(num);
      svg.appendChild(lbl);
      G.appendChild(svg);
      G.dataset.built = '1';
      G._fill = fill;
      G._num = num;
      G._c = C;
    }
    const dash = ((share / 100) * G._c).toFixed(1) + ' ' + G._c.toFixed(1);
    if (G._fill.getAttribute('stroke-dasharray') !== dash) {
      G._fill.setAttribute('stroke-dasharray', dash);
    }
    setText(G._num, share.toFixed(1).replace('.', ',') + '%');

    const L = $('c-rows');
    if (!L.dataset.built) {
      L.innerHTML = COMP_PARTS.map(
        ([, label, sw]) =>
          '<div class="crow"><em class="' + sw + '"></em><span>' + label +
          '</span><span class="cv"></span><span class="cp"></span></div>',
      ).join('');
      L.dataset.built = '1';
    }
    COMP_PARTS.forEach(([k], idx) => {
      const v = comp[k] || 0;
      const row = L.children[idx];
      setText(row.querySelector('.cv'), short(v));
      setText(row.querySelector('.cp'), pct1(total > 0 ? (v / total) * 100 : 0));
      const ti = brl(v) + ' tokens';
      if (row.title !== ti) row.title = ti;
    });
  }

  // ── histórico ─────────────────────────────────────────────────────────
  let histSig = '';
  function renderHistory(h, selected) {
    if (!h || !h.ready) {
      setText($('h-title'), 'HISTÓRICO ' + selected.toUpperCase());
      setText($('h-sum'), 'varrendo os registros…');
      return;
    }
    setText($('h-title'), selected.toUpperCase() + ' · ' + h.window + ' DIAS');
    const T = h.totals;
    setText(
      $('h-sum'),
      (selected === 'claude' ? 'US$ ' + brl(T.cost) + ' · ' : '') + short(T.total) + ' · ' + brl(T.turns) + ' turnos',
    );

    const days = h.days || [];
    const sig = selected + '|' + days.map((d) => [d.d, d.total, d.output, d.cost, d.turns].join(':')).join('|');
    if (sig !== histSig) {
      histSig = sig;
      dayChart($('h-chart'), days, selected);
      const S = $('h-scale');
      if (days.length) {
        const mid = days[Math.floor(days.length / 2)];
        const marks = [dmy(days[0].d), dmy(mid.d), 'hoje'];
        if (S.children.length !== 3) S.innerHTML = '<span></span><span></span><span></span>';
        marks.forEach((m, i) => setText(S.children[i], m));
      }
    }

    renderRank($('h-projects'), h.projects, selected);
    renderRank($('h-models'), h.models, selected);
  }

  /* Barras com topo arredondado, gridline e a média do período tracejada. */
  function dayChart(box, days, selected) {
    const W = 300;
    const H = 86;
    const PAD = 4;
    const n = Math.max(days.length, 1);
    const gap = 1.6;
    const bw = (W - gap * (n - 1)) / n;
    const max = Math.max.apply(null, days.map((d) => d.total).concat([1]));
    const withData = days.filter((d) => d.total > 0);
    const avg = withData.length
      ? withData.reduce((a, d) => a + d.total, 0) / withData.length
      : 0;

    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' });
    for (let k = 1; k <= 3; k++) {
      const y = ((H - PAD) * k) / 4;
      svg.appendChild(el('line', { class: 'gridline', x1: 0, y1: y, x2: W, y2: y }));
    }
    svg.appendChild(el('line', { class: 'axisline', x1: 0, y1: H - PAD, x2: W, y2: H - PAD }));

    days.forEach((d, i) => {
      const x = i * (bw + gap);
      const hh = d.total > 0 ? Math.max(((d.total / max) * (H - PAD * 2)), 2) : 1.5;
      const y = H - PAD - hh;
      const cls = 'bar' + (d.total > 0 ? (i === days.length - 1 ? ' today' : '') : ' zero');
      const r = el('rect', { class: cls, x: x, y: y, width: bw, height: hh, rx: Math.min(bw / 2.6, 2) });
      bindTip(
        r,
        '<b>' +
          dmy(d.d) +
          '</b><span><u>' +
          short(d.total) +
          '</u> movimentados</span><span>' +
          short(d.output) +
          ' de saída' +
          (selected === 'claude' ? ' · ≈US$ ' + brl(d.cost) : '') +
          '</span><span>' +
          brl(d.turns) +
          ' turnos</span>',
      );
      svg.appendChild(r);
    });

    if (avg > 0) {
      const y = H - PAD - (avg / max) * (H - PAD * 2);
      svg.appendChild(el('line', { class: 'refline', x1: 0, y1: y, x2: W, y2: y }));
    }

    box.innerHTML = '';
    box.appendChild(svg);
  }

  function renderRank(box, rows, selected) {
    rows = rows || [];
    if (box.children.length !== rows.length) {
      box.innerHTML = rows
        .map(
          () =>
            '<div class="rrow"><div class="rtop"><span class="rn"></span>' +
            '<span class="rv"></span></div><span class="rb"><i></i></span></div>',
        )
        .join('');
    }
    const max = Math.max.apply(null, rows.map((r) => r.total).concat([1]));
    rows.forEach((r, i) => {
      const e = box.children[i];
      setText(e.querySelector('.rn'), r.n);
      setText(e.querySelector('.rv'), short(r.total));
      const bar = e.querySelector('.rb i');
      const w = ((r.total / max) * 100).toFixed(1) + '%';
      if (bar.style.width !== w) bar.style.width = w;
      const ti = r.n + ' — ' + brl(r.total) + ' tokens' +
        (selected === 'claude' ? ' · ≈US$ ' + brl(r.cost) : '');
      if (e.title !== ti) e.title = ti;
    });
  }

  // ── telemetria (OTel nativa do Claude Code) ───────────────────────────
  /* O painel mostra o estado LIDO do settings.json e um espelho, calculado
     dos transcripts locais, do que as métricas claude_code.* reportam.
     Credenciais nunca chegam aqui: só a PRESENÇA do cabeçalho é informada. */
  function rows(box, list) {
    if (box.children.length !== list.length) {
      box.innerHTML = list
        .map(() => '<div class="trow"><span class="tk"></span><span class="tv"></span></div>')
        .join('');
    }
    list.forEach((r, i) => {
      const e = box.children[i];
      setClass(e, 'trow' + (r.cls ? ' ' + r.cls : ''));
      setText(e.querySelector('.tk'), r.k);
      setText(e.querySelector('.tv'), r.v);
      if (r.t && e.title !== r.t) e.title = r.t;
    });
  }

  function renderTelemetry(t, d) {
    t = t || { configured: false, enabled: false, hasAuth: false, privacy: [] };
    const day = d.day || {};
    const comp = day.comp || {};
    const wire = day.wire || { win_s: 60, win: {}, sessions: 0, active_s: 0 };
    const win = wire.win || {};
    const winTok = win.total || 0;
    const sending = t.enabled && !!t.endpoint;

    const st = $('t-state');
    setText(
      st,
      sending
        ? winTok > 0
          ? '● transmitindo'
          : '● ativa — sem tráfego novo'
        : t.configured
          ? '○ configurada, mas desligada — nada é exportado'
          : '○ não configurada — nada sai desta máquina',
    );
    setClass(st, 'who ' + (sending ? 'tel-on' : 'tel-off'));

    /* coluna 1 — o fluxo: o delta da última janela é a carga do próximo
       export. Espelho dos mesmos transcripts, não interceptação. */
    setText(
      $('t-win-lbl'),
      (sending ? 'SAINDO AGORA' : 'ATIVIDADE LOCAL') + ' · ÚLTIMOS ' + (wire.win_s || 60) + 's' + (sending ? '' : ' · NÃO EXPORTADO'),
    );
    const gerando = (d.sessions || []).filter((s) => s.idle != null && s.idle < 60).length;
    rows($('t-wire'), [
      {
        k: 'tokens na janela',
        v: winTok > 0 ? short(winTok) : 'nada',
        cls: winTok > 0 ? 'on' : '',
        t: 'input + output + cache write + cache read dos últimos ' + (wire.win_s || 60) + 's',
      },
      { k: '· saída', v: short(win.o || 0) },
      { k: '· cache (r+w)', v: short((win.cr || 0) + (win.cw || 0)) },
      { k: 'custo na janela', v: 'US$ ' + money(win.cost || 0) },
      {
        k: 'eventos api_request',
        v: String(win.requests || 0),
        t: 'cada turno com usage gera um evento claude_code.api_request',
      },
      { k: 'sessões gerando', v: String(gerando) + ' de ' + (d.active || 0) },
    ]);

    /* coluna 2 — as métricas com o NOME REAL que chega ao coletor, e o valor
       que esta máquina acumulou hoje. */
    rows($('t-metrics'), [
      { k: 'token.usage · input', v: short(comp.i || 0) },
      { k: 'token.usage · output', v: short(comp.o || 0) },
      { k: 'token.usage · cacheRead', v: short(comp.cr || 0) },
      { k: 'token.usage · cacheCreation', v: short(comp.cw || 0) },
      { k: 'cost.usage', v: 'US$ ' + money(day.cost || 0) },
      { k: 'session.count', v: String(wire.sessions || 0), t: 'sessões principais com atividade hoje' },
      {
        k: 'active_time.total',
        v: '≈ ' + dur(wire.active_s || 0),
        t: 'estimado dos intervalos entre turnos (gaps até 5min); o valor oficial é medido pelo Claude Code',
      },
      {
        k: 'lines_of_code · commit · pull_request',
        v: 'sem espelho local',
        t: 'Enviadas pelo Claude Code quando a telemetria está ativa, mas não ficam nos transcripts — não dá para reconstituir daqui.',
      },
    ]);

    /* coluna 3 — para onde iria e o que está BLOQUEADO de sair. */
    const ligados = (t.privacy || []).filter((p) => p.on);
    const acct = d.account || {};
    rows($('t-conn'), [
      { k: 'conta (user.email)', v: acct.email || '—', t: acct.email },
      { k: 'destino', v: t.endpoint ? t.endpoint.replace(/^https?:\/\//, '') : 'nenhum' },
      { k: 'protocolo', v: t.protocol || '—' },
      {
        k: 'exportadores',
        v: [t.metricsExporter, t.logsExporter].filter(Boolean).join(' · ') || '—',
      },
      {
        k: 'autenticação',
        v: t.hasAuth ? 'configurada' : 'nenhuma',
        t: 'O valor da credencial nunca sai do seu disco — o painel só verifica se existe.',
      },
      {
        k: 'conteúdo (prompt/código)',
        v: ligados.length ? '⚠ SAINDO: ' + ligados.map((p) => p.label).join(', ') : '✓ não sai',
        cls: ligados.length ? 'off' : 'on',
        t: (t.privacy || []).map((p) => p.key + ' = ' + (p.on ? 'LIGADO' : 'desligado')).join('\n'),
      },
    ]);
  }

  // ── sessões ───────────────────────────────────────────────────────────
  function renderSessions(d) {
    const sessions = d.sessions || [];
    const n = sessions.length;
    setText($('sess-count'), n === 1 ? '1 SESSÃO ATIVA' : n + ' SESSÕES ATIVAS');
    const subs = sessions.reduce((a, s) => a + (s.subagents || 0), 0);
    setText($('sess-note'), subs ? subs + ' subagentes somados' : '');

    const box = $('cards');
    if (!n) {
      if (!box.querySelector('.empty')) {
        box.innerHTML = '<div class="empty full">Nenhuma sessão ativa detectada.</div>';
      }
      return;
    }
    if (box.querySelector('.empty')) box.innerHTML = '';

    const keep = new Set();

    sessions.forEach((s, idx) => {
      const key = 'c_' + (s.provider || 'claude') + '_' + s.sid;
      keep.add(key);
      let e = document.getElementById(key);
      if (!e) {
        e = document.createElement('div');
        e.id = key;
        e.innerHTML =
          '<div class="rail"></div><div class="body">' +
          '<div class="shead"><span class="prod"><span class="ptxt"></span>' +
          '<span class="here" hidden>aqui</span></span><span class="idle"></span></div>' +
          '<div class="title"></div>' +
          '<div class="meta"></div>' +
          '<div class="ctx"><div class="bar"><i></i></div><span class="cnum"></span></div>' +
          '<div class="stat"></div></div>';
        box.appendChild(e);
      }

      const hot = s.idle != null && s.idle < 90;
      setClass(e, 's' + (hot ? ' hot' : ''));
      if (e.style.order !== String(idx)) e.style.order = idx;

      setText(e.querySelector('.ptxt'), (s.provider === 'codex' ? 'CODEX · ' : 'CLAUDE · ') + (s.product || s.name || '?').toUpperCase());
      e.querySelector('.here').hidden = !s.here;
      setText(e.querySelector('.idle'), (hot ? '▶ ' : '') + ago(s.idle));

      const title = e.querySelector('.title');
      const t = s.title || (s.turns ? s.name || '—' : 'sessão nova');
      if (title.textContent !== t) {
        title.textContent = t;
        title.title = (s.title ? s.title + '\n' : '') + (s.cwd_full || '') + '\n' + s.sid;
      }
      // subagentes: o consumo deles já está somado nesta sessão, então o
      // cartão precisa dizer que está somando — senão o número parece errado
      setText(
        e.querySelector('.meta'),
        (s.provider === 'codex' ? 'Codex local' : 'Claude · pid ' + s.pid) +
          ' · ' +
          (s.model || '?') +
          ' · desde ' +
          (s.started || '—') +
          (s.subagents ? ' · +' + s.subagents + ' sub' : ''),
      );

      const cap = s.context_max || CTX_MAX;
      const capTxt = cap === 1e6 ? '1mi' : short(cap);
      const p = Math.min((s.context / cap) * 100, 100);
      const lvl = p >= 90 ? 'crit' : p >= 70 ? 'warn' : '';
      const bar = e.querySelector('.bar i');
      const w = p.toFixed(1) + '%';
      if (bar.style.width !== w) bar.style.width = w;
      setClass(bar, lvl);
      setText(e.querySelector('.cnum'), short(s.context) + ' / ' + capTxt);

      setText(
        e.querySelector('.stat'),
        s.turns
          ? short(s.output) + ' saída · ' + s.turns + ' turnos' +
            (s.provider === 'codex' ? '' : ' · ≈$' + money(s.cost))
          : 'aguardando o primeiro turno',
      );
    });

    [].slice.call(box.children).forEach((c) => {
      if (!keep.has(c.id)) c.remove();
    });
  }

  // ── entrada ───────────────────────────────────────────────────────────
  function filtered(d) {
    if (provider === 'all') return d;
    const slice = d.day && d.day.providers && d.day.providers[provider];
    const day = slice ? Object.assign({}, d.day, {
      output: slice.output,
      cost: slice.cost,
      turns: slice.turns,
      comp: slice.comp,
      hours: slice.hours,
      models: slice.models,
      providers: { [provider]: slice },
    }) : d.day;
    return Object.assign({}, d, {
      account: provider === 'claude' ? d.account : { bars: [], spend: null, age_s: null, source: 'none' },
      codex: provider === 'codex' ? d.codex : undefined,
      sessions: (d.sessions || []).filter((s) => s.provider === provider),
      day,
      history: provider === 'claude' ? d.history : d.codexHistory,
      telemetry: provider === 'claude' ? d.telemetry : undefined,
    });
  }

  /** quais ferramentas esta máquina usa: cota, consumo, histórico ou sessão */
  function detect(raw) {
    const sessions = raw.sessions || [];
    const used = (name, account, history) =>
      ((account && account.bars) || []).length > 0 ||
      ((raw.day && raw.day.providers && raw.day.providers[name] && raw.day.providers[name].total) || 0) > 0 ||
      ((history && history.totals && history.totals.total) || 0) > 0 ||
      sessions.some((s) => s.provider === name);
    return {
      claude: used('claude', raw.account, raw.history),
      codex: used('codex', raw.codex, raw.codexHistory),
    };
  }

  /* A visão geral só existe com as duas ferramentas. Com uma só, o painel
     dela é o único destino — e o seletor some, porque não há o que escolher. */
  function resolveView(has) {
    if (picked === 'claude' && has.claude) return 'claude';
    if (picked === 'codex' && has.codex) return 'codex';
    if (has.claude && has.codex) return 'all';
    return has.codex && !has.claude ? 'codex' : 'claude';
  }

  function render(raw) {
    if (!raw) return;
    latest = raw;

    if (raw.error) {
      // payload de erro vem vazio: não serve para decidir qual painel mostrar
      setLevel(0);
      $('alert').innerHTML = '<div class="err">' + escapeHtml(raw.error) + '</div>';
      return;
    }
    if ($('alert').innerHTML !== '') $('alert').innerHTML = '';

    const has = detect(raw);
    provider = resolveView(has);
    const overview = provider === 'all';

    const views = $('views');
    views.hidden = !(has.claude && has.codex);
    [].slice.call(views.children).forEach((b) => {
      const on = String(b.dataset.go === provider);
      if (b.getAttribute('aria-pressed') !== on) b.setAttribute('aria-pressed', on);
    });
    document.body.classList.toggle('prov-codex', provider === 'codex');

    const d = filtered(raw);
    if (typeof d.ctx_max === 'number' && d.ctx_max > 0) CTX_MAX = d.ctx_max;

    setLevel(levelOf(d.sessions));
    setText($('clock'), d.now);
    setText($('d-date'), DIAS[new Date().getDay()] + ' ' + dmy(d.date));
    renderFresh(raw.account, raw.codex, provider);

    // identidade no topo só no painel de uma ferramenta; na visão geral cada
    // cartão já traz a sua
    const who = provider === 'codex' ? d.codex : d.account;
    const ident = !overview && who && (who.bars || []).length
      ? provider.toUpperCase() + (who.email ? ' · ' + who.email : who.tier ? ' · ' + String(who.tier).toUpperCase() : '')
      : '';
    setText($('sess-acct'), ident);

    $('overview').hidden = !overview;
    $('kpis').hidden = overview;
    $('live-grid').hidden = overview;
    $('hist-grid').hidden = overview;
    $('tel-panel').hidden = provider !== 'claude';
    $('codex-detail').hidden = provider !== 'codex';
    $('panel-footer').hidden = overview;
    $('footer-claude').hidden = provider !== 'claude';
    $('footer-codex').hidden = provider !== 'codex';

    if (overview) {
      renderOverview(raw);
      return;
    }
    $('q-empty').textContent = provider === 'codex'
      ? 'Cotas Codex não encontradas. Abra o Codex e faça login.'
      : 'Cotas Claude não encontradas. Abra o Claude Code e rode /usage.';
    renderQuotas(d.account, d.codex);
    renderDay(d);
    renderHistory(d.history, provider);
    if (provider === 'claude') renderTelemetry(d.telemetry, d);
    else renderCodexDetail(d);
    renderSessions(d);
  }

  // ── visão geral ───────────────────────────────────────────────────────
  const PROVIDERS = ['claude', 'codex'];
  const EMPTY_SLICE = { output: 0, total: 0, turns: 0, cost: 0, models: [], hours: [] };
  const isHot = (s) => s.idle != null && s.idle < 90;

  function renderOverview(raw) {
    const prov = (raw.day && raw.day.providers) || {};
    const slice = (name) => prov[name] || EMPTY_SLICE;
    const sessions = raw.sessions || [];

    PROVIDERS.forEach((name) => {
      renderAccountCard(
        name,
        name === 'claude' ? raw.account : raw.codex,
        slice(name),
        sessions.filter((s) => s.provider === name),
      );
    });

    // ── hoje, lado a lado ──
    const c = slice('claude');
    const x = slice('codex');
    legend($('ov-h-legend'), c.output, x.output, short);
    const hourOf = (list, h) => ((list || [])[h] || {}).o || 0;
    const hours = [];
    for (let h = 0; h < 24; h++) {
      hours.push({ label: String(h).padStart(2, '0') + 'h', c: hourOf(c.hours, h), x: hourOf(x.hours, h) });
    }
    stackedChart($('ov-h-chart'), hours, { gap: 3, now: new Date().getHours(), noun: 'de saída' });
    renderSplits($('ov-split-today'), [
      ['SAÍDA', c.output, x.output, short],
      ['MOVIMENTADO', c.total, x.total, short],
      ['TURNOS', c.turns, x.turns, brl],
    ]);

    renderOvSessions(sessions);
    renderOvHistory(raw.history, raw.codexHistory);
  }

  /* Situação da conta em uma frase, com o ícone de status na frente: é a
     primeira coisa que se lê no cartão, antes dos números. */
  function headroom(items) {
    if (!items.length) return { cls: 'ov-headroom', html: '<span class="st">○</span> sem leitura de cota' };
    const top = items.reduce((a, b) => (b.percent > a.percent ? b : a));
    const sev = (top.severity || 'normal').toLowerCase();
    const name = tileName(top).toLowerCase();
    const what = '<b>' + escapeHtml(name.charAt(0).toUpperCase() + name.slice(1)) + ' ' + Math.round(top.percent) + '%</b>';
    const left = top.resets_at ? until(top.resets_at) : '';
    const when = !left ? '' : left === 'renovando' ? ' · renovando agora' : ' · renova em ' + left;
    if (sev === 'critical') return { cls: 'ov-headroom crit', html: '<span class="st">✕ No limite</span> · ' + what + when };
    if (sev === 'warning') return { cls: 'ov-headroom warn', html: '<span class="st">▲ Atenção</span> · ' + what + when };
    return { cls: 'ov-headroom ok', html: '<span class="st">✓ Com folga</span> · maior uso ' + what };
  }

  function setHtml(node, html) {
    if (node._html !== html) {
      node.innerHTML = html;
      node._html = html;
    }
  }

  function renderAccountCard(name, acct, slice, sessions) {
    acct = acct || { bars: [], spend: null, age_s: null, source: 'none' };
    const plan = name === 'claude' ? acct.account || acct.tier : acct.tier;
    setText(
      $('ov-' + name + '-who'),
      [plan ? String(plan).replace(/_/g, ' ').toUpperCase() : '', acct.email || ''].filter(Boolean).join(' · '),
    );

    // frescor da cota: ao vivo x última leitura, com a idade sempre à vista
    const fresh = $('ov-' + name + '-fresh');
    const age = acct.age_s;
    const when = age == null ? '' : ' · ' + (age < 30 ? 'agora' : 'há ' + dur(age));
    if (acct.source === 'live') {
      setText(fresh, '● ao vivo' + when);
      setClass(fresh, age != null && age >= 300 ? 'fresh old' : 'fresh live');
    } else if (acct.source === 'cache') {
      setText(fresh, '○ ' + (name === 'codex' ? 'última consulta' : 'cache') + when);
      setClass(fresh, age != null && age > 600 ? 'fresh old' : 'fresh');
    } else {
      setText(fresh, '');
    }

    const items = quotaItems(acct.bars, acct.spend);
    const state = headroom(items);
    const st = $('ov-' + name + '-state');
    setClass(st, state.cls);
    setHtml(st, state.html);

    const box = $('ov-' + name + '-quotas');
    let empty = box.querySelector('.empty');
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = name === 'codex'
        ? 'Cotas indisponíveis — abra o Codex e faça login.'
        : 'Cotas indisponíveis — rode /usage no Claude Code.';
      box.appendChild(empty);
    }
    empty.hidden = items.length > 0;
    syncQuotaTiles(box, items, 'oq_' + name + '_', null, tileName, (b) => resetText(b) || '—');

    setText($('ov-' + name + '-out'), short(slice.output));
    setText($('ov-' + name + '-mov'), short(slice.total));
    setText($('ov-' + name + '-turns'), brl(slice.turns));
    const hot = sessions.filter(isHot).length;
    setText($('ov-' + name + '-sess'), String(sessions.length));
    setText($('ov-' + name + '-sess-l'), hot ? 'SESSÕES · ' + hot + ' GERANDO' : 'SESSÕES ATIVAS');

    const model = slice.models && slice.models[0];
    let foot = model ? 'modelo do dia: ' + model.n : 'sem atividade hoje';
    if (name === 'claude' && slice.cost > 0) foot += ' · ≈ US$ ' + money(slice.cost) + ' em API';
    setText($('ov-' + name + '-foot'), foot);
  }

  /** legenda com o total de cada série: identifica a cor e já dá o número */
  function legend(box, c, x, fmt) {
    if (!box.dataset.built) {
      box.innerHTML =
        '<span><em class="sw claude"></em>Claude <b></b></span>' +
        '<span><em class="sw codex"></em>Codex <b></b></span>';
      box.dataset.built = '1';
    }
    const vals = box.querySelectorAll('b');
    setText(vals[0], fmt(c));
    setText(vals[1], fmt(x));
  }

  /* Colunas empilhadas, Claude na base e Codex em cima — ordem fixa, cor
     fixa por ferramenta. Uma escala só: a altura total é a soma, e o respiro
     de 2px entre os segmentos separa as duas sem precisar de contorno. */
  const chartSig = {};
  function stackedChart(box, rows, opts) {
    const sig = rows.map((r) => r.label + ':' + r.c + ':' + r.x).join('|') + '|' + opts.now;
    if (chartSig[box.id] === sig) return;
    chartSig[box.id] = sig;

    const W = 300;
    const H = 86;
    const PAD = 4;
    const SEP = 1.5;
    const n = Math.max(rows.length, 1);
    const gap = opts.gap;
    const bw = (W - gap * (n - 1)) / n;
    const inner = H - PAD * 2;
    const max = Math.max.apply(null, rows.map((r) => r.c + r.x).concat([1]));
    const rx = Math.min(bw / 2.6, 2);

    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' });
    for (let k = 1; k <= 3; k++) {
      const y = PAD + (inner * k) / 4;
      svg.appendChild(el('line', { class: 'gridline', x1: 0, y1: y, x2: W, y2: y }));
    }
    svg.appendChild(el('line', { class: 'axisline', x1: 0, y1: H - PAD, x2: W, y2: H - PAD }));

    rows.forEach((r, i) => {
      const x0 = i * (bw + gap);
      const g = el('g', { class: 'stack' });
      const tot = r.c + r.x;
      if (tot <= 0) {
        g.appendChild(el('rect', { class: 'bar zero', x: x0, y: H - PAD - 1.5, width: bw, height: 1.5, rx: rx }));
      } else {
        const full = Math.max((tot / max) * inner, 2);
        const hc = r.c > 0 ? Math.max((full * r.c) / tot, 1) : 0;
        const hx = r.x > 0 ? Math.max(full - hc - (hc ? SEP : 0), 1) : 0;
        let y = H - PAD;
        if (hc) {
          y -= hc;
          g.appendChild(el('rect', { class: 'seg-claude', x: x0, y: y, width: bw, height: hc, rx: rx }));
        }
        if (hx) {
          y -= (hc ? SEP : 0) + hx;
          g.appendChild(el('rect', { class: 'seg-codex', x: x0, y: y, width: bw, height: hx, rx: rx }));
        }
      }
      // alvo de hover na altura toda: a coluna baixa é fina demais para mirar
      g.appendChild(el('rect', { class: 'hit', x: x0 - gap / 2, y: 0, width: bw + gap, height: H }));
      bindTip(
        g,
        '<b>' + escapeHtml(r.label) + '</b>' +
          '<span><em class="sw claude"></em> Claude · ' + short(r.c) + ' ' + opts.noun + '</span>' +
          '<span><em class="sw codex"></em> Codex · ' + short(r.x) + ' ' + opts.noun + '</span>' +
          (tot > 0 ? '<span>Claude ' + Math.round((r.c / tot) * 100) + '% · Codex ' + Math.round((r.x / tot) * 100) + '%</span>' : ''),
      );
      svg.appendChild(g);
    });

    if (opts.avg) {
      const withData = rows.filter((r) => r.c + r.x > 0);
      if (withData.length) {
        const avg = withData.reduce((a, r) => a + r.c + r.x, 0) / withData.length;
        const y = H - PAD - (avg / max) * inner;
        svg.appendChild(el('line', { class: 'refline', x1: 0, y1: y, x2: W, y2: y }));
      }
    }
    // marca da hora corrente abaixo do eixo: onde o dia está agora
    if (opts.now != null && rows[opts.now]) {
      svg.appendChild(el('rect', { class: 'nowtick', x: opts.now * (bw + gap), y: H - PAD + 1.5, width: bw, height: 2, rx: 1 }));
    }

    box.innerHTML = '';
    box.appendChild(svg);
  }

  /* Parte-do-todo em barra 100%: dois segmentos, sempre Claude à esquerda. */
  function renderSplits(box, list) {
    if (box.children.length !== list.length) {
      box.innerHTML = list
        .map(
          () =>
            '<div class="srow"><span class="sk"></span><span class="sbar">' +
            '<i class="b-claude"></i><i class="b-codex"></i></span><span class="sv"></span></div>',
        )
        .join('');
    }
    list.forEach(([label, c, x, fmt], i) => {
      const row = box.children[i];
      const tot = c + x;
      const pc = tot > 0 ? (c / tot) * 100 : 0;
      setText(row.querySelector('.sk'), label);
      const bar = row.querySelector('.sbar');
      setClass(bar, 'sbar' + (tot > 0 ? ' has' : ''));
      setSeg(bar.children[0], tot > 0 ? pc : 0);
      setSeg(bar.children[1], tot > 0 ? 100 - pc : 0);
      setText(row.querySelector('.sv'), tot > 0 ? Math.round(pc) + '% · ' + Math.round(100 - pc) + '%' : '—');
      const ti = 'Claude ' + fmt(c) + ' · Codex ' + fmt(x);
      if (row.title !== ti) row.title = ti;
    });
  }

  function setSeg(node, pct) {
    node.hidden = !(pct > 0);
    const w = pct.toFixed(1) + '%';
    if (node.style.width !== w) node.style.width = w;
  }

  /* Ranking com barra em dois segmentos (projeto usado pelas duas) ou em um
     só com a amostra de cor na frente (modelo, que é de uma ferramenta). */
  function renderStackRank(box, rows, swatch) {
    if (box.children.length !== rows.length) {
      box.innerHTML = rows.length
        ? rows
            .map(
              () =>
                '<div class="rrow"><div class="rtop"><span class="rn"><em class="sw"></em><span></span></span>' +
                '<span class="rv"></span></div><span class="rb two"><i class="b-claude"></i>' +
                '<i class="b-codex"></i><i class="rest"></i></span></div>',
            )
            .join('')
        : '';
    }
    const max = Math.max.apply(null, rows.map((r) => r.c + r.x).concat([1]));
    rows.forEach((r, i) => {
      const e = box.children[i];
      const sw = e.querySelector('.rn .sw');
      sw.hidden = !swatch;
      if (swatch) setClass(sw, 'sw ' + (r.x > r.c ? 'codex' : 'claude'));
      setText(e.querySelector('.rn span'), r.n);
      setText(e.querySelector('.rv'), short(r.c + r.x));
      const segs = e.querySelectorAll('.rb i');
      setSeg(segs[0], (r.c / max) * 100);
      setSeg(segs[1], (r.x / max) * 100);
      segs[2].hidden = r.c + r.x >= max;
      const ti = r.n + ' — Claude ' + brl(r.c) + ' · Codex ' + brl(r.x) + ' tokens de saída';
      if (e.title !== ti) e.title = ti;
    });
  }

  function mergeRank(a, b) {
    const map = new Map();
    (a || []).forEach((r) => map.set(r.n, { n: r.n, c: r.output, x: 0 }));
    (b || []).forEach((r) => {
      const m = map.get(r.n) || { n: r.n, c: 0, x: 0 };
      m.x = r.output;
      map.set(r.n, m);
    });
    return [...map.values()]
      .filter((r) => r.c + r.x > 0)
      .sort((p, q) => q.c + q.x - (p.c + p.x))
      .slice(0, 8);
  }

  function renderOvHistory(ch, xh) {
    const ready = ch && ch.ready;
    const byDay = new Map();
    ((ready && ch.days) || []).forEach((d) => byDay.set(d.d, { label: d.d, c: d.output, x: 0 }));
    ((xh && xh.days) || []).forEach((d) => {
      const r = byDay.get(d.d) || { label: d.d, c: 0, x: 0 };
      r.x = d.output;
      byDay.set(d.d, r);
    });
    const days = [...byDay.values()].sort((a, b) => (a.label < b.label ? -1 : 1));
    const window = (ready && ch.window) || (xh && xh.window) || days.length;

    setText($('ov-d-title'), 'HISTÓRICO · ' + window + ' DIAS · SAÍDA POR DIA');
    legend(
      $('ov-d-legend'),
      ready ? ch.totals.o : 0,
      (xh && xh.totals && xh.totals.o) || 0,
      (v) => (ready || v ? short(v) : '…'),
    );
    stackedChart(
      $('ov-d-chart'),
      days.map((d) => ({ label: dmy(d.label), c: d.c, x: d.x })),
      { gap: 1.6, avg: true, noun: 'de saída' },
    );
    const S = $('ov-d-scale');
    if (days.length) {
      const marks = [dmy(days[0].label), dmy(days[Math.floor(days.length / 2)].label), 'hoje'];
      if (S.children.length !== 3) S.innerHTML = '<span></span><span></span><span></span>';
      marks.forEach((m, i) => setText(S.children[i], m));
    }
    // enquanto o histórico Claude varre, a divisão mostraria "0% · 100%":
    // melhor não mostrar número nenhum do que um número errado
    const ct = ready ? ch.totals : { o: 0, total: 0, turns: 0 };
    const xt = (ready && xh && xh.totals) || { o: 0, total: 0, turns: 0 };
    renderSplits($('ov-split-period'), [
      ['SAÍDA', ct.o, xt.o, short],
      ['MOVIMENTADO', ct.total, xt.total, short],
      ['TURNOS', ct.turns, xt.turns, brl],
    ]);

    renderStackRank($('ov-projects'), mergeRank(ready && ch.projects, xh && xh.projects), false);
    renderStackRank($('ov-models'), mergeRank(ready && ch.models, xh && xh.models), true);
  }

  /* Sessões das duas ferramentas numa lista só, mais recente em cima. Mais
     densa que os cartões dos painéis: aqui a pergunta é "o que está rodando",
     não o detalhe de cada uma. */
  function renderOvSessions(sessions) {
    const n = sessions.length;
    const hot = sessions.filter(isHot).length;
    setText($('ov-s-count'), n === 1 ? '1 SESSÃO ATIVA' : n + ' SESSÕES ATIVAS');
    setText($('ov-s-note'), n ? (hot ? hot + ' gerando agora' : 'nenhuma gerando agora') : '');

    const box = $('ov-sessions');
    if (!n) {
      if (!box.querySelector('.empty')) {
        box.innerHTML = '<div class="empty">Nenhuma sessão ativa no Claude nem no Codex.</div>';
      }
      return;
    }
    const stale = box.querySelector('.empty');
    if (stale) stale.remove();

    const keep = new Set();
    sessions.forEach((s, idx) => {
      const name = s.provider === 'codex' ? 'codex' : 'claude';
      const key = 'ovs_' + name + '_' + s.sid;
      keep.add(key);
      let e = document.getElementById(key);
      if (!e) {
        e = document.createElement('div');
        e.id = key;
        e.innerHTML =
          '<div class="rail"></div><div class="ovs-body">' +
          '<div class="ovs-top"><em class="sw ' + name + '"></em><span class="ovs-prod"></span>' +
          '<span class="ovs-idle"></span></div>' +
          '<div class="ovs-meta"></div>' +
          '<div class="ovs-ctx"><div class="bar"><i></i></div><span class="cnum"></span></div></div>';
        box.appendChild(e);
      }
      const on = isHot(s);
      setClass(e, 'ovs ' + name + (on ? ' hot' : ''));
      if (e.style.order !== String(idx)) e.style.order = idx;

      setText(e.querySelector('.ovs-prod'), (s.product || s.name || '?').toUpperCase());
      setText(e.querySelector('.ovs-idle'), (on ? '▶ ' : '') + ago(s.idle));
      const meta = [s.title, s.model || '?', s.turns ? s.turns + ' turnos' : 'aguardando o 1º turno']
        .concat(s.turns ? [short(s.output) + ' saída'] : [])
        .filter(Boolean)
        .join(' · ');
      setText(e.querySelector('.ovs-meta'), meta);
      const ti = (s.cwd_full || '') + '\n' + s.sid;
      if (e.title !== ti) e.title = ti;

      const cap = s.context_max || CTX_MAX;
      const p = Math.min((s.context / cap) * 100, 100);
      const bar = e.querySelector('.bar i');
      const w = p.toFixed(1) + '%';
      if (bar.style.width !== w) bar.style.width = w;
      setClass(bar, p >= 90 ? 'crit' : p >= 70 ? 'warn' : '');
      setText(e.querySelector('.cnum'), 'ctx ' + short(s.context) + ' / ' + (cap === 1e6 ? '1mi' : short(cap)));
    });

    [].slice.call(box.children).forEach((c) => {
      if (!keep.has(c.id)) c.remove();
    });
  }

  function renderCodexDetail(d) {
    const comp = d.day?.comp || {};
    const account = d.codex || {};
    const history = d.history || {};
    rows($('cx-usage'), [
      { k: 'entrada', v: short(comp.i || 0) },
      { k: 'saída', v: short(comp.o || 0) },
      { k: 'cache · leitura', v: short(comp.cr || 0) },
      { k: 'cache · escrita', v: short(comp.cw || 0) },
      { k: 'turnos', v: brl(d.day?.turns || 0) },
    ]);
    rows($('cx-account'), [
      { k: 'conta', v: account.email || '—' },
      { k: 'plano', v: account.tier || '—' },
      { k: 'origem da cota', v: account.source === 'live' ? 'consulta oficial' : account.source === 'cache' ? 'última consulta' : 'indisponível' },
      { k: 'consultada há', v: account.age_s == null ? '—' : ago(account.age_s) },
      { k: 'janelas', v: String((account.bars || []).length) },
    ]);
    rows($('cx-history'), [
      { k: 'período', v: (history.window || 0) + ' dias' },
      { k: 'tokens no período', v: short(history.totals?.total || 0) },
      { k: 'turnos no período', v: brl(history.totals?.turns || 0) },
      { k: 'projetos', v: String((history.projects || []).length) },
      { k: 'fonte', v: '~/.codex/sessions' },
    ]);
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (msg && msg.type === 'data') {
      // guarda o último payload: quando a view volta a ficar visível o VS Code
      // recria o webview e ela nasce com número em vez de vazia
      vscode.setState({ data: msg.payload, picked });
      render(msg.payload);
    }
  });

  function pick(value) {
    if (value === picked && value === provider) return;
    picked = value;
    if (latest) {
      vscode.setState({ data: latest, picked });
      render(latest);
      window.scrollTo(0, 0);
    }
  }

  // troca de visão no topo e "Abrir painel" nos cartões da visão geral
  document.addEventListener('click', (event) => {
    const go = event.target.closest && event.target.closest('[data-go]');
    if (go) pick(go.dataset.go);
  });

  const prev = vscode.getState();
  if (prev) {
    // `provider` era o nome da chave antes da visão geral ser o padrão
    picked = prev.picked || prev.provider || 'all';
    // versões antigas gravavam o payload direto no estado; sem payload nenhum,
    // espera o próximo poll em vez de renderizar um objeto vazio
    const data = prev.data || (prev.day ? prev : null);
    if (data) render(data);
  }
  vscode.postMessage({ type: 'ready' });
})();
