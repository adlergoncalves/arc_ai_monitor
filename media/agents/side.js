// Lista lateral: um painel por worktree com sessão, e nele o cartão de sessão do monitor (.s), com estado,
// ação e uma barrinha por subagente. Clique abre o mapa na sessão.
(() => {
  const vscode = acquireVsCodeApi();
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // o formato de tempo do monitor (dashboard.js)
  const idle = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 10 ? 'agora' : s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'min' : Math.floor(s / 3600) + 'h' + String(Math.floor((s % 3600) / 60)).padStart(2, '0'); };
  const model = id => {
    if (!id) return '';
    const parts = id.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-'), f = parts.findIndex(p => /^[a-z]+$/i.test(p));
    if (f < 0) return id;
    const nums = parts.filter((p, k) => k !== f && /^\d+$/.test(p));
    return parts[f][0].toUpperCase() + parts[f].slice(1) + (nums.length ? ' ' + nums.join('.') : '');
  };
  const REASON = { 'input needed': 'pede uma resposta sua', 'dialog open': 'tem um diálogo aberto', 'sandbox request': 'pede acesso fora do sandbox', 'worker request': 'um worker pede aprovação', 'goal proposal': 'propõe um objetivo' };
  const CLS = { working: 'live hot', waiting: 'wait', idle: 'stop' };
  const TAG = { working: 'TRABALHANDO', waiting: 'AGUARDANDO VOCÊ', idle: 'PARADA' };
  const list = document.getElementById('list');
  document.getElementById('open').onclick = () => vscode.postMessage({ type: 'open' });

  addEventListener('message', ev => {
    const m = ev.data; if (!m || m.type !== 'snapshot') return;
    const now = Date.now(), trees = m.data.worktrees.filter(w => w.sessions.length);
    list.innerHTML = trees.length ? trees.map(w => `<section class="panel"><h2><span>${esc(String(w.branch || w.folder || w.project).toUpperCase())}</span><span class="who">${esc(w.project)}</span></h2><div class="list">` + w.sessions.map(s => {
      const what = s.state === 'waiting' ? (REASON[s.waitingFor] ?? (s.waitingFor ? `aguardando: ${s.waitingFor}` : 'aguardando você')) : s.state === 'idle' ? (s.activity ? `última: ${s.activity}` : 'sem atividade') : (s.activity || 'pensando…');
      return `<button class="s ${CLS[s.state]}" data-id="${esc(s.id)}"><div class="rail"></div><div class="body">` +
        `<div class="shead"><span class="prod"><span class="ptxt">${TAG[s.state]}${s.model ? ' · ' + esc(model(s.model).toUpperCase()) : ''}</span></span><span class="idle">${s.state === 'working' ? '▶ ' : ''}${idle(now - s.since)}</span></div>` +
        `<div class="title">${esc(s.name)}</div><div class="meta">${esc(what)}</div>` +
        (s.subagents.length ? `<span class="subs">${s.subagents.map(a => `<span class="${a.state}" title="${esc(a.description)}"></span>`).join('')}</span>` : '') +
        `</div></button>`;
    }).join('') + `</div></section>`).join('') : '<div class="empty">Nenhuma sessão do Claude Code aberta agora.</div>';
    list.querySelectorAll('.s').forEach(b => b.onclick = () => vscode.postMessage({ type: 'open', sessionId: b.dataset.id }));
  });
  vscode.postMessage({ type: 'ready' });
})();
