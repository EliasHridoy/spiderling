// @ts-check
// Spiderling trace replay. Renders an agent trace (.spiderling/traces/<session>.json or docs/<n>/agent-trace.json): header metrics, a
// per-agent timeline you can scrub, the agent's words at each step, and the
// files touched so far. The same file is the VS Code panel and (with the trace
// inlined as window.__TRACE__) the standalone HTML export, so it must not need
// anything from the extension beyond the optional acquireVsCodeApi.
(function () {
  const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() { /* standalone */ } };
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
  if (typeof acquireVsCodeApi === 'function') { document.documentElement.setAttribute('data-vscode', ''); }

  const TA = window.TraceAnalysis; // phases, edges, drift, flow (media/traceAnalysis.js)
  const OPS = ['read', 'write', 'search', 'call', 'bash'];
  const OP_LABEL = { read: 'read', write: 'edit', search: 'search', call: 'mcp / agent', bash: 'command' };
  const OP_RGB = { read: '120,170,230', write: '230,150,90', search: '180,130,230', call: '90,200,190', bash: '150,150,150' };
  const GAP_MS = 30 * 60 * 1000;
  const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9a6324', '#800000', '#aaffc3', '#808000'];

  // same colouring as the live views (src/palette.ts)
  function colorFor(agentKey) {
    const type = String(agentKey).split(':')[0];
    if (type === 'main') { return '#9e9e9e'; }
    let h = 0;
    for (let i = 0; i < type.length; i++) { h = (h * 31 + type.charCodeAt(i)) | 0; }
    return PALETTE[Math.abs(h) % PALETTE.length];
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  function fmtDur(ms) {
    if (!ms || ms < 1000) { return '0s'; }
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
  }
  const clock = (iso) => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }); };

  let doc = null;
  let session = null;
  let sessionId = '';
  let steps = [];      // all steps of the session
  let view = [];       // steps passing the filters
  let cur = 0;
  let agentsOff = new Set();
  let opsOff = new Set();
  let timer = 0;
  let lanes = [];
  let analysis = null;   // { phases, edges, drift } over ALL steps of the session
  let openedBy = new Map(); // step index -> the search that led to it
  let ctxOf = new Map();    // edit step index -> reads/searches behind it

  const scrub = /** @type {HTMLInputElement} */ ($('scrub'));
  const canvas = /** @type {HTMLCanvasElement} */ ($('timeline'));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));

  // ---- load ----
  function load(next, keep) {
    doc = next;
    const ids = Object.keys((doc && doc.sessions) || {});
    $('empty').classList.toggle('hidden', ids.length > 0);
    $('app').classList.toggle('hidden', ids.length === 0);
    if (!ids.length) { return; }
    const sel = /** @type {HTMLSelectElement} */ ($('session'));
    sel.innerHTML = ids.map((id) => {
      const s = doc.sessions[id];
      return `<option value="${esc(id)}">${esc(s.title || id.slice(0, 8))} · ${esc(clock(s.startedAt))}</option>`;
    }).join('');
    sel.classList.toggle('hidden', ids.length < 2);
    if (!keep || !doc.sessions[sessionId]) { sessionId = ids[ids.length - 1]; }
    sel.value = sessionId;
    const prevAt = keep && view[cur] ? view[cur].t : null;
    openSession(prevAt);
  }

  function openSession(restoreAt) {
    session = doc.sessions[sessionId];
    steps = (session.steps || []).map((s, i) => Object.assign({ i }, s));
    agentsOff = new Set(Array.from(agentsOff).filter((a) => session.agents.some((x) => x.key === a)));
    analysis = TA ? { phases: TA.phases(steps), edges: TA.edges(steps), drift: TA.drift(steps, session.agents) } : null;
    openedBy = new Map(analysis ? analysis.edges.opened.map((o) => [o.step, o]) : []);
    ctxOf = new Map(analysis ? analysis.edges.context.map((c) => [c.write, c]) : []);
    renderHeader();
    renderPhases();
    renderInsights();
    renderFilters();
    rebuild(restoreAt);
  }

  // ---- header ----
  function renderHeader() {
    const m = session.metrics || {};
    $('title').textContent = (doc.issue ? `#${doc.issue} · ` : '') + (session.title || 'Agent session');
    const bits = [];
    if (session.branch) { bits.push(`<span class="mono">${esc(session.branch)}</span>`); }
    if (session.pr && session.pr.number) {
      const url = String(session.pr.url || '');
      bits.push(/^https:\/\//.test(url) ? `<a href="${esc(url)}">PR #${esc(session.pr.number)}</a>` : `PR #${esc(session.pr.number)}`);
    }
    bits.push(`${esc(clock(session.startedAt))} → ${esc(clock(session.endedAt))}`);
    $('sub').innerHTML = bits.join(' · ');
    const tokens = m.tokens || {};
    let tin = 0, tout = 0, tcache = 0;
    for (const k of Object.keys(tokens)) { tin += tokens[k].input; tout += tokens[k].output; tcache += tokens[k].cacheRead; }
    const models = Object.keys(tokens).map((k) => k.replace('claude-', ''));
    const stat = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
    $('stats').innerHTML = [
      stat(fmtDur(m.durationMs), 'duration'),
      stat(steps.length, 'steps'),
      stat(session.agents.length, 'agents'),
      m.costUSD != null ? stat(`$${m.costUSD.toFixed(2)}`, 'cost') : '',
      m.linesAdded != null ? stat(`+${fmtNum(m.linesAdded)} / −${fmtNum(m.linesRemoved || 0)}`, 'lines') : '',
      stat(`${fmtNum(tin + tout)}`, `tokens in+out${tcache ? ` · ${fmtNum(tcache)} cached` : ''}`),
      models.length ? stat(esc(models.join(', ')), 'models') : '',
    ].join('');
  }

  // ---- filters ----
  function renderFilters() {
    const chip = (label, color, off, attr, val) =>
      `<span class="chip${off ? ' off' : ''}" ${attr}="${esc(val)}"><i style="background:${color}"></i>${esc(label)}</span>`;
    $('chips-agents').innerHTML = session.agents.map((a) =>
      chip(a.description ? `${a.type} — ${a.description}`.slice(0, 54) : a.type, colorFor(a.key), agentsOff.has(a.key), 'data-agent', a.key)).join('');
    $('chips-ops').innerHTML = OPS.map((o) =>
      chip(OP_LABEL[o], `rgb(${OP_RGB[o]})`, opsOff.has(o), 'data-op', o)).join('');
  }
  $('chips-agents').addEventListener('click', (e) => {
    const el = /** @type {HTMLElement} */ (e.target).closest('[data-agent]');
    if (!el) { return; }
    const k = el.getAttribute('data-agent');
    if (agentsOff.has(k)) { agentsOff.delete(k); } else { agentsOff.add(k); }
    renderFilters();
    rebuild(view[cur] ? view[cur].t : null);
  });
  $('chips-ops').addEventListener('click', (e) => {
    const el = /** @type {HTMLElement} */ (e.target).closest('[data-op]');
    if (!el) { return; }
    const k = el.getAttribute('data-op');
    if (opsOff.has(k)) { opsOff.delete(k); } else { opsOff.add(k); }
    renderFilters();
    rebuild(view[cur] ? view[cur].t : null);
  });

  // ---- view ----
  function rebuild(restoreAt) {
    stop();
    view = steps.filter((s) => !agentsOff.has(s.agent) && !opsOff.has(s.op));
    scrub.max = String(Math.max(0, view.length - 1));
    cur = 0;
    if (restoreAt) {
      const at = view.findIndex((s) => s.t >= restoreAt);
      cur = at < 0 ? Math.max(0, view.length - 1) : at;
    }
    renderList();
    renderAgents();
    layoutTimeline();
    seek(cur, true);
  }

  function renderList() {
    const out = [];
    let prev = null;
    view.forEach((s, i) => {
      if (prev && Date.parse(s.t) - Date.parse(prev.t) > GAP_MS) {
        out.push(`<div class="gap">⏸ ${esc(fmtDur(Date.parse(s.t) - Date.parse(prev.t)))} idle</div>`);
      }
      prev = s;
      const lines = s.lines ? `:${s.lines[0]}${s.lines[1] !== s.lines[0] ? `–${s.lines[1]}` : ''}` : '';
      const what = s.op === 'search'
        ? `<span class="f mono">${esc(s.query || '')}</span> <span class="d">${s.hits === undefined ? `in ${esc(s.file)}` : `→ ${s.hits} hit(s) in ${esc(s.file)}`}</span>`
        : (s.op === 'bash' || s.op === 'call')
          ? `<span class="d">${esc(s.detail || 'command')}</span>`
          : `<span class="f mono">${esc(s.file)}${esc(lines)}</span> <span class="d">${esc(s.detail || '')}</span>`;
      out.push(`<div class="step future" data-i="${i}"><span class="no">${s.i + 1}</span>`
        + `<span class="dot" style="background:rgb(${OP_RGB[s.op] || OP_RGB.bash})" title="${esc(OP_LABEL[s.op] || s.op)}"></span>`
        + `<span class="what">${what}${s.caption ? `<span class="c">“${esc(s.caption)}”</span>` : ''}</span></div>`);
    });
    $('steps').innerHTML = out.join('');
  }
  $('steps').addEventListener('click', (e) => {
    const el = /** @type {HTMLElement} */ (e.target).closest('[data-i]');
    if (el) { stop(); seek(Number(el.getAttribute('data-i')), false); }
  });

  function renderAgents() {
    $('agents').innerHTML = '<table class="agents-table">' + session.agents.map((a) => {
      const t = a.tokens || {};
      let tot = 0;
      for (const k of Object.keys(t)) { tot += t[k].input + t[k].output; }
      return `<tr><td><span class="agent-tag"><i style="background:${colorFor(a.key)}"></i>${esc(a.type)}</span>`
        + (a.description ? `<div class="now-detail">${esc(a.description)}</div>` : '') + '</td>'
        + `<td>${a.steps} steps<br>${tot ? `${fmtNum(tot)} tok` : ''}</td></tr>`;
    }).join('') + '</table>';
  }

  // ---- seek ----
  function seek(i, noScroll) {
    if (!view.length) {
      $('now').classList.add('hidden');
      $('files').innerHTML = '';
      $('pos').textContent = '0 / 0';
      drawTimeline();
      return;
    }
    cur = Math.max(0, Math.min(view.length - 1, i));
    scrub.value = String(cur);
    $('pos').textContent = `${cur + 1} / ${view.length}`;
    const rows = $('steps').querySelectorAll('.step');
    rows.forEach((r, idx) => {
      r.classList.toggle('cur', idx === cur);
      r.classList.toggle('future', idx > cur);
    });
    if (!noScroll && rows[cur]) { rows[cur].scrollIntoView({ block: 'center' }); }
    renderNow();
    renderFiles();
    markPhase();
    if (!$('flow').classList.contains('hidden')) { renderFlow(); }
    drawTimeline();
  }

  // index in the filtered view of the first step at or after an original step index
  function viewIndexFor(stepIdx) {
    const k = view.findIndex((s) => s.i >= stepIdx);
    return k < 0 ? Math.max(0, view.length - 1) : k;
  }
  const baseName = (f) => String(f).split('/').pop() || f;

  function renderNow() {
    const s = view[cur];
    const el = $('now');
    el.classList.remove('hidden');
    el.setAttribute('data-op', s.op);
    const agent = session.agents.find((a) => a.key === s.agent);
    const lines = s.lines ? ` · lines ${s.lines[0]}${s.lines[1] !== s.lines[0] ? `–${s.lines[1]}` : ''}` : '';
    el.innerHTML = `<div class="now-top"><span class="agent-tag"><i style="background:${colorFor(s.agent)}"></i>${esc(agent ? agent.type : s.agent)}</span>`
      + `<span class="op-tag ${esc(s.op)}">${esc(OP_LABEL[s.op] || s.op)}</span><span class="when">${esc(clock(s.t))}</span></div>`
      + (s.op === 'search' ? `<div class="now-file mono">⌕ ${esc(s.query || '')}</div><div class="now-detail">${s.hits === undefined ? 'results not recorded' : `${s.hits} hit(s)`} in ${esc(s.file)}</div>`
        : (s.op === 'bash' || s.op === 'call') ? `<div class="now-file mono">${esc(s.detail || '')}</div>`
          : `<div class="now-file mono">${esc(s.file)}${esc(lines)}</div><div class="now-detail">${esc(s.detail || '')}${s.symbol ? ` · in <span class="mono">${esc(s.symbol)}</span>` : ''}</div>`)
      + (s.caption ? `<div class="quote">“${esc(s.caption)}”</div>` : '')
      + whyHtml(s);
  }

  // What led to this step: the search whose result it opened, and for an edit
  // the files read since the agent's previous edit.
  function whyHtml(s) {
    let html = '';
    const o = openedBy.get(s.i);
    if (o) {
      const q = steps[o.search];
      html += `<div class="why"><b>Led here by</b> <a data-seek="${o.search}">⌕ ${esc(q.query || 'search')}</a> <span class="muted">${s.i - o.search} step(s) earlier</span></div>`;
    }
    const c = ctxOf.get(s.i);
    if (c && (c.reads.length || c.searches.length)) {
      const reads = c.reads.map((r) => `<a data-seek="${r.step}" class="mono" title="${esc(r.file)}">${esc(baseName(r.file))}</a>`);
      const searches = c.searches.map((i) => `<a data-seek="${i}">⌕ ${esc(steps[i].query || 'search')}</a>`);
      html += `<div class="why"><b>Context for this edit</b> ${searches.concat(reads).join(' · ')}</div>`;
    }
    return html;
  }
  $('now').addEventListener('click', (e) => {
    const a = /** @type {HTMLElement} */ (e.target).closest('[data-seek]');
    if (a) { stop(); seek(viewIndexFor(Number(a.getAttribute('data-seek'))), false); }
  });

  // ---- phases band ----
  function renderPhases() {
    const el = $('phases');
    if (!analysis || !analysis.phases.length) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML = analysis.phases.map((p, k) => {
      const dur = p.activeMs ? fmtDur(p.activeMs) : `${p.count} steps`;
      const tip = `${p.kind}: ${p.count} steps, ${dur} active, ${p.reads} reads, ${p.writes} edits, ${p.searches} searches` + (p.topFiles.length ? `\n${p.topFiles.join('\n')}` : '');
      return `<div class="ph ${p.kind}" data-ph="${k}" style="flex:${Math.max(p.count, 6)}" title="${esc(tip)}"><span>${esc(p.kind)}</span><i>${esc(dur)}</i></div>`;
    }).join('');
    markPhase();
  }
  $('phases').addEventListener('click', (e) => {
    const el = /** @type {HTMLElement} */ (e.target).closest('[data-ph]');
    if (el && analysis) { stop(); seek(viewIndexFor(analysis.phases[Number(el.getAttribute('data-ph'))].from), false); }
  });
  function markPhase() {
    if (!analysis || !view[cur]) { return; }
    const at = view[cur].i;
    $('phases').querySelectorAll('.ph').forEach((el, k) => {
      const p = analysis.phases[k];
      el.classList.toggle('cur', !!p && at >= p.from && at <= p.to);
    });
  }

  // ---- worth a look ----
  function renderInsights() {
    const box = $('insights-box');
    const list = analysis ? analysis.drift : [];
    box.classList.toggle('hidden', !list.length);
    if (!list.length) { return; }
    $('insights-title').textContent = `Worth a look (${list.length})`;
    $('insights').innerHTML = list.map((d) =>
      `<div class="insight ${d.level}${d.steps.length ? ' go' : ''}"${d.steps.length ? ` data-seek="${d.steps[0]}"` : ''}>`
      + `<i></i><div><div>${esc(d.title)}</div><div class="muted">${esc(d.detail || '')}</div></div></div>`).join('');
  }
  $('insights').addEventListener('click', (e) => {
    const a = /** @type {HTMLElement} */ (e.target).closest('[data-seek]');
    if (a) { stop(); seek(viewIndexFor(Number(a.getAttribute('data-seek'))), false); }
  });

  // ---- tabs + flow ----
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
    const tab = b.getAttribute('data-tab');
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $('steps').classList.toggle('hidden', tab !== 'steps');
    $('flow').classList.toggle('hidden', tab !== 'flow');
    if (tab === 'flow') { renderFlow(); }
  }));

  // queries -> files read -> files edited, as of the current step
  function renderFlow() {
    const el = $('flow');
    if (!TA || !view[cur]) { el.innerHTML = ''; return; }
    const f = TA.flow(steps, view[cur].i);
    if (!f.reads.length && !f.writes.length) { el.innerHTML = '<div class="now-detail" style="padding:16px">Nothing read or edited yet.</div>'; return; }
    const W = Math.max(520, el.clientWidth - 8);
    const colW = Math.max(150, Math.min(270, (W - 40) / 3));
    const X = { q: 8, r: (W - colW) / 2, w: W - colW - 8 };
    const ROW = 26;
    const cols = { q: f.queries, r: f.reads, w: f.writes };
    const pos = new Map();
    for (const k of ['q', 'r', 'w']) {
      cols[k].forEach((n, i) => pos.set(n.id, { x: X[k], y: 30 + i * ROW, col: k }));
    }
    const H = 30 + Math.max(f.queries.length, f.reads.length, f.writes.length) * ROW + 10;
    const chars = Math.floor((colW - 38) / 6.3);
    const cut = (t, n) => (t.length > n ? `…${t.slice(t.length - n + 1)}` : t);
    const cutHead = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
    const links = f.links.filter((l) => pos.has(l.from) && pos.has(l.to)).map((l) => {
      const a = pos.get(l.from);
      const b = pos.get(l.to);
      const x1 = a.x + colW;
      const y1 = a.y + 10;
      const x2 = b.x;
      const y2 = b.y + 10;
      const dx = (x2 - x1) / 2;
      return `<path class="link ${l.kind}" data-a="${esc(l.from)}" data-b="${esc(l.to)}" stroke-width="${1 + Math.min(3, l.w - 1)}" d="M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}"></path>`;
    }).join('');
    const node = (n, col, label, sub, fill) => {
      const p = pos.get(n.id);
      return `<g class="node" data-id="${esc(n.id)}"${n.file ? ` data-file="${esc(n.file)}"` : ''}><title>${esc(n.file || label)}${n.symbol ? ` · ${esc(n.symbol)}` : ''}</title>`
        + `<rect x="${p.x}" y="${p.y}" width="${colW}" height="20" rx="4" fill="${fill}"></rect>`
        + `<text x="${p.x + 7}" y="${p.y + 14}">${esc(label)}</text><text class="n" x="${p.x + colW - 6}" y="${p.y + 14}" text-anchor="end">${esc(sub)}</text></g>`;
    };
    const nodes = f.queries.map((n) => node(n, 'q', cutHead(n.label, chars), `${n.n}→`, 'rgba(180,130,230,0.22)')).join('')
      + f.reads.map((n) => node(n, 'r', cut(n.file, chars), `${n.n}×`, 'rgba(120,170,230,0.2)')).join('')
      + f.writes.map((n) => node(n, 'w', n.symbol ? cutHead(n.symbol, chars) : cut(n.file, chars), `${n.n}✎`, 'rgba(230,150,90,0.24)')).join('');
    const head = `<text class="col" x="${X.q}" y="16">Searches that led somewhere</text><text class="col" x="${X.r}" y="16">Files read</text><text class="col" x="${X.w}" y="16">Files edited</text>`;
    el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${head}${links}${nodes}</svg>`
      + '<div class="now-detail" style="padding:6px 12px">Purple lines: a search led to opening that file. Blue lines: files read before an edit. Click a file to jump to its latest step.</div>';
  }
  $('flow').addEventListener('mouseover', (e) => {
    const g = /** @type {HTMLElement} */ (e.target).closest('.node');
    const svg = $('flow').querySelector('svg');
    if (!svg) { return; }
    const id = g ? g.getAttribute('data-id') : null;
    svg.classList.toggle('dim', !!id);
    svg.querySelectorAll('.link').forEach((l) => l.classList.toggle('hl', !!id && (l.getAttribute('data-a') === id || l.getAttribute('data-b') === id)));
  });
  $('flow').addEventListener('click', (e) => {
    const g = /** @type {HTMLElement} */ (e.target).closest('.node');
    const file = g && g.getAttribute('data-file');
    if (!file) { return; }
    for (let i = cur; i >= 0; i--) {
      if (view[i].file === file && (view[i].op === 'read' || view[i].op === 'write')) { stop(); seek(i, false); return; }
    }
  });

  // files read/edited up to the current step
  function renderFiles() {
    const m = new Map();
    for (let i = 0; i <= cur; i++) {
      const s = view[i];
      if (s.op !== 'read' && s.op !== 'write') { continue; }
      const f = m.get(s.file) || { r: 0, w: 0 };
      if (s.op === 'write') { f.w++; } else { f.r++; }
      m.set(s.file, f);
    }
    const top = Array.from(m.entries()).sort((a, b) => (b[1].w * 3 + b[1].r) - (a[1].w * 3 + a[1].r)).slice(0, 12);
    const max = top.length ? Math.max.apply(null, top.map((t) => t[1].r + t[1].w)) : 1;
    $('files-title').textContent = `Files touched so far (${m.size})`;
    $('files').innerHTML = top.map(([name, f]) =>
      `<div class="file-row"><span class="name mono" title="${esc(name)}">&lrm;${esc(name)}</span>`
      + `<span class="bar"><b class="r" style="width:${(f.r / max) * 100}%"></b><b class="w" style="width:${(f.w / max) * 100}%"></b></span>`
      + `<span class="n">${f.r}r ${f.w}w</span></div>`).join('') || '<div class="now-detail">none yet</div>';
  }

  // ---- timeline ----
  const LABEL_W = 230;
  const LANE_H = 18;
  function layoutTimeline() {
    lanes = session.agents.filter((a) => !agentsOff.has(a.key) && view.some((s) => s.agent === a.key));
    const ratio = window.devicePixelRatio || 1;
    const w = canvas.parentElement.clientWidth;
    const h = Math.max(36, lanes.length * LANE_H + 12);
    canvas.style.height = `${h}px`;
    canvas.width = Math.max(1, Math.floor(w * ratio));
    canvas.height = Math.floor(h * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  const xOf = (i) => LABEL_W + ((i + 0.5) / Math.max(1, view.length)) * (canvas.clientWidth - LABEL_W - 10);

  function drawTimeline() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    const cs = getComputedStyle(document.body);
    const fg = cs.color;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    const laneIdx = new Map(lanes.map((a, i) => [a.key, i]));
    lanes.forEach((a, i) => {
      const y = 6 + i * LANE_H;
      if (i % 2) { ctx.fillStyle = 'rgba(128,128,128,0.07)'; ctx.fillRect(0, y, w, LANE_H); }
      ctx.fillStyle = colorFor(a.key);
      ctx.beginPath(); ctx.arc(10, y + LANE_H / 2, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = fg; ctx.globalAlpha = 0.8;
      const full = a.description ? `${a.type} · ${a.description}` : a.type;
      const label = full.length > 34 ? `${full.slice(0, 33)}…` : full;
      ctx.fillText(label, 20, y + LANE_H / 2);
      ctx.globalAlpha = 1;
    });
    const tickW = Math.max(1, Math.min(4, (w - LABEL_W) / Math.max(1, view.length)));
    view.forEach((s, i) => {
      const lane = laneIdx.get(s.agent);
      if (lane === undefined) { return; }
      const y = 6 + lane * LANE_H + 3;
      ctx.fillStyle = `rgba(${OP_RGB[s.op] || OP_RGB.bash},${i <= cur ? 0.95 : 0.35})`;
      ctx.fillRect(xOf(i) - tickW / 2, y, tickW, LANE_H - 6);
    });
    // idle gaps
    ctx.strokeStyle = 'rgba(128,128,128,0.45)';
    ctx.setLineDash([2, 3]);
    for (let i = 1; i < view.length; i++) {
      if (Date.parse(view[i].t) - Date.parse(view[i - 1].t) > GAP_MS) {
        const x = (xOf(i) + xOf(i - 1)) / 2;
        ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x, h - 2); ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    if (view.length) {
      ctx.strokeStyle = cs.getPropertyValue('--link') || '#3794ff';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(xOf(cur), 0); ctx.lineTo(xOf(cur), h); ctx.stroke();
      ctx.lineWidth = 1;
    }
  }
  canvas.addEventListener('click', (e) => {
    if (!view.length) { return; }
    const rect = canvas.getBoundingClientRect();
    const f = (e.clientX - rect.left - LABEL_W) / Math.max(1, rect.width - LABEL_W - 10);
    stop();
    seek(Math.round(f * view.length - 0.5), false);
  });
  window.addEventListener('resize', () => { if (session) { layoutTimeline(); drawTimeline(); } });

  // ---- play ----
  function stop() {
    if (timer) { clearInterval(timer); timer = 0; }
    $('play').textContent = '▶ Play';
  }
  $('play').addEventListener('click', () => {
    if (timer) { stop(); return; }
    if (cur >= view.length - 1) { seek(0, false); }
    $('play').textContent = '⏸ Pause';
    const perSec = Number(/** @type {HTMLSelectElement} */ ($('speed')).value) || 4;
    timer = setInterval(() => {
      if (cur >= view.length - 1) { stop(); return; }
      seek(cur + 1, false);
    }, Math.max(30, 1000 / perSec));
  });
  $('speed').addEventListener('change', () => { if (timer) { stop(); $('play').click(); } });
  scrub.addEventListener('input', () => { stop(); seek(Number(scrub.value), false); });
  $('session').addEventListener('change', () => {
    sessionId = /** @type {HTMLSelectElement} */ ($('session')).value;
    agentsOff.clear();
    opsOff.clear();
    openSession(null);
  });
  $('export').addEventListener('click', () => api.postMessage({ type: 'export' }));
  window.addEventListener('keydown', (e) => {
    if (/** @type {HTMLElement} */ (e.target).tagName === 'SELECT') { return; }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { stop(); seek(cur + 1, false); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { stop(); seek(cur - 1, false); e.preventDefault(); }
    else if (e.key === ' ') { $('play').click(); e.preventDefault(); }
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.type === 'trace') { load(msg.doc, !!msg.keep); }
    if (msg && msg.type === 'seek' && doc) { jumpTo(msg); }
  });

  // Open a given step (from "show the agent trace for this line").
  function jumpTo(msg) {
    if (msg.session && doc.sessions[msg.session] && msg.session !== sessionId) {
      sessionId = msg.session;
      /** @type {HTMLSelectElement} */ ($('session')).value = sessionId;
      agentsOff.clear();
      opsOff.clear();
      openSession(null);
    } else if (agentsOff.size || opsOff.size) {
      agentsOff.clear();
      opsOff.clear();
      renderFilters();
      rebuild(null);
    }
    // Several steps of one tool call share a timestamp, so match as precisely as
    // the message allows, then loosen.
    const same = (s, strict) => s.t === msg.t && (!msg.agent || s.agent === msg.agent)
      && (!strict || ((!msg.op || s.op === msg.op) && (!msg.file || s.file === msg.file)));
    let at = view.findIndex((s) => same(s, true));
    if (at < 0) { at = view.findIndex((s) => same(s, false)); }
    if (at < 0) { at = view.findIndex((s) => s.t >= msg.t); }
    stop();
    seek(at < 0 ? 0 : at, false);
  }
  if (window.__TRACE__) {
    $('export').classList.add('hidden');
    load(window.__TRACE__, false);
  } else {
    api.postMessage({ type: 'ready' });
  }
})();
