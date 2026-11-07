// Mapa de agentes: worktree → sessões → subagentes. Recebe o snapshot da extensão por postMessage.
// Só refaz o layout quando muda a estrutura (quem existe e onde); no resto, troca texto e estado no lugar.
(() => {
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: m => console.log('[mc]', m) };
  const $ = id => document.getElementById(id);
  const world = $('world'), lines = $('lines'), topSvg = $('top'), canvas = $('canvas');
  const NS = 'http://www.w3.org/2000/svg';
  // H: a altura do cartão de sessão do monitor (cabeça, título, linha mono e barra de contexto)
  // PP/PH: o respiro e o cabeçalho do .panel do monitor, onde cada repositório mora
  const LW = 640, GX = 10, GY = 10, HEAD = 44, H = 96, ROW = 106, SX = 38, SW = 300, BX = SX + SW + 34, BW = 260, PP = 14, PH = 37;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let snap = null, structure = '', sel = null, head = { ident: '', ctxMax: 1e6, fresh: null }, headAt = Date.now();
  const nodes = new Map(), lanes = new Map(), prevSub = new Map(), seenMsg = new Set();

  /* ---------------------------------- formatos ---------------------------------- */
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ago = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d`; };
  const tok = n => n == null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
  // os do monitor (dashboard.js), para o mesmo número sair igual nas duas áreas
  const short = n => { n = n || 0; return n >= 1e9 ? (n / 1e9).toFixed(1) + 'bi' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'mi' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(Math.round(n)); };
  const idle = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 10 ? 'agora' : s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'min' : Math.floor(s / 3600) + 'h' + String(Math.floor((s % 3600) / 60)).padStart(2, '0'); };
  const DIAS = ['DOMINGO', 'SEGUNDA-FEIRA', 'TERÇA-FEIRA', 'QUARTA-FEIRA', 'QUINTA-FEIRA', 'SEXTA-FEIRA', 'SÁBADO'];
  const model = id => {
    if (!id) return '';
    const parts = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-'), f = parts.findIndex(p => /^[a-z]+$/i.test(p));
    if (f < 0) return id;
    const nums = parts.filter((p, k) => k !== f && /^\d+$/.test(p));
    return parts[f][0].toUpperCase() + parts[f].slice(1) + (nums.length ? ' ' + nums.join('.') : '');
  };
  const CLASS = { Explore: 'Batedor', Plan: 'Estrategista', 'general-purpose': 'Executor', 'code-review': 'Revisor' };
  const GLYPH = {
    Explore: '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.2 9.4 8 8 11.8 6.6 8Z"/>',
    'general-purpose': '<path d="M9 2.2 4.4 8.8h3.4l-.8 5 4.6-6.6H8.2Z"/>',
    Plan: '<path d="M2.8 11.5c2.6 0 2.4-7 5.2-7s2.6 7 5.2 7"/><circle cx="2.8" cy="11.5" r="1"/><circle cx="13.2" cy="11.5" r="1"/>',
    'code-review': '<path d="M1.8 8S4 4.2 8 4.2 14.2 8 14.2 8 12 11.8 8 11.8 1.8 8 1.8 8Z"/><circle cx="8" cy="8" r="1.8"/>',
  };
  const GLYPH_ANY = '<rect x="3" y="3" width="10" height="10" rx="2.5"/><path d="M6 8h4"/>';
  const REASON = { 'input needed': 'pede uma resposta sua', 'dialog open': 'tem um diálogo aberto', 'sandbox request': 'pede acesso fora do sandbox', 'worker request': 'um worker pede aprovação', 'goal proposal': 'propõe um objetivo' };
  const reason = w => (w ? REASON[w] ?? `aguardando: ${w}` : 'aguardando você');
  const SES = { working: ['live', 'trabalhando'], waiting: ['wait', 'aguardando'], idle: ['stop', 'parada'] };
  const SES_TAG = { working: 'TRABALHANDO', waiting: 'AGUARDANDO VOCÊ', idle: 'PARADA' };
  const SUB = { working: ['live', 'trabalhando'], done: ['done', 'concluído'], failed: ['fail', 'falhou'] };
  // ícones de ação (16×16, traço), no padrão dos ícones do VS Code
  const ICO = {
    chat: '<path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/>',
    spark: '<path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/><path d="M8 5.2v3.6M6.2 7h3.6"/>',
    folder: '<path d="M1.8 4.2h4.3l1.3 1.5h6.8v6.8H1.8z"/>',
    terminal: '<rect x="1.8" y="3" width="12.4" height="10" rx="1.6"/><path d="m4.6 6.6 2 1.6-2 1.6M8.3 10h3"/>',
    reveal: '<path d="M9.3 2.5h4.2v4.2M13.5 2.5 8 8M11.5 9.5v4H2.5v-9h4"/>',
    copy: '<rect x="5.3" y="5.3" width="8.2" height="8.2" rx="1.4"/><path d="M10.7 5.3V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v6.2a1 1 0 0 0 1 1h1.8"/>',
    trash: '<path d="M2.8 4.3h10.4M6.3 4.3V2.8h3.4v1.5M4.3 4.3l.7 9h6l.7-9"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    more: '<circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/>',
    close: '<path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/>',
    send: '<path d="M2.5 7.6 13.5 2.8 9.6 13.4 7.6 8.6z"/><path d="m7.6 8.6 5.9-5.8"/>',
  };
  const icon = k => `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">${ICO[k]}</svg>`;
  /** Ação principal em destaque + menu com o resto; destrutiva no fim, bloqueada com o motivo. */
  function actions(list) {
    const [main, ...rest] = list.filter(Boolean);
    const row = a => a === '-' ? '<div class="sep"></div>' :
      `<button class="mi${a.danger ? ' danger' : ''}" ${a.disabled ? 'disabled' : `data-do="${a.do}"`}>${icon(a.icon)}<span>${esc(a.label)}</span>${a.hint ? `<small>${esc(a.hint)}</small>` : ''}</button>`;
    return (main ? `<button class="btn primary wide" data-do="${main.do}">${icon(main.icon)}${esc(main.label)}</button>` : '') +
      (rest.length ? `<div class="menu">${rest.map(row).join('')}</div>` : '');
  }
  const BRANCH_ICON = '<svg viewBox="0 0 16 16"><circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="5.5" r="1.6"/><path d="M4 5.1v5.8M12 7.1c0 3-5 2.4-8 4"/></svg>';
  const BELL = '<svg viewBox="0 0 12 12"><path d="M3 8.5V5.5a3 3 0 0 1 6 0v3l1 1H2Z"/><path d="M5 11h2"/></svg>';

  /* ---------------------------------- layout ---------------------------------- */
  const live = w => w.sessions.length > 0;
  // vira caixa quem tem sessão e quem a pessoa abriu (a extensão marca `open`; fecha no × ou quando a sessão acaba)
  const boxed = w => live(w) || !!w.open;
  function structureKey(s, width) {
    return width + '|' + s.worktrees.map(w => w.path + (w.open ? '+' : '') + ':' + (w.sessions.length
      ? w.sessions.map(x => x.id + '[' + x.subagents.map(a => a.id).join(',') + ']').join(';')
      : [w.branch, w.lastCommitAt, w.dirty, w.merged, w.ahead, w.behind, w.upstreamGone, w.removal?.ok].join(','))).join('|');
  }

  // checkout principal ("área padrão" do repositório) x worktree: o rótulo e o ícone dizem qual é qual
  const HOME_ICON = '<svg viewBox="0 0 16 16"><path d="M2.5 7.4 8 2.8l5.5 4.6M4 6.3v6.9h8V6.3"/><path d="M6.6 13.2V9.6h2.8v3.6"/></svg>';
  const kindChip = w => w.isMain ? '<span class="kind main">Principal</span>' : '<span class="kind">worktree</span>';
  const title = w => w.isMain ? (w.branch || '(sem branch)') : (w.folder || w.branch || '(worktree)');
  const subtitle = w => w.isMain ? 'checkout principal' : (w.branch || 'sem branch');

  function lane(w, x0, top, lw) {
    const rows = Math.max(1, w.sessions.reduce((a, s) => a + Math.max(1, s.subagents.length), 0)), h = HEAD + rows * ROW - (ROW - H) + 14;
    const el = document.createElement('div');
    el.className = 'lane' + (w.isMain ? ' main' : ''); Object.assign(el.style, { left: x0 + 'px', top: top + 'px', width: lw + 'px', height: h + 'px' });
    const close = !live(w) ? `<button class="ib x" title="Fechar a caixa" aria-label="Fechar a caixa de ${esc(title(w))}">${icon('close')}</button>` : '';
    el.innerHTML = `<div class="lh">${w.isMain ? HOME_ICON : BRANCH_ICON}${kindChip(w)}<b>${esc(title(w))}</b><span class="p">${esc(subtitle(w))}</span><span class="g"></span><button class="ib more" title="Ações" aria-label="Ações do ${w.isMain ? 'checkout principal' : 'worktree'}">${icon('more')}</button>${close}</div>`;
    el.querySelector('.more').onclick = e => { e.stopPropagation(); wtPop(w.path, el.querySelector('.more')); };
    el.querySelector('.x')?.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'wtClose', path: w.path }); });
    // aberta e ainda sem sessão: o lugar da sessão oferece começar uma ou voltar a uma anterior
    if (!live(w)) {
      el.insertAdjacentHTML('beforeend', `<div class="lane-empty"><span>Nenhuma sessão aberta aqui</span>
        <button class="btn primary" data-do="wtClaude">${icon('spark')}Nova sessão</button><button class="btn" data-do="hist">${icon('chat')}Sessões anteriores</button></div>`);
      Object.assign(el.querySelector('.lane-empty').style, { left: SX + 'px', top: HEAD + 'px', height: H + 'px' }); // a CSP não deixa style inline
      el.querySelector('[data-do="wtClaude"]').onclick = e => { e.stopPropagation(); vscode.postMessage({ type: 'wtClaude', path: w.path }); };
      el.querySelector('[data-do="hist"]').onclick = e => { e.stopPropagation(); wtPop(w.path, e.currentTarget, true); };
    }
    world.appendChild(el); lanes.set(w.path, { el, x: x0, y: top, w });
    let r = 0;
    for (const s of w.sessions) {
      const n = Math.max(1, s.subagents.length);
      put(s.id, { x: x0 + SX, y: top + HEAD + r * ROW + ((n - 1) * ROW) / 2, w: SW, kind: 'ses', d: s, tree: w });
      s.subagents.forEach((a, i) => put(a.id, { x: x0 + BX, y: top + HEAD + (r + i) * ROW, w: BW, kind: 'sub', d: a, parent: s.id, tree: w }));
      r += n;
    }
    return h;
  }

  function idleCard(w) {
    return `<button class="wtc${w.isMain ? ' main' : ''}" data-path="${esc(w.path)}">
      <span class="n">${w.isMain ? HOME_ICON : ''}${kindChip(w)}<span class="tt">${esc(title(w))}</span></span><span class="b">${esc(subtitle(w))}</span>
      <span class="lc">${w.lastCommitAt ? `há ${ago(Date.now() - w.lastCommitAt)} · ${esc(w.lastCommitSubject || '')}` : ''}</span>
      <span class="bd">${badges(w)}</span>
      <span class="tools"><span class="ib" role="button" data-quick="wtClaude" title="Nova sessão aqui">${icon('spark')}</span><span class="ib" role="button" data-quick="wtOpen" title="Mostrar no Explorer">${icon('folder')}</span><span class="ib" role="button" data-quick="more" title="Mais ações">${icon('more')}</span></span></button>`;
  }

  function layout() {
    world.querySelectorAll('.node, .lane, .pop, .idle-wt, .empty-all, .proj').forEach(e => e.remove());
    nodes.clear(); lanes.clear();
    const { cols, width, inner } = geom();
    let y = 0;
    if (!snap.worktrees.some(live)) {
      world.insertAdjacentHTML('beforeend', '<div class="empty empty-all">Nenhuma sessão do Claude Code aberta agora. Quando uma sessão abrir, ela aparece aqui no worktree dela.</div>');
      y = world.querySelector('.empty-all').offsetHeight + GY;
    }
    // um painel por repositório, como os do monitor: cabeçalho, o principal, os worktrees com sessão, os parados
    const projects = new Map();
    for (const w of snap.worktrees) { const k = w.repoPath || w.path; (projects.get(k) ?? projects.set(k, []).get(k)).push(w); }
    for (const [repo, trees] of projects) {
      const main = trees.find(w => w.isMain), wts = trees.filter(w => !w.isMain);
      const top = y, panel = document.createElement('section'); panel.className = 'panel proj';
      Object.assign(panel.style, { top: top + 'px', width: width + 'px' });
      panel.innerHTML = `<h2><span>${esc(String(trees[0].project || '').toUpperCase())}</span><span class="who pp">${esc(repo)}</span>` +
        `<span class="who pc">${main ? '1 principal · ' : ''}${wts.length} worktree${wts.length === 1 ? '' : 's'}</span>` +
        `<button type="button" class="ov-open nw" title="Criar um worktree neste repositório">${icon('plus')}NOVO WORKTREE</button></h2>`;
      panel.querySelector('.nw').onclick = e => { e.stopPropagation(); vscode.postMessage({ type: 'wtNew', repo: main ? main.path : repo }); };
      world.appendChild(panel); y += PH;
      const busy = [main, ...wts].filter(w => w && boxed(w)), idleWts = [main, ...wts].filter(w => w && !boxed(w));
      // as caixas fecham a linha do painel: uma só ocupa a largura toda, como os painéis do monitor
      const c = Math.max(1, Math.min(cols, busy.length)), laneW = Math.floor((inner - GX * (c - 1)) / c);
      const colY = Array(c).fill(y);
      for (const w of busy) { const ci = colY.indexOf(Math.min(...colY)); colY[ci] += lane(w, PP + ci * (laneW + GX), colY[ci], laneW) + GY; }
      y = busy.length ? Math.max(...colY) : y;
      if (idleWts.length) {
        const strip = document.createElement('div'); strip.className = 'idle-wt';
        Object.assign(strip.style, { left: PP + 'px', top: y + 'px', width: inner + 'px' });
        strip.innerHTML = `<div class="tsub">SEM SESSÃO · ${idleWts.length}</div><div class="grid">${idleWts.map(idleCard).join('')}</div>`;
        strip.querySelectorAll('.wtc').forEach(b => b.onclick = e => {
          e.stopPropagation();
          const q = e.target.closest('[data-quick]')?.dataset.quick;
          // o cartão abre a caixa do worktree; o "mais" abre o menu ali mesmo
          if (q === 'more') wtPop(b.dataset.path, b); else vscode.postMessage({ type: q || 'wtShow', path: b.dataset.path });
        });
        world.appendChild(strip); y += strip.offsetHeight + GY;
      }
      y += PP - GY;
      panel.style.height = (y - top) + 'px';
      y += GY;
    }
    const bottom = Math.max(0, y - GY);
    world.style.width = width + 'px'; world.style.height = bottom + 'px';
    for (const svg of [lines, topSvg]) { svg.setAttribute('width', width); svg.setAttribute('height', bottom); }
    drawLines();
    refresh();
    if (sel && nodes.has(sel)) select(sel, true); else sel = null;
  }

  function put(id, n) {
    const el = document.createElement('div');
    el.tabIndex = 0; el.setAttribute('role', 'button'); el.dataset.id = id;
    Object.assign(el.style, { left: n.x + 'px', top: n.y + 'px', width: n.w + 'px', height: H + 'px' });
    // a anatomia do cartão de sessão do monitor (.s): trilho, cabeça mono com o tempo à direita, título, linha mono
    el.innerHTML = n.kind === 'sub'
      ? `<div class="rail"></div><div class="body"><div class="shead"><span class="prod"><svg class="gl" viewBox="0 0 16 16" aria-hidden="true">${GLYPH[n.d.type] || GLYPH_ANY}</svg><span class="ptxt"></span></span><span class="idle"></span></div>` +
        `<div class="title"></div><div class="meta"></div><div class="stat"></div></div>`
      : `<div class="rail"></div><div class="body"><div class="shead"><span class="prod"><span class="ptxt"></span></span><span class="idle"></span></div>` +
        `<div class="title"></div><div class="meta"></div><div class="ctx"><div class="bar"><i></i></div><span class="cnum"></span></div></div>
         <div class="tools">${n.d.entrypoint === 'claude-vscode' ? `<button class="ib" data-quick="openSession" title="Abrir sessão">${icon('chat')}</button>` : ''}<button class="ib" data-quick="terminal" title="Terminal na pasta da sessão">${icon('terminal')}</button></div>`;
    el.querySelectorAll('[data-quick]').forEach(b => b.onclick = e => { e.stopPropagation(); vscode.postMessage({ type: b.dataset.quick, sessionId: id }); });
    el.onclick = e => { e.stopPropagation(); select(sel === id ? null : id); };
    el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(sel === id ? null : id); } };
    world.appendChild(el); n.el = el; nodes.set(id, n);
  }

  function elbow(x1, y1, x2, y2, spine) {
    const r = Math.min(8, Math.abs(y2 - y1) / 2), s = Math.sign(y2 - y1);
    if (spine) return `M${x1},${y1} V${y2 - r} Q${x1},${y2} ${x1 + r},${y2} H${x2}`;
    if (!s) return `M${x1},${y1} H${x2}`;
    const xm = x1 + (x2 - x1) / 2;
    return `M${x1},${y1} H${xm - r} Q${xm},${y1} ${xm},${y1 + s * r} V${y2 - s * r} Q${xm},${y2} ${xm + r},${y2} H${x2}`;
  }
  function drawLines() {
    lines.innerHTML = '';
    for (const [id, n] of nodes) {
      const p = document.createElementNS(NS, 'path');
      if (n.kind === 'ses') { const L = lanes.get(n.tree.path); p.setAttribute('d', elbow(L.x + 23, L.y + 34, n.x, n.y + H / 2, true)); }
      else { const o = nodes.get(n.parent); p.setAttribute('d', elbow(o.x + o.w, o.y + H / 2, n.x, n.y + H / 2)); }
      p.dataset.key = id; lines.appendChild(p); n.line = p;
    }
  }

  /* ---------------------------------- conteúdo ---------------------------------- */
  function refresh() {
    const now = Date.now();
    for (const [, L] of lanes) {
      const w = L.w, on = w.sessions.some(s => s.state === 'working' || s.subagents.some(a => a.state === 'working'));
      L.el.classList.toggle('on', on);
      const chips = [w.ahead ? `↑${w.ahead}` : '', w.behind ? `↓${w.behind}` : '', w.dirty ? `${w.dirty} sujo${w.dirty > 1 ? 's' : ''}` : 'limpo'].filter(Boolean);
      L.el.querySelector('.g').innerHTML = chips.map(c => `<span>${esc(c)}</span>`).join('');
    }
    const mails = new Map();
    for (const m of snap.messages) {
      const a = nodes.get(m.from), b = nodes.get(m.to); if (!a || !b) continue;
      (mails.get(m.from) ?? mails.set(m.from, new Set()).get(m.from)).add('→ ' + b.d.name);
      (mails.get(m.to) ?? mails.set(m.to, new Set()).get(m.to)).add('← ' + a.d.name);
    }
    for (const [id, n] of nodes) {
      const d = n.d, el = n.el;
      // seleção, esmaecimento e o piscar são do detalhe: sobrevivem à troca de estado
      const keep = ['sel', 'dim', 'blink'].filter(k => el.classList.contains(k)).map(k => ' ' + k).join('');
      if (n.kind === 'ses') {
        const [cls] = SES[d.state];
        el.className = `s node ${cls}${cls === 'live' ? ' hot' : ''}` + keep;
        setText(el.querySelector('.ptxt'), SES_TAG[d.state] + (d.model ? ' · ' + model(d.model).toUpperCase() : ''));
        el.querySelector('.idle').innerHTML = `${cls === 'live' ? '▶ ' : ''}<span class="tm tn" data-since="${d.since}" data-fmt="idle">${idle(now - d.since)}</span>`;
        setText(el.querySelector('.title'), d.name);
        setText(el.querySelector('.meta'), d.state === 'waiting' ? reason(d.waitingFor) : d.state === 'idle' ? (d.activity ? `última: ${d.activity}` : 'sem atividade') : d.activity || 'pensando…');
        // contexto: a mesma barra e a mesma janela (arcAiMonitor.contextWindow) do monitor
        const cap = head.ctxMax || 1e6, used = d.contextTokens || 0, p = Math.min((used / cap) * 100, 100);
        const bar = el.querySelector('.bar i'), w = p.toFixed(1) + '%';
        if (bar.style.width !== w) bar.style.width = w;
        bar.className = p >= 90 ? 'crit' : p >= 70 ? 'warn' : '';
        setText(el.querySelector('.cnum'), used ? `${short(used)} / ${cap === 1e6 ? '1mi' : short(cap)}` : '—');
        const prod = el.querySelector('.prod'); prod.querySelectorAll('.mail').forEach(x => x.remove());
        for (const m of mails.get(id) ?? []) prod.insertAdjacentHTML('beforeend', `<span class="mail" title="mensagem entre sessões">${esc(m)}</span>`);
        n.line.setAttribute('class', 'ln ' + (cls === 'stop' ? '' : cls));
      } else {
        const [cls, label] = SUB[d.state];
        el.className = `s node sub ${cls}${cls === 'live' ? ' hot' : ''}` + keep;
        setText(el.querySelector('.ptxt'), String(CLASS[d.type] || d.type).toUpperCase());
        el.querySelector('.idle').innerHTML = d.state === 'working'
          ? `▶ <span class="tm tn" data-since="${d.startedAt ?? now}" data-fmt="idle">${idle(now - (d.startedAt ?? now))}</span>`
          : d.startedAt && d.endedAt ? `levou ${idle(d.endedAt - d.startedAt)}` : label;
        setText(el.querySelector('.title'), d.description);
        setText(el.querySelector('.meta'), d.activity || (d.state === 'working' ? 'começando…' : '—'));
        setText(el.querySelector('.stat'), `${label} · ${d.type}`);
        n.line.setAttribute('class', 'ln ' + (cls === 'done' ? '' : cls));
        // terminou desde a última leitura: o resultado corre a linha de volta até a sessão
        const before = prevSub.get(id);
        if (before === 'working' && d.state !== 'working') { travel(n.line, true, 'pk'); nodes.get(n.parent)?.el.classList.add('blink'); }
        prevSub.set(id, d.state);
      }
    }
    for (const m of snap.messages) { const k = m.from + m.to + m.at; if (!seenMsg.has(k)) { seenMsg.add(k); if (Date.now() - m.at < 15_000) flashMsg(m); } }
    summary();
    if (sel && nodes.has(sel)) fillPop(sel);
  }
  function setText(el, text) { if (el.textContent !== text) el.textContent = text; }

  // a faixa de KPI do monitor (.kpis/.k), com os números do mapa
  function summary() {
    const ses = snap.worktrees.flatMap(w => w.sessions), subs = ses.flatMap(s => s.subagents);
    const count = st => ses.filter(s => s.state === st).length;
    const working = count('working'), waiting = count('waiting'), stopped = count('idle');
    const subLive = subs.filter(a => a.state === 'working').length, subDone = subs.filter(a => a.state === 'done').length, failed = subs.filter(a => a.state === 'failed').length;
    const wts = snap.worktrees.filter(w => !w.isMain), wtBusy = wts.filter(live).length;
    const tile = (n, label, foot, cls = '') => `<div class="k${cls ? ' ' + cls : ''}"><div class="knum"><b class="tn">${n}</b></div><div class="klbl">${label}</div><div class="kfoot">${esc(foot)}</div></div>`;
    const html =
      tile(working, 'TRABALHANDO', 'sessões gerando agora') +
      tile(waiting, 'AGUARDANDO VOCÊ', waiting ? 'resposta ou aprovação na sessão' : 'nenhuma parada em você', waiting ? 'warning' : '') +
      tile(stopped, stopped === 1 ? 'PARADA' : 'PARADAS', 'abertas, sem trabalhar') +
      tile(subLive, 'SUBAGENTES ATIVOS', [subDone && `${subDone} concluído${subDone === 1 ? '' : 's'}`, failed && `${failed} com falha`].filter(Boolean).join(' · ') || 'nenhum concluído agora', failed ? 'critical' : '') +
      tile(wts.length, wts.length === 1 ? 'WORKTREE' : 'WORKTREES', `${wtBusy} com sessão · ${wts.length - wtBusy} sem`);
    const box = $('akpis'); if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
    reactor(working || subLive ? 1 : 0);
  }
  // o frescor da cota, com a regra do monitor (freshState no dashboard.js)
  const dur = s => s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'min' : Math.floor(s / 3600) + 'h';
  function fresh() {
    const f = head.fresh, el = $('fresh-claude');
    const age = f && f.ageS != null ? f.ageS + Math.floor((Date.now() - headAt) / 1000) : null, on = f && f.source === 'live';
    let txt = '', cls = 'fresh';
    if (age == null) { if (on) { txt = 'CLAUDE ● ao vivo'; cls = 'fresh live'; } }
    else if (on) { txt = 'CLAUDE ● ' + (age < 30 ? 'agora' : dur(age)); cls = age < 300 ? 'fresh live' : 'fresh old'; }
    else { txt = 'CLAUDE ○ ' + dur(age); cls = age > 600 ? 'fresh old' : 'fresh'; }
    setText(el, txt); if (el.className !== cls) el.className = cls; el.hidden = !txt;
  }
  // o topo do monitor: conta · dia · hora
  function topmeta() {
    fresh();
    const d = new Date(), p2 = v => String(v).padStart(2, '0');
    setText($('clock'), `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`);
    setText($('d-date'), `${DIAS[d.getDay()]} ${p2(d.getDate())}/${p2(d.getMonth() + 1)}`);
    setText($('acct'), head.ident);
    $('acct').hidden = $('acct-sep').hidden = !head.ident;
  }
  // o reator do topo, com a mesma conta do monitor: gira e respira mais rápido quando alguém trabalha
  let level = -1;
  function reactor(l) {
    const core = $('core'); if (!core || l === level) return;
    level = l;
    core.style.setProperty('--spin', (10 / ((0.012 + 0.055 * l) * 6 * (1000 / 70))).toFixed(2) + 's');
    core.style.setProperty('--breath', ((2 * Math.PI) / (0.09 + 0.09 * l) / (1000 / 70)).toFixed(2) + 's');
    core.style.setProperty('--glow', (0.28 + 0.45 * l).toFixed(2));
  }

  /* ---------------------------------- comunicação ---------------------------------- */
  function travel(path, reverse, cls, layer = lines) {
    if (!path || reduce) return;
    const len = path.getTotalLength(), c = document.createElementNS(NS, 'circle'); c.setAttribute('r', 3); c.setAttribute('class', cls); layer.appendChild(c);
    const t0 = performance.now();
    const step = t => { const f = Math.min((t - t0) / 900, 1), p = path.getPointAtLength(len * (reverse ? 1 - f : f)); c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('opacity', Math.sin(Math.PI * f)); if (f < 1) requestAnimationFrame(step); else c.remove(); };
    requestAnimationFrame(step);
  }
  function flashMsg(m) {
    const a = nodes.get(m.from), b = nodes.get(m.to); if (!a || !b) return;
    const x1 = a.x, y1 = a.y + H / 2, x2 = b.x + b.w / 2, y2 = b.y, p = document.createElementNS(NS, 'path');
    p.setAttribute('d', `M${x1},${y1} Q${(x1 + x2) / 2},${Math.min(y1, y2) - 60} ${x2},${y2}`); p.setAttribute('class', 'ln msg'); topSvg.appendChild(p);
    const mid = p.getPointAtLength(p.getTotalLength() / 2), lab = document.createElement('div');
    lab.className = 'mlab'; Object.assign(lab.style, { left: mid.x + 'px', top: mid.y + 'px' });
    lab.textContent = `${a.d.name} → ${b.d.name}${m.text ? ': “' + m.text + '”' : ''}`; world.appendChild(lab);
    travel(p, false, 'pk msg', topSvg);
    const fade = [{ opacity: 0 }, { opacity: 1, offset: .1 }, { opacity: 1, offset: .8 }, { opacity: 0 }], o = { duration: 3200, easing: 'cubic-bezier(.23,1,.32,1)' };
    p.animate(fade, o); lab.animate(fade, o).onfinish = () => { p.remove(); lab.remove(); };
  }

  /* ---------------------------------- detalhe ---------------------------------- */
  function family(id) {
    const n = nodes.get(id), ses = n.kind === 'ses' ? id : n.parent, keep = new Set([id, ses]);
    nodes.get(ses).d.subagents.forEach(a => keep.add(a.id));
    snap.messages.forEach(m => { if (m.from === ses) keep.add(m.to); if (m.to === ses) keep.add(m.from); });
    return keep;
  }
  function select(id, keep) {
    world.querySelectorAll('.pop').forEach(p => p.remove());
    for (const [, n] of nodes) n.el.classList.remove('sel', 'dim');
    for (const [, L] of lanes) L.el.classList.remove('dim');
    lines.querySelectorAll('.ln').forEach(l => l.classList.remove('dim'));
    sel = id && nodes.has(id) ? id : null;
    if (!sel) return;
    const fam = family(sel), trees = new Set([...fam].map(k => nodes.get(k)?.tree.path));
    for (const [k, n] of nodes) n.el.classList.toggle('dim', !fam.has(k));
    for (const [k, L] of lanes) L.el.classList.toggle('dim', !trees.has(k));
    lines.querySelectorAll('.ln').forEach(l => l.classList.toggle('dim', !fam.has(l.dataset.key)));
    const n = nodes.get(sel); n.el.classList.add('sel');
    const p = document.createElement('div'); p.className = 'pop' + (keep ? ' on' : '') + (n.kind === 'ses' ? ' wide' : '');
    // as larguras do .pop e do .pop.wide no map.css; com menos, o detalhe da sessão vaza da borda direita
    const pw = n.kind === 'ses' ? 440 : 330;
    Object.assign(p.style, { left: Math.max(0, Math.min(n.x, parseFloat(world.style.width) - pw)) + 'px', top: n.y + H + 8 + 'px' });
    p.onclick = e => e.stopPropagation();
    // o topo acompanha o mapa; a conversa embaixo não é reescrita (não perde o que está sendo digitado)
    p.innerHTML = '<div class="pbody"></div>' + (n.kind === 'ses' ? chatBlock(n.d) : '');
    world.appendChild(p); fillPop(sel);
    if (n.kind === 'ses') startChat(p, n.d);
    place(p, n.el);
    if (!keep) requestAnimationFrame(() => p.classList.add('on'));
  }

  /* ---------------------------------- mini chat ---------------------------------- */
  let chatTimer;
  function chatBlock(d) {
    return `<div class="chat"><p class="h">Conversa</p><div class="cl"><span class="none">carregando a conversa…</span></div>
      <form class="cmp"><textarea rows="2" placeholder="Mensagem para ${esc(d.name)}…" aria-label="Mensagem para a sessão"></textarea>
      <button class="btn primary send" type="submit" title="Enviar (Enter)" aria-label="Enviar">${icon('send')}</button></form>
      <small class="note">Chega na sessão como mensagem de outro agente, não como digitada por você. Aprovar permissão, só na sessão.</small></div>`;
  }
  function startChat(p, d) {
    clearInterval(chatTimer);
    const form = p.querySelector('.cmp'), box = form.querySelector('textarea'), send = form.querySelector('.send');
    const load = () => vscode.postMessage({ type: 'chatLoad', sessionId: d.id });
    form.onsubmit = e => {
      e.preventDefault();
      const text = box.value.trim(); if (!text) return;
      send.disabled = box.disabled = true;
      vscode.postMessage({ type: 'chatSend', sessionId: d.id, text });
    };
    box.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } };
    load(); chatTimer = setInterval(() => { if (world.contains(p)) load(); else clearInterval(chatTimer); }, 3000);
  }
  function showChat(id, items) {
    const p = world.querySelector('.pop'); if (!p || sel !== id) return;
    const cl = p.querySelector('.cl'); if (!cl) return;
    const atEnd = cl.scrollTop + cl.clientHeight >= cl.scrollHeight - 8, now = Date.now();
    const html = items.length ? items.map(m => `<div class="cm ${m.role}${m.peer ? ' peer' : ''}"><div class="bb">${esc(m.text.length > 900 ? m.text.slice(0, 900) + '…' : m.text)}</div>
      <small>${m.role === 'user' ? (m.peer ? 'mensagem de agente' : 'você') : 'Claude'} · há ${ago(now - m.at)}</small></div>`).join('') : '<span class="none">conversa vazia</span>';
    if (cl.dataset.html === html) return;
    cl.dataset.html = html; cl.innerHTML = html;
    if (atEnd || !cl.dataset.seen) { cl.scrollTop = cl.scrollHeight; cl.dataset.seen = '1'; }
  }
  function chatSent(id, ok, error) {
    const p = world.querySelector('.pop'); if (!p || sel !== id) return;
    const box = p.querySelector('.cmp textarea'), send = p.querySelector('.cmp .send'), note = p.querySelector('.chat .note');
    box.disabled = send.disabled = false;
    if (ok) { box.value = ''; note.textContent = 'Enviada. A sessão responde quando terminar o que está fazendo.'; note.className = 'note ok'; vscode.postMessage({ type: 'chatLoad', sessionId: id }); }
    else { note.textContent = `Não enviou: ${error}`; note.className = 'note bad'; }
    box.focus();
  }

  function fillPop(id) {
    const p = world.querySelector('.pop .pbody'); if (!p) return;
    const n = nodes.get(id), d = n.d, ses = n.kind === 'ses' ? d : nodes.get(n.parent).d, now = Date.now();
    const where = `${n.tree.project} / ${n.tree.branch || n.tree.folder || ''}${n.kind === 'sub' ? ' · subagente de ' + ses.name : ''}`;
    const html = n.kind === 'ses'
      ? `${d.state === 'waiting' ? `<div class="ask"><b>${esc(reason(d.waitingFor))}</b>${d.needs ? `<br><span class="needs">${esc(d.needs)}</span>` : ''}<br>A decisão fica na própria sessão.</div>` : ''}
         <dl><dt>Estado</dt><dd>${SES[d.state][1]} há ${ago(now - d.since)}</dd><dt>Agora</dt><dd>${esc(d.activity || '—')}</dd>
         <dt>Modelo</dt><dd>${esc(model(d.model) || '—')}${d.contextTokens ? ' · ' + tok(d.contextTokens) + ' tokens no contexto' : ''}</dd>
         <dt>Subagentes</dt><dd>${d.subagents.length ? d.subagents.map(a => esc(CLASS[a.type] || a.type)).join(', ') : 'nenhum agora'}</dd>
         <dt>Pasta</dt><dd>${esc(d.cwd)}</dd></dl>
         ${actions([
           d.entrypoint === 'claude-vscode' && { do: 'openSession', label: d.state === 'waiting' ? 'Responder na sessão' : 'Abrir sessão', icon: 'chat' },
           { do: 'terminal', label: 'Terminal na pasta da sessão', icon: 'terminal' },
           { do: 'copyResume', label: 'Copiar comando de retomada', icon: 'copy' },
         ])}`
      : `<dl><dt>Estado</dt><dd>${SUB[d.state][1]}</dd><dt>Classe</dt><dd>${esc(CLASS[d.type] || d.type)} · ${esc(d.type)}</dd><dt>Agora</dt><dd>${esc(d.activity || '—')}</dd></dl>`;
    const body = `<h3>${esc(n.kind === 'ses' ? d.name : d.description)}</h3><div class="w">${esc(where)}</div>${html}`;
    if (p.dataset.html === body) return;
    p.dataset.html = body; p.innerHTML = body;
    p.querySelectorAll('[data-do]').forEach(b => b.onclick = () => vscode.postMessage({ type: b.dataset.do, sessionId: ses.id, cwd: ses.cwd, entrypoint: ses.entrypoint }));
  }

  /* ---------------------------------- worktree ---------------------------------- */
  // o diagnóstico em selos: o que decide se dá para remover sem perder nada
  function badges(w) {
    const out = [];
    if (w.merged === true) out.push(['ok', `na ${(w.base || 'padrão').replace(/^origin\//, '')}`]);
    // em dia com o próprio upstream não quer dizer na branch padrão: o selo vale pelo merge-base
    if (w.merged === false) out.push(['warn', `fora da ${(w.base || 'padrão').replace(/^origin\//, '')}`]);
    if (w.dirty) out.push(['warn', `${w.dirty} sujo${w.dirty > 1 ? 's' : ''}`]);
    if (!w.branch) out.push(['warn', 'sem branch']);
    if (w.upstreamGone) out.push(['', 'upstream apagado']);
    if (w.ahead) out.push(['', `↑${w.ahead}`]);
    if (w.behind) out.push(['', `↓${w.behind}`]);
    return out.map(([k, t]) => `<span class="${k}">${esc(t)}</span>`).join('');
  }
  // histOnly: o botão "Sessões anteriores" da caixa vazia abre só a lista, sem o menu do worktree
  function wtPop(path, anchor, histOnly = false) {
    const w = snap.worktrees.find(x => x.path === path); if (!w) return;
    select(null);
    const p = document.createElement('div'); p.className = 'pop';
    const r = anchor.getBoundingClientRect(), wr = world.getBoundingClientRect();
    Object.assign(p.style, { left: Math.max(0, Math.min(r.left - wr.left, parseFloat(world.style.width) - 330)) + 'px', top: r.bottom - wr.top + 8 + 'px' });
    const rm = w.removal || { ok: false, reason: 'sem informação do git' };
    p.innerHTML = histOnly ? `<h3>${kindChip(w)} ${esc(title(w))}</h3>` : `<h3>${kindChip(w)} ${esc(title(w))}</h3><div class="w">${esc(w.path)}</div>
      <dl><dt>Branch</dt><dd>${esc(w.branch || 'sem branch (detached)')}</dd>
      <dt>Último commit</dt><dd class="lc" title="${esc(w.lastCommitSubject || '')}">${w.lastCommitAt ? `há ${ago(Date.now() - w.lastCommitAt)} · ${esc(w.lastCommitSubject || '')}` : '—'}</dd>
      <dt>Situação</dt><dd>${badges(w) ? `<span class="bd">${badges(w)}</span>` : 'limpo'}</dd>
      <dt>Sessões</dt><dd>${w.sessions.length ? w.sessions.map(s => esc(s.name)).join(', ') : 'nenhuma aberta'}</dd></dl>
      ${actions([
        { do: 'wtClaude', label: 'Nova sessão aqui', icon: 'spark' },
        { do: 'wtOpen', label: 'Mostrar no Explorer', icon: 'folder' },
        { do: 'wtTerminal', label: 'Terminal aqui', icon: 'terminal' },
        { do: 'wtReveal', label: 'Abrir no Explorer do Windows', icon: 'reveal' },
        { do: 'wtCopy', label: 'Copiar caminho', icon: 'copy' },
        !w.isMain && '-',
        !w.isMain && (rm.ok
          ? { do: 'wtRemove', label: 'Remover worktree', icon: 'trash', danger: true, hint: rm.warning ? 'commits ficam na branch' : w.merged ? 'já está na ' + (w.base || '').replace(/^origin\//, '') : '' }
          : { label: 'Remover worktree', icon: 'trash', danger: true, disabled: true, hint: rm.reason }),
      ])}`;
    p.insertAdjacentHTML('beforeend', `<div class="hist"><p class="h">Sessões anteriores</p><div class="hl"><span class="none">procurando conversas que trabalharam aqui…</span></div></div>`);
    p.dataset.path = w.path;
    p.onclick = e => e.stopPropagation();
    p.querySelectorAll('[data-do]').forEach(b => b.onclick = () => { vscode.postMessage({ type: b.dataset.do, path: w.path }); if (b.dataset.do !== 'wtCopy') select(null); });
    world.appendChild(p); place(p, anchor); requestAnimationFrame(() => p.classList.add('on'));
    vscode.postMessage({ type: 'wtHistory', path: w.path });
  }
  function showHistory(path, items) {
    const p = world.querySelector('.pop'); if (!p || p.dataset.path !== path) return;
    const hl = p.querySelector('.hl'), now = Date.now();
    hl.innerHTML = items.length ? items.map(s => `<button class="mi past" data-id="${esc(s.id)}">${icon('chat')}<span>${esc(s.title || 'Conversa sem título')}</span><small>há ${ago(now - s.lastAt)}${s.model ? ' · ' + esc(model(s.model)) : ''}</small></button>`).join('')
      : '<span class="none">nenhuma conversa do Claude Code nesta pasta</span>';
    hl.querySelectorAll('.past').forEach(b => b.onclick = () => { vscode.postMessage({ type: 'pastResume', path, sessionId: b.dataset.id }); select(null); });
    const anchor = [...world.querySelectorAll('.wtc')].find(c => c.dataset.path === path) ?? [...lanes.values()].find(L => L.w.path === path)?.el.querySelector('.more');
    if (anchor) place(p, anchor); // o histórico mudou a altura
  }
  // abre abaixo do que foi clicado; se não couber na área visível, abre acima
  function place(p, anchor) {
    // a página rola inteira, como a do monitor: o que conta é a área visível da janela
    const r = anchor.getBoundingClientRect(), wr = world.getBoundingClientRect(), cr = { top: 0, bottom: innerHeight };
    const below = r.bottom - wr.top + 8, h = p.offsetHeight;
    const fitsBelow = r.bottom + 8 + h <= cr.bottom, fitsAbove = r.top - 8 - h >= cr.top;
    // nem embaixo nem em cima: encosta no fim da área visível (a altura máxima garante que cabe)
    const top = fitsBelow ? below : fitsAbove ? r.top - wr.top - 8 - h : Math.max(cr.top - wr.top + 8, cr.bottom - wr.top - h - 8);
    p.style.top = top + 'px';
  }
  // MONITOR | AGENTES: o monitor volta nesta mesma aba
  document.querySelectorAll('[data-area]').forEach(b => b.onclick = () => vscode.postMessage({ type: 'area', area: b.dataset.area }));

  /* ---------------------------------- vida ---------------------------------- */
  canvas.addEventListener('click', () => select(null));
  addEventListener('keydown', e => { if (e.key === 'Escape') select(null); });
  setInterval(() => { const now = Date.now(); topmeta(); world.querySelectorAll('[data-since]').forEach(x => { x.textContent = (x.dataset.fmt === 'idle' ? idle : ago)(now - +x.dataset.since); }); }, 1000);
  topmeta();
  new ResizeObserver(() => { if (snap) { const k = structureKey(snap, geom().width); if (k !== structure) { structure = k; layout(); } } }).observe(canvas);
  // o mapa ocupa a largura da moldura do monitor; dentro de cada painel cabem quantas caixas de LW couberem
  function geom() {
    const width = Math.max(LW + 2 * PP, canvas.clientWidth), inner = width - 2 * PP;
    return { width, inner, cols: Math.max(1, Math.floor((inner + GX) / (LW + GX))) };
  }

  addEventListener('message', ev => {
    const m = ev.data;
    if (m?.type === 'select') { select(m.id); nodes.get(m.id)?.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    if (m?.type === 'history') { showHistory(m.path, m.items); return; }
    if (m?.type === 'chat') { showChat(m.sessionId, m.items); return; }
    if (m?.type === 'chatSent') { chatSent(m.sessionId, m.ok, m.error); return; }
    if (!m || m.type !== 'snapshot') return;
    snap = m.data;
    if (m.head) { head = m.head; headAt = Date.now(); topmeta(); }
    const k = structureKey(snap, geom().width);
    if (k !== structure) { structure = k; layout(); } else {
      // mesma estrutura: os objetos novos entram nos nós que já estão na tela
      const byId = new Map(snap.worktrees.flatMap(w => w.sessions.flatMap(s => [[s.id, s], ...s.subagents.map(a => [a.id, a])])));
      for (const [id, n] of nodes) n.d = byId.get(id) ?? n.d;
      for (const [k2, L] of lanes) L.w = snap.worktrees.find(w => w.path === k2) ?? L.w;
      refresh();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
