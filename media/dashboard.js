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
  function renderFresh(acct) {
    const e = $('fresh');
    const age = acct ? acct.age_s : null;
    const live = acct && acct.source === 'live';
    let txt = '';
    let cls = 'fresh';
    if (age == null) {
      if (live) {
        txt = '● ao vivo';
        cls = 'fresh live';
      }
    } else if (live) {
      // mostra a idade mesmo ao vivo: a consulta tem intervalo de ~2min e
      // pode recuar se a API limitar, entao "ao vivo" sozinho esconderia um
      // numero velho
      txt = '● ' + (age < 30 ? 'agora' : dur(age));
      cls = age < 300 ? 'fresh live' : 'fresh old';
    } else {
      txt = '○ ' + dur(age);
      cls = age > 600 ? 'fresh old' : 'fresh';
    }
    setText(e, txt);
    setClass(e, cls);
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

  function tileLabel(b) {
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
      default:
        return (b.label || '').toUpperCase();
    }
  }

  function renderQuotas(acct) {
    const box = $('kpis');
    const items = quotaItems(acct && acct.bars, acct && acct.spend);
    $('q-empty').hidden = items.length > 0;

    const keep = new Set();
    items.forEach((b, idx) => {
      const key = 'q_' + (b.kind || idx);
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
        box.insertBefore(e, $('k_out'));
      }
      const sev = (b.severity || 'normal').toLowerCase();
      setClass(e, 'q ' + sev);
      if (e.style.order !== String(idx)) e.style.order = idx;

      setText(e.querySelector('.qnum b'), String(Math.round(b.percent)));
      setText(e.querySelector('.qlbl'), tileLabel(b));
      setText(e.querySelector('.qfoot'), b.foot || (b.resets_at ? '↻ ' + until(b.resets_at) : ''));
      const fil = e.querySelector('.qfil i');
      const w = Math.min(Math.max(b.percent || 0, 0), 100) + '%';
      if (fil.style.width !== w) fil.style.width = w;
    });

    // os tiles fixos de consumo (k_*) e o aviso de cota ausente ficam
    [].slice.call(box.children).forEach((c) => {
      if (c.id.charAt(0) === 'q' && c.id !== 'q-empty' && !keep.has(c.id)) c.remove();
    });
  }

  // ── hoje ──────────────────────────────────────────────────────────────
  function renderDay(d) {
    const day = d.day;
    const now = new Date();
    setText($('d-date'), DIAS[now.getDay()] + ' ' + dmy(d.date));

    const [val, unit] = splitUnit(day.output);
    setText($('d-out'), val);
    setText($('d-unit'), unit);
    setText($('d-turns'), brl(day.turns) + ' turnos');

    const comp = day.comp || { i: 0, o: 0, cw: 0, cr: 0, total: 0 };
    const [mv, mu] = splitUnit(comp.total);
    setText($('d-mov'), mv);
    setText($('d-movu'), mu);
    setText($('d-cost'), brl(day.cost));

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
    g.appendChild(el('stop', { offset: '0%', 'stop-color': '#3ddc97', 'stop-opacity': '.38' }));
    g.appendChild(el('stop', { offset: '100%', 'stop-color': '#3ddc97', 'stop-opacity': '0' }));
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
  function renderHistory(h) {
    if (!h || !h.ready) {
      setText($('h-title'), 'HISTÓRICO');
      setText($('h-sum'), 'varrendo os transcripts…');
      return;
    }
    setText($('h-title'), h.window + ' DIAS');
    const T = h.totals;
    setText(
      $('h-sum'),
      'US$ ' + brl(T.cost) + ' · ' + short(T.total) + ' · ' + brl(T.turns) + ' turnos',
    );

    const days = h.days || [];
    const sig = days.map((d) => d.d + ':' + d.total).join('|');
    if (sig !== histSig) {
      histSig = sig;
      dayChart($('h-chart'), days);
      const S = $('h-scale');
      if (days.length) {
        const mid = days[Math.floor(days.length / 2)];
        const marks = [dmy(days[0].d), dmy(mid.d), 'hoje'];
        if (S.children.length !== 3) S.innerHTML = '<span></span><span></span><span></span>';
        marks.forEach((m, i) => setText(S.children[i], m));
      }
    }

    renderRank($('h-projects'), h.projects);
    renderRank($('h-models'), h.models);
  }

  /* Barras com topo arredondado, gridline e a média do período tracejada. */
  function dayChart(box, days) {
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
          ' de saída · ≈US$ ' +
          brl(d.cost) +
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

  function renderRank(box, rows) {
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
      const ti = r.n + ' — ' + brl(r.total) + ' tokens · ≈US$ ' + brl(r.cost);
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

    const capTxt = CTX_MAX === 1e6 ? '1mi' : short(CTX_MAX);
    const keep = new Set();

    sessions.forEach((s, idx) => {
      const key = 'c' + s.pid;
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

      setText(e.querySelector('.ptxt'), (s.product || s.name || '?').toUpperCase());
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
        'pid ' +
          s.pid +
          ' · ' +
          (s.model || '?') +
          ' · desde ' +
          (s.started || '—') +
          (s.subagents ? ' · +' + s.subagents + ' sub' : ''),
      );

      const p = Math.min((s.context / CTX_MAX) * 100, 100);
      const lvl = p >= 90 ? 'crit' : p >= 70 ? 'warn' : '';
      const bar = e.querySelector('.bar i');
      const w = p.toFixed(1) + '%';
      if (bar.style.width !== w) bar.style.width = w;
      setClass(bar, lvl);
      setText(e.querySelector('.cnum'), short(s.context) + ' / ' + capTxt);

      setText(
        e.querySelector('.stat'),
        s.turns
          ? short(s.output) + ' saída · ' + s.turns + ' turnos · ≈$' + money(s.cost)
          : 'aguardando o primeiro turno',
      );
    });

    [].slice.call(box.children).forEach((c) => {
      if (!keep.has(c.id)) c.remove();
    });
  }

  // ── entrada ───────────────────────────────────────────────────────────
  function render(d) {
    if (!d) return;
    if (typeof d.ctx_max === 'number' && d.ctx_max > 0) CTX_MAX = d.ctx_max;

    if (d.error) {
      setLevel(0);
      $('alert').innerHTML = '<div class="err">' + escapeHtml(d.error) + '</div>';
      return;
    }
    if ($('alert').innerHTML !== '') $('alert').innerHTML = '';

    setLevel(levelOf(d.sessions));
    setText($('clock'), d.now);
    const acct = d.account || {};
    setText($('sess-acct'), acct.email || (acct.account || acct.tier || '').toUpperCase());
    renderFresh(acct);
    renderQuotas(acct);
    renderDay(d);
    renderHistory(d.history);
    renderTelemetry(d.telemetry, d);
    renderSessions(d);
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
      vscode.setState(msg.payload);
      render(msg.payload);
    }
  });

  const prev = vscode.getState();
  if (prev) render(prev);
  vscode.postMessage({ type: 'ready' });
})();
