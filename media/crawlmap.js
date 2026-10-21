// @ts-check
// Spiderling Crawl Map webview. Receives activity events from the extension and
// renders files as nodes with a line-drawn spider per agent crawling between the
// files it touches, leaving a fading silk trail. Pure canvas, no dependencies.
(function () {
  const vscode = acquireVsCodeApi();
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('canvas'));
  const ctx = canvas.getContext('2d');
  const legendEl = document.getElementById('legend');
  const statsEl = document.getElementById('stats');
  const tickerEl = document.getElementById('ticker');
  const toggleBtn = document.getElementById('toggle');
  const zoomLevelEl = document.getElementById('zoom-level');
  const recapEl = document.getElementById('recap');
  const recapBody = document.getElementById('recap-body');
  const focusEl = /** @type {HTMLSelectElement} */ (document.getElementById('focus'));

  let focusAgent = ''; // '' = all agents

  // op -> label icon and node tint
  const OP_ICON = { read: '👁', write: '✎', search: '⌕', bash: '$' };
  function opFill(op, alpha) {
    if (op === 'write') { return `rgba(220,120,80,${alpha})`; }
    if (op === 'search') { return `rgba(180,120,230,${alpha})`; }
    if (op === 'bash') { return `rgba(150,150,150,${alpha})`; }
    return `rgba(120,160,220,${alpha})`;
  }

  // pan / zoom of the map (world -> screen: screen = world * view + pan)
  let view = 1;
  let panX = 0;
  let panY = 0;
  /** @type {{agent:string,color:string,op:string,file:string,detail:string,when:string}[]} */
  const flow = [];
  let recapVisible = false;

  /** @type {Map<string, {x:number,y:number,label:string,reads:number,writes:number,pulse:number}>} */
  const nodes = new Map();
  /** @type {Map<string, {color:string,x:number,y:number,tx:number,ty:number,target:string|null,legPhase:number,label:string}>} */
  const spiders = new Map();
  /** @type {{from:{x:number,y:number},to:{x:number,y:number},color:string,age:number}[]} */
  const threads = [];
  /** @type {string[]} */
  const ticks = [];
  let paused = false;
  let placeIndex = 0;

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * ratio;
    canvas.height = canvas.clientHeight * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  window.addEventListener('resize', resize);

  // Deterministic, spread-out placement for each new file node (phyllotaxis
  // spiral keeps nodes from clumping as the count grows).
  function placeNode() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const cx = w / 2;
    const cy = h / 2;
    const i = placeIndex++;
    const golden = Math.PI * (3 - Math.sqrt(5));
    const radius = Math.min(w, h) * 0.46 * Math.sqrt(i / 120 + 0.02);
    const angle = i * golden;
    return {
      x: Math.max(24, Math.min(w - 24, cx + radius * Math.cos(angle))),
      y: Math.max(24, Math.min(h - 24, cy + radius * Math.sin(angle))),
    };
  }

  function ensureNode(file) {
    let node = nodes.get(file);
    if (!node) {
      const pos = placeNode();
      node = { x: pos.x, y: pos.y, label: file.split('/').pop() || file, reads: 0, writes: 0, pulse: 0, lastOp: 'read' };
      nodes.set(file, node);
    }
    return node;
  }

  function handleEvent(ev) {
    const node = ensureNode(ev.file);
    if (ev.op === 'write') { node.writes++; } else { node.reads++; }
    node.lastOp = ev.op;
    node.pulse = 1;

    let spider = spiders.get(ev.agent);
    if (!spider) {
      spider = { color: ev.color, x: node.x, y: node.y, tx: node.x, ty: node.y, target: ev.file, legPhase: 0, label: ev.agent };
      spiders.set(ev.agent, spider);
      renderLegend();
      populateFocus();
    }
    // Draw a silk thread from where the spider is heading now to the new target.
    threads.push({ from: { x: spider.tx, y: spider.ty }, to: { x: node.x, y: node.y }, color: spider.color, agent: ev.agent, age: 0 });
    while (threads.length > 160) { threads.shift(); }
    spider.tx = node.x;
    spider.ty = node.y;
    spider.target = ev.file;
    spider.color = ev.color;

    const when = (ev.ts || '').slice(11, 19);
    const detail = ev.detail ? `  (${ev.detail})` : '';
    ticks.unshift(`${when}  ${ev.agent}  ${OP_ICON[ev.op] || '•'}  ${ev.file}${detail}`);
    while (ticks.length > 6) { ticks.pop(); }

    flow.push({ agent: ev.agent, color: ev.color, op: ev.op, file: ev.file, detail: ev.detail || '', caption: ev.caption || '', when });
    while (flow.length > 5000) { flow.shift(); }

    renderTicker();
    renderStats();
    if (recapVisible) { scheduleRecap(); }
  }

  // Replays and bursts deliver many events at once; rebuild the recap at most
  // a few times a second.
  let recapTimer = 0;
  function scheduleRecap() {
    if (recapTimer) { return; }
    recapTimer = setTimeout(() => { recapTimer = 0; renderRecap(); }, 250);
  }

  // A per-agent ordered recap of the whole flow: every read, edit and search
  // each agent made, in order. The live Code Crawl may skip steps to keep up;
  // this never does.
  function renderRecap() {
    const byAgent = new Map();
    for (const step of flow) {
      if (!byAgent.has(step.agent)) { byAgent.set(step.agent, { color: step.color, steps: [] }); }
      byAgent.get(step.agent).steps.push(step);
    }
    recapBody.innerHTML = '';
    if (byAgent.size === 0) {
      const none = document.createElement('div');
      none.style.opacity = '0.6';
      none.textContent = 'No activity yet.';
      recapBody.appendChild(none);
      return;
    }
    for (const [agent, info] of byAgent) {
      const group = document.createElement('div');
      group.className = 'recap-agent';
      const name = document.createElement('div');
      name.className = 'recap-agent-name';
      const dot = document.createElement('span');
      dot.className = 'legend-dot';
      dot.style.background = info.color;
      const label = document.createElement('span');
      label.textContent = `${agent} · ${info.steps.length} step(s)`;
      name.appendChild(dot);
      name.appendChild(label);
      group.appendChild(name);
      for (const step of info.steps) {
        const row = document.createElement('div');
        row.className = 'recap-step';
        row.title = [step.when, step.file, step.caption ? `“${step.caption}”` : ''].filter(Boolean).join('\n');
        const icon = document.createElement('span');
        icon.className = step.op === 'write' ? 'op-w' : step.op === 'search' ? 'op-s' : 'op-r';
        icon.textContent = OP_ICON[step.op] || '•';
        const text = document.createElement('span');
        const base = step.op === 'bash' ? '' : (step.file.split('/').pop() || step.file);
        text.textContent = step.detail ? (base ? `${base} — ${step.detail}` : step.detail) : base;
        row.appendChild(icon);
        row.appendChild(text);
        group.appendChild(row);
      }
      recapBody.appendChild(group);
    }
  }

  function renderLegend() {
    legendEl.innerHTML = '';
    for (const [agent, spider] of spiders) {
      const item = document.createElement('span');
      item.className = 'legend-item';
      const dot = document.createElement('span');
      dot.className = 'legend-dot';
      dot.style.background = spider.color;
      const label = document.createElement('span');
      label.textContent = agent;
      item.appendChild(dot);
      item.appendChild(label);
      legendEl.appendChild(item);
    }
  }

  function renderTicker() {
    tickerEl.innerHTML = '';
    for (const line of ticks) {
      const div = document.createElement('div');
      div.className = 'tick-line';
      div.textContent = line;
      tickerEl.appendChild(div);
    }
  }

  function renderStats() {
    statsEl.textContent = `${spiders.size} agent(s) · ${nodes.size} file(s)`;
  }

  // Keep the focus dropdown in sync with the agents we've seen.
  function populateFocus() {
    const want = ['', ...spiders.keys()];
    const have = Array.from(focusEl.options).map((o) => o.value);
    if (want.length === have.length && want.every((v, i) => v === have[i])) { return; }
    const current = focusEl.value;
    focusEl.innerHTML = '';
    for (const v of want) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v || 'all agents';
      focusEl.appendChild(opt);
    }
    focusEl.value = want.includes(current) ? current : '';
    focusAgent = focusEl.value;
  }

  function drawSpider(s) {
    const r = 6;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = 1.5;
    const wiggle = Math.sin(s.legPhase) * 2;
    // eight legs, four each side
    for (let i = 0; i < 4; i++) {
      const dy = (i - 1.5) * 4;
      const len = 9 + (i % 2) * 3;
      ctx.beginPath();
      ctx.moveTo(s.x - r + 2, s.y + dy);
      ctx.lineTo(s.x - r - len, s.y + dy + wiggle * (i % 2 ? 1 : -1));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s.x + r - 2, s.y + dy);
      ctx.lineTo(s.x + r + len, s.y + dy - wiggle * (i % 2 ? 1 : -1));
      ctx.stroke();
    }
    // body + head, with a soft glow
    ctx.save();
    ctx.shadowColor = s.color;
    ctx.shadowBlur = 9;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.ellipse(s.x, s.y, r * 0.8, r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(s.x, s.y - r, r * 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // agent label trailing the spider
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = s.color;
    ctx.font = '10px sans-serif';
    ctx.fillText(s.label, s.x + r + 6, s.y - r - 2);
    ctx.globalAlpha = 1;
  }

  function frame() {
    if (!paused) {
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      ctx.save();
      ctx.translate(panX, panY);
      ctx.scale(view, view);

      // fading silk threads
      for (const t of threads) {
        t.age += 0.01;
        const a = Math.max(0, 0.5 - t.age * 0.5);
        if (a <= 0) { continue; }
        if (focusAgent && t.agent !== focusAgent) { continue; }
        ctx.strokeStyle = t.color;
        ctx.globalAlpha = a;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(t.from.x, t.from.y);
        ctx.lineTo(t.to.x, t.to.y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // file nodes (tinted by the last operation on them)
      for (const node of nodes.values()) {
        const op = node.lastOp || 'read';
        const size = 3 + Math.min(6, (node.reads + node.writes) * 0.4);
        if (node.pulse > 0) {
          ctx.globalAlpha = node.pulse * 0.5;
          ctx.beginPath();
          ctx.arc(node.x, node.y, size + node.pulse * 12, 0, Math.PI * 2);
          ctx.fillStyle = opFill(op, 0.6);
          ctx.fill();
          node.pulse = Math.max(0, node.pulse - 0.03);
          ctx.globalAlpha = 1;
        }
        ctx.save();
        ctx.shadowColor = opFill(op, 0.8);
        ctx.shadowBlur = op === 'write' ? 8 : 5;
        ctx.fillStyle = opFill(op, 0.95);
        ctx.beginPath();
        ctx.arc(node.x, node.y, size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = 'rgba(200,200,200,0.75)';
        ctx.font = '10px monospace';
        ctx.fillText(node.label, node.x + size + 3, node.y + 3);
      }

      // spiders crawl toward their current target
      for (const s of spiders.values()) {
        if (focusAgent && s.label !== focusAgent) { continue; }
        const dx = s.tx - s.x;
        const dy = s.ty - s.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.5) {
          const step = Math.min(dist, Math.max(2, dist * 0.08));
          s.x += (dx / dist) * step;
          s.y += (dy / dist) * step;
          s.legPhase += 0.6;
        } else {
          s.legPhase += 0.08; // idle breathing
        }
        drawSpider(s);
      }

      ctx.restore();
    }
    requestAnimationFrame(frame);
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) { return; }
    if (msg.type === 'event') {
      handleEvent(msg.event);
    } else if (msg.type === 'reset') {
      nodes.clear();
      spiders.clear();
      threads.length = 0;
      ticks.length = 0;
      flow.length = 0;
      placeIndex = 0;
      renderLegend();
      populateFocus();
      renderTicker();
      renderStats();
      if (recapVisible) { renderRecap(); }
    }
  });

  toggleBtn.addEventListener('click', () => {
    paused = !paused;
    toggleBtn.textContent = paused ? '▶ Resume' : '⏸ Pause';
  });

  // ---- zoom / pan ----------------------------------------------------------
  function setZoomLabel() { zoomLevelEl.textContent = `${Math.round(view * 100)}%`; }
  function zoomAt(mx, my, factor) {
    const next = Math.max(0.2, Math.min(5, view * factor));
    panX = mx - (mx - panX) * (next / view);
    panY = my - (my - panY) * (next / view);
    view = next;
    setZoomLabel();
  }
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) { return; }
    panX += e.clientX - lastX;
    panY += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
  });
  window.addEventListener('mouseup', () => { dragging = false; });

  document.getElementById('zoom-in').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.2));
  document.getElementById('zoom-out').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.2));
  document.getElementById('zoom-reset').addEventListener('click', () => { view = 1; panX = 0; panY = 0; setZoomLabel(); });

  focusEl.addEventListener('change', () => { focusAgent = focusEl.value; });

  document.getElementById('recap-toggle').addEventListener('click', () => {
    recapVisible = !recapVisible;
    recapEl.classList.toggle('hidden', !recapVisible);
    if (recapVisible) { renderRecap(); }
    resize();
  });

  resize();
  setZoomLabel();
  renderStats();
  requestAnimationFrame(frame);
  vscode.postMessage({ type: 'ready' });
})();
