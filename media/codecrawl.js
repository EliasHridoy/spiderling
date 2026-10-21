// @ts-check
// Spiderling Code Crawl webview — one lane per live agent.
//
// The extension paces each agent's steps (see src/livePlayer.ts) and sends them
// here one at a time. A lane plays each step as a path of waypoints the spider
// walks:
//  - read / write: the spider crawls ALONG the lines of the exact range (a scan
//    beam for reads, a woven stitch for writes), strided to fit the step's time;
//  - search: the spider types the query into a search box, then walks down the
//    hits it found;
//  - a read that opens one of those hits: the spider picks the hit row, then
//    lands on that line in the file and crawls the range from there.
(function () {
  const vscode = acquireVsCodeApi();
  const lanesEl = /** @type {HTMLElement} */ (document.getElementById('lanes'));
  const statusEl = /** @type {HTMLElement} */ (document.getElementById('status'));
  const zoomLabel = /** @type {HTMLElement} */ (document.getElementById('zoom-level'));
  const focusEl = /** @type {HTMLSelectElement} */ (document.getElementById('focus'));

  const GUTTER = 52;          // x where code text starts (line numbers sit left of it)
  const MAX_LANES = 4;
  const LANE_TTL_MS = 25000;  // an idle lane closes after this long
  const MAX_HIT_ROWS = 30;
  const CAPTION_STALE_MS = 12000;

  let focusAgent = '';        // '' = all agents
  const agentsSeen = new Set();
  /** @type {Map<string, Lane>} */
  const lanes = new Map();
  let lastTs = 0;
  let zoom = 13;

  const measureCanvas = document.createElement('canvas');
  const measureCtx = /** @type {CanvasRenderingContext2D} */ (measureCanvas.getContext('2d'));

  // ---- zoom ----------------------------------------------------------------
  function applyZoom() {
    document.documentElement.style.setProperty('--cc-font', `${zoom}px`);
    zoomLabel.textContent = `${Math.round((zoom / 13) * 100)}%`;
    for (const lane of lanes.values()) { lane.layout(); }
  }
  function setZoom(px) {
    zoom = Math.max(8, Math.min(28, px));
    applyZoom();
  }
  document.getElementById('zoom-in').addEventListener('click', () => setZoom(zoom + 1));
  document.getElementById('zoom-out').addEventListener('click', () => setZoom(zoom - 1));
  document.getElementById('zoom-reset').addEventListener('click', () => setZoom(13));
  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(zoom + (e.deltaY < 0 ? 1 : -1));
    }
  }, { passive: false });

  // ---- helpers ---------------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function shortPath(p) {
    const segs = String(p || '').split('/');
    return segs.length > 4 ? `…/${segs.slice(-3).join('/')}` : p;
  }
  function textWidthOf(text, el) {
    let fam = 'monospace';
    let size = `${zoom}px`;
    try {
      const cs = getComputedStyle(el);
      fam = cs.fontFamily || fam;
      size = cs.fontSize || size;
    } catch (e) { /* no DOM */ }
    measureCtx.font = `${size} ${fam}`;
    return measureCtx.measureText(String(text).replace(/\t/g, '    ')).width;
  }
  const OP_ICON = { read: '👁', write: '✎', search: '⌕' };

  // ---- lane ------------------------------------------------------------------
  class Lane {
    constructor(key, agent, agentId, color) {
      this.key = key;
      this.agent = agent;
      this.color = color;
      this.mode = 'code';       // 'code' | 'search'
      this.file = '';
      this.lineEls = [];
      this.rangeEls = [];
      this.hitEls = [];
      this.queue = [];          // steps waiting to play
      this.step = null;         // step being played
      this.path = [];           // waypoints still to walk
      this.wp = null;           // current waypoint
      this.phase = 'approach';  // 'approach' | 'crawl'
      this.dwell = 0;
      this.rush = false;
      this.lastActive = performance.now();
      this.web = [];
      this.x = GUTTER;
      this.y = 20;
      this.prevX = this.x;
      this.prevY = this.y;
      this.heading = 0;
      this.feet = [];
      for (let i = 0; i < 8; i++) {
        this.feet.push({ x: this.x, y: this.y, side: i < 4 ? -1 : 1, rank: i % 4, step: Math.random() * 6.28 });
      }
      this.captionTimer = 0;

      this.root = document.createElement('div');
      this.root.className = 'lane';
      this.root.innerHTML =
        '<div class="lane-header"><span class="dot"></span><span class="agent"></span>'
        + '<span class="op"></span><span class="file" title=""></span></div>'
        + '<div class="caption"><span class="caption-text"></span></div>'
        + '<div class="lane-body">'
        + '<div class="viewport code-vp"><pre class="code"></pre></div>'
        + '<div class="viewport search-vp hidden">'
        + '<div class="search-box"><span class="search-icon">⌕</span><span class="search-tool"></span>'
        + '<span class="search-text"></span><span class="search-caret"></span></div>'
        + '<div class="search-meta"></div><div class="hits"></div></div>'
        + '<canvas class="overlay"></canvas></div>';
      lanesEl.appendChild(this.root);
      const q = (sel) => /** @type {HTMLElement} */ (this.root.querySelector(sel));
      this.dotEl = q('.dot');
      this.agentEl = q('.agent');
      this.opEl = q('.op');
      this.fileEl = q('.file');
      this.captionEl = q('.caption');
      this.captionText = q('.caption-text');
      this.body = q('.lane-body');
      this.codeVp = q('.code-vp');
      this.codeEl = q('.code');
      this.searchVp = q('.search-vp');
      this.searchBox = q('.search-box');
      this.searchTool = q('.search-tool');
      this.searchText = q('.search-text');
      this.searchMeta = q('.search-meta');
      this.hitsEl = q('.hits');
      this.canvas = /** @type {HTMLCanvasElement} */ (q('.overlay'));
      this.ctx = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d'));

      this.agentEl.textContent = agentId ? `${agent} · ${agentId.slice(0, 6)}` : agent;
      this.dotEl.style.background = color;
      this.fileEl.addEventListener('click', () => {
        if (this.file) { vscode.postMessage({ type: 'open', file: this.file }); }
      });
    }

    vp() { return this.mode === 'code' ? this.codeVp : this.searchVp; }

    layout() {
      const ratio = window.devicePixelRatio || 1;
      const w = this.body.clientWidth;
      const h = this.body.clientHeight;
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
      this.canvas.width = Math.max(1, w * ratio);
      this.canvas.height = Math.max(1, h * ratio);
      this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    // Switch views, keeping the spider where it is on screen.
    setMode(mode) {
      if (this.mode === mode) { return; }
      const screenY = this.y - this.vp().scrollTop;
      const prevScreenY = this.prevY - this.vp().scrollTop;
      this.mode = mode;
      this.codeVp.classList.toggle('hidden', mode !== 'code');
      this.searchVp.classList.toggle('hidden', mode !== 'search');
      this.y = screenY + this.vp().scrollTop;
      this.prevY = prevScreenY + this.vp().scrollTop;
      this.web = [];
    }

    ensureVisible(y) {
      const vp = this.vp();
      const top = vp.scrollTop;
      const h = vp.clientHeight;
      if (y < top + 30) {
        vp.scrollTo({ top: Math.max(0, y - 60) });
      } else if (y > top + h - 50) {
        vp.scrollTo({ top: y - h + 120 });
      }
    }

    // ---- queue ----
    enqueue(step) {
      this.queue.push(step);
      this.lastActive = performance.now();
      this.rush = this.queue.length > 1;
    }

    busy() { return !!(this.step || this.wp || this.queue.length || this.path.length); }

    // Next waypoint; when the step's path is done, start the next queued step.
    advance() {
      for (let guard = 0; guard < 50; guard++) {
        if (this.path.length) {
          this.wp = this.path.shift();
          this.phase = 'approach';
          if (this.wp.onBegin) { this.wp.onBegin(); }
          return true;
        }
        this.step = null;
        if (!this.queue.length) { return false; }
        this.begin(this.queue.shift());
      }
      return false;
    }

    begin(step) {
      this.step = step;
      this.lastActive = performance.now();
      this.rush = this.queue.length > 1;
      this.setHeader(step);
      if (step.caption) { this.setCaption(step.caption); }
      if (step.op === 'search') {
        this.planSearch(step);
      } else if (typeof step.fromHit === 'number' && this.mode === 'search' && this.hitEls[step.fromHit]) {
        this.planPick(step);
      } else {
        this.planCode(step, 0.85);
      }
    }

    setHeader(step) {
      this.opEl.textContent = `${OP_ICON[step.op] || '•'} ${step.detail || step.op}`;
      this.opEl.style.color = this.color;
      this.fileEl.textContent = shortPath(step.file);
      this.fileEl.title = step.file;
      this.root.dataset.op = step.op;
    }

    setCaption(text) {
      this.captionText.textContent = text;
      this.captionEl.classList.add('show');
      this.captionEl.classList.remove('stale');
      clearTimeout(this.captionTimer);
      this.captionTimer = setTimeout(() => this.captionEl.classList.add('stale'), CAPTION_STALE_MS);
    }

    // Spread `budgetMs` over the waypoints: one speed so the walk ends on time.
    pace(wps, budgetMs) {
      let len = 0;
      let lastY = this.y;
      for (const w of wps) {
        len += Math.abs(w.x1 - w.x0) + Math.abs(w.y - lastY) * 0.5 + 10;
        lastY = w.y;
      }
      const speed = Math.max(0.12, Math.min(6, len / Math.max(150, budgetMs)));
      for (const w of wps) { w.speed = speed; }
      return wps;
    }

    // ---- code ----
    renderCode(lines) {
      this.codeEl.innerHTML = lines
        .map((l) => `<span class="line">${escapeHtml(l) || ' '}</span>`)
        .join('');
      this.lineEls = Array.from(this.codeEl.querySelectorAll('.line'));
      this.rangeEls = [];
      this.web = [];
    }

    lineCenter(i) {
      const el = this.lineEls[i];
      return el ? el.offsetTop + el.offsetHeight / 2 : 0;
    }

    lineWidth(i) {
      const el = this.lineEls[i];
      const maxW = Math.max(60, this.body.clientWidth - GUTTER - 16);
      if (!el) { return 12; }
      return Math.max(10, Math.min(textWidthOf(el.textContent || '', this.codeEl), maxW));
    }

    planCode(step, budgetFrac) {
      this.setMode('code');
      const newFile = Array.isArray(step.lines);
      if (newFile) {
        this.renderCode(step.lines);
      } else if (step.unreadable) {
        this.renderCode([`(${step.file} is not readable here — binary, too large, or outside this machine)`]);
      } else if (this.file !== step.file && this.lineEls.length === 0) {
        this.renderCode(['(loading…)']);
      }
      this.file = step.file;
      const n = this.lineEls.length;
      if (!n) { return; }

      for (const el of this.rangeEls) { el.classList.remove('in-range', 'r-read', 'r-write'); }
      const clamp = (i) => Math.max(0, Math.min(n - 1, i));
      const hasRange = Number.isFinite(step.startLine);
      const from = hasRange ? clamp(step.startLine - 1) : 0;
      const to = Number.isFinite(step.endLine) ? clamp(step.endLine - 1) : (hasRange && step.op === 'write' ? from : n - 1);
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      this.rangeEls = this.lineEls.slice(lo, hi + 1);
      for (const el of this.rangeEls) { el.classList.add('in-range', step.op === 'write' ? 'r-write' : 'r-read'); }

      const budget = step.durationMs * budgetFrac;
      const wps = [];
      if (Number.isFinite(step.hitLine)) {
        const h = clamp(step.hitLine - 1);
        wps.push({
          kind: 'land', x0: GUTTER, x1: GUTTER + Math.min(80, this.lineWidth(h)), y: this.lineCenter(h), dwell: 220,
          onBegin: () => this.flash(h),
        });
      }
      const span = hi - lo + 1;
      const maxWp = Math.max(3, Math.min(80, Math.round(budget / 55)));
      const stride = Math.max(1, Math.ceil(span / maxWp));
      for (let i = lo; i <= hi; i += stride) { wps.push(this.lineWaypoint(i, step.op)); }
      if ((hi - lo) % stride !== 0) { wps.push(this.lineWaypoint(hi, step.op)); }
      this.ensureVisible(wps[0].y);
      if (newFile) {
        // The spider drops in on a thread from the top of the view.
        this.x = this.prevX = GUTTER;
        this.y = this.prevY = this.codeVp.scrollTop - 20;
      }
      this.path.push(...this.pace(wps, budget));
    }

    lineWaypoint(i, op) {
      return {
        kind: 'line', op, line: i, x0: GUTTER, x1: GUTTER + this.lineWidth(i), y: this.lineCenter(i),
        dwell: op === 'write' ? 60 : 25,
        onBegin: () => {
          const el = this.lineEls[i];
          if (el) { el.classList.remove('visited'); el.classList.add(op === 'write' ? 'active-write' : 'active-read'); }
        },
        onEnd: () => {
          const el = this.lineEls[i];
          if (el) {
            setTimeout(() => { el.classList.remove('active-read', 'active-write'); el.classList.add('visited'); }, 700);
          }
          this.web.push({ x: this.x, y: this.y, op, age: 0 });
          while (this.web.length > 70) { this.web.shift(); }
        },
      };
    }

    flash(i) {
      const el = this.lineEls[i];
      if (!el) { return; }
      el.classList.add('landing');
      setTimeout(() => el.classList.remove('landing'), 1600);
    }

    // ---- search ----
    planSearch(step) {
      this.setMode('search');
      this.searchVp.scrollTop = 0;
      this.searchTool.textContent = step.tool || 'search';
      this.searchText.textContent = '';
      this.searchMeta.textContent = `in ${shortPath(step.file)}`;
      this.hitsEl.innerHTML = '';
      this.hitEls = [];
      const query = step.query || '';
      const x0 = this.searchText.offsetLeft;
      const maxW = Math.max(40, this.body.clientWidth - x0 - 24);
      const w = Math.max(30, Math.min(maxW, textWidthOf(query, this.searchText)));
      const y = this.searchBox.offsetTop + this.searchBox.offsetHeight / 2;
      const typing = {
        kind: 'type', x0, x1: x0 + w, y, dwell: 160,
        onBegin: () => this.searchBox.classList.add('typing'),
        onProgress: (f) => { this.searchText.textContent = query.slice(0, Math.ceil(f * query.length)); },
        onEnd: () => {
          this.searchText.textContent = query;
          this.searchBox.classList.remove('typing');
          this.showHits(step, step.durationMs * 0.5);
        },
      };
      this.path.push(...this.pace([typing], step.durationMs * 0.35));
    }

    showHits(step, budget) {
      const hits = step.hits || [];
      const total = step.hitCount || 0;
      const files = new Set(hits.map((h) => h.file)).size;
      const known = step.hitCount !== undefined && step.hitCount !== null;
      this.searchMeta.textContent = !known
        ? `results not recorded by this agent · in ${shortPath(step.file)}`
        : total
          ? `${total} hit(s) in ${files}${total > hits.length ? '+' : ''} file(s) · in ${shortPath(step.file)}`
          : `no hits · in ${shortPath(step.file)}`;
      this.searchMeta.classList.toggle('none', known && !total);
      const rows = hits.slice(0, MAX_HIT_ROWS);
      this.hitsEl.innerHTML = rows.map((h, i) =>
        `<div class="hit" data-i="${i}"><span class="hit-file">${escapeHtml(shortPath(h.file))}</span>`
        + `${h.line ? `<span class="hit-line">:${h.line}</span>` : ''}`
        + `${h.text ? `<span class="hit-text">${escapeHtml(h.text.trim())}</span>` : ''}</div>`).join('')
        + (total > rows.length ? `<div class="more">+${total - rows.length} more</div>` : '');
      this.hitEls = Array.from(this.hitsEl.querySelectorAll('.hit'));
      this.hitEls.forEach((el, i) => {
        el.addEventListener('click', () => vscode.postMessage({ type: 'open', file: rows[i].file, line: rows[i].line }));
      });
      if (!this.hitEls.length) { return; }
      const count = Math.min(this.hitEls.length, Math.max(2, Math.min(30, Math.round(budget / 90))));
      const stride = Math.max(1, Math.ceil(this.hitEls.length / count));
      const wps = [];
      for (let i = 0; i < this.hitEls.length; i += stride) { wps.push(this.rowWaypoint(i)); }
      this.path.push(...this.pace(wps, budget));
    }

    rowWaypoint(i) {
      const el = this.hitEls[i];
      const w = Math.min(el.scrollWidth, this.body.clientWidth - 24);
      return {
        kind: 'row', x0: 10, x1: 10 + Math.max(40, w), y: el.offsetTop + el.offsetHeight / 2, dwell: 30,
        onBegin: () => el.classList.add('scan'),
        onEnd: () => { el.classList.remove('scan'); el.classList.add('seen'); },
      };
    }

    // A read that opens one of the hits: pick the row, then land in the file.
    planPick(step) {
      const el = this.hitEls[step.fromHit];
      const wp = {
        kind: 'row', x0: 10, x1: 10 + Math.min(Math.max(40, el.scrollWidth), this.body.clientWidth - 24),
        y: el.offsetTop + el.offsetHeight / 2, dwell: 260,
        onBegin: () => { el.classList.add('picked'); this.ensureVisible(el.offsetTop); },
        onEnd: () => this.planCode(step, 0.65),
      };
      this.path.push(...this.pace([wp], step.durationMs * 0.25));
    }

    // ---- animation ----
    tick(dt) {
      if (this.dwell > 0) {
        this.dwell -= dt * (this.rush ? 4 : 1);
        return;
      }
      if (!this.wp && !this.advance()) { return; }
      const wp = this.wp;
      const mult = this.rush ? 4 : 1;
      if (this.phase === 'approach') {
        const dx = wp.x0 - this.x;
        const dy = wp.y - this.y;
        const dist = Math.hypot(dx, dy);
        // Ease out over ~250ms however far the target is, so a jump across a
        // long file never eats the step's time.
        const sp = Math.max(0.35, wp.speed * 1.6, dist / 250) * dt * mult;
        if (dist <= sp || dist < 1.5) {
          this.x = wp.x0;
          this.y = wp.y;
          this.phase = 'crawl';
          this.ensureVisible(wp.y);
        } else {
          this.x += (dx / dist) * sp;
          this.y += (dy / dist) * sp;
        }
        return;
      }
      this.y = wp.y;
      this.x = Math.min(wp.x1, this.x + wp.speed * dt * mult);
      const span = Math.max(1, wp.x1 - wp.x0);
      if (wp.onProgress) { wp.onProgress(Math.min(1, (this.x - wp.x0) / span)); }
      if (this.x >= wp.x1) {
        this.wp = null;
        this.dwell = this.rush ? 0 : (wp.dwell || 0);
        if (wp.onEnd) { wp.onEnd(); }
      }
    }

    draw(dt) {
      const ctx = this.ctx;
      const scroll = this.vp().scrollTop;
      ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
      if (this.mode === 'code') { this.drawWeb(ctx, scroll, dt); }
      this.drawActive(ctx, scroll);
      this.drawSpider(ctx, scroll, dt);
    }

    drawWeb(ctx, scroll, dt) {
      for (const a of this.web) { a.age += dt * 0.0002; }
      this.web = this.web.filter((a) => a.age < 1);
      for (let i = 1; i < this.web.length; i++) {
        const a = this.web[i - 1];
        const b = this.web[i];
        const alpha = Math.max(0, 0.5 - Math.max(a.age, b.age) * 0.5);
        if (alpha <= 0) { continue; }
        const ay = a.y - scroll;
        const by = b.y - scroll;
        ctx.strokeStyle = this.color;
        ctx.globalAlpha = alpha * (b.op === 'write' ? 1 : 0.5);
        ctx.lineWidth = b.op === 'write' ? 1.1 : 0.8;
        ctx.beginPath();
        ctx.moveTo(a.x, ay);
        ctx.quadraticCurveTo((a.x + b.x) / 2 + 8, (ay + by) / 2 + Math.min(12, Math.abs(by - ay) * 0.25), b.x, by);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // The read/write effect follows the spider: it marks the line from its
    // start up to where the spider has walked.
    drawActive(ctx, scroll) {
      const wp = this.wp;
      if (!wp || this.phase !== 'crawl' || wp.kind !== 'line') { return; }
      const el = this.lineEls[wp.line];
      if (!el) { return; }
      const y = el.offsetTop - scroll;
      const h = el.offsetHeight;
      const x = this.x;
      if (wp.op === 'write') {
        ctx.fillStyle = this.color;
        ctx.globalAlpha = 0.16;
        ctx.fillRect(wp.x0, y, Math.max(0, x - wp.x0), h);
        const blink = 0.5 + 0.5 * Math.sin(performance.now() * 0.012);
        ctx.globalAlpha = 0.4 + 0.5 * blink;
        ctx.fillRect(x - 1, y + 2, 2, h - 4); // caret at the spider
      } else {
        const grad = ctx.createLinearGradient(x - 22, 0, x + 6, 0);
        grad.addColorStop(0, 'rgba(120,170,230,0)');
        grad.addColorStop(1, 'rgba(120,170,230,0.5)');
        ctx.fillStyle = grad;
        ctx.globalAlpha = 1;
        ctx.fillRect(x - 22, y, 28, h);
      }
      ctx.globalAlpha = 1;
    }

    drawSpider(ctx, scroll, dt) {
      const bx = this.x;
      const by = this.y - scroll;
      const vx = this.x - this.prevX;
      const vy = this.y - this.prevY;
      const moving = Math.hypot(vx, vy) > 0.3;
      if (moving) { this.heading = Math.atan2(vy, vx); }
      this.prevX = this.x;
      this.prevY = this.y;

      ctx.strokeStyle = this.color;
      ctx.lineWidth = 1.4;
      ctx.lineCap = 'round';
      for (const f of this.feet) {
        const spread = 9 + f.rank * 6;
        const homeX = bx + f.side * (9 + f.rank * 3);
        const homeY = by + (f.rank - 1.5) * 4.5;
        const targetX = homeX + f.side * spread;
        const targetY = homeY + (f.rank % 2 ? 5 : -5);
        f.step += dt * (moving ? 0.03 : 0.004);
        const lift = moving ? Math.max(0, Math.sin(f.step)) * 3.5 : 0;
        f.x += (targetX - f.x) * Math.min(1, dt / 110);
        f.y += (targetY - f.y) * Math.min(1, dt / 110);
        const kneeX = (homeX + f.x) / 2 + f.side * 4;
        const kneeY = (homeY + (f.y - lift)) / 2 - 4;
        ctx.beginPath();
        ctx.moveTo(homeX, homeY);
        ctx.quadraticCurveTo(kneeX, kneeY, f.x, f.y - lift);
        ctx.stroke();
      }

      const hx = bx + Math.cos(this.heading) * 6;
      const hy = by + Math.sin(this.heading) * 6;
      ctx.save();
      ctx.shadowColor = this.color;
      ctx.shadowBlur = 9;
      ctx.fillStyle = this.color;
      ctx.globalAlpha = 0.92;
      ctx.beginPath();
      ctx.ellipse(bx, by, 4.5, 6, this.heading, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(hx, hy, 2.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      const ox = Math.cos(this.heading + Math.PI / 2) * 1.1;
      const oy = Math.sin(this.heading + Math.PI / 2) * 1.1;
      ctx.beginPath();
      ctx.arc(hx + ox, hy + oy, 0.7, 0, Math.PI * 2);
      ctx.arc(hx - ox, hy - oy, 0.7, 0, Math.PI * 2);
      ctx.fill();
    }

    dispose() {
      clearTimeout(this.captionTimer);
      this.root.remove();
      vscode.postMessage({ type: 'laneClosed', lane: this.key });
    }
  }

  // ---- lanes -------------------------------------------------------------------
  function updateLayout() {
    let visible = 0;
    for (const lane of lanes.values()) {
      const show = !focusAgent || lane.agent === focusAgent;
      lane.root.style.display = show ? '' : 'none';
      if (show) { visible++; }
    }
    lanesEl.setAttribute('data-count', String(Math.min(visible, 4)));
    let empty = document.getElementById('empty');
    if (visible === 0) {
      if (!empty) {
        empty = document.createElement('div');
        empty.id = 'empty';
        empty.innerHTML = '<div class="empty-title">Waiting for agent activity</div>'
          + '<div class="empty-sub">Live reads, edits and searches appear here as agents work. The full history is in the Crawl Map recap.</div>';
        lanesEl.appendChild(empty);
      }
    } else if (empty) {
      empty.remove();
    }
    for (const lane of lanes.values()) { lane.layout(); }
  }

  function closeLane(lane) {
    lane.dispose();
    lanes.delete(lane.key);
    updateLayout();
  }

  function makeRoom() {
    if (lanes.size < MAX_LANES) { return; }
    const all = [...lanes.values()];
    const idle = all.filter((l) => !l.busy());
    const pool = idle.length ? idle : all;
    pool.sort((a, b) => a.lastActive - b.lastActive);
    closeLane(pool[0]);
  }

  function handleStep(step) {
    if (step.agent && !agentsSeen.has(step.agent)) {
      agentsSeen.add(step.agent);
      populateFocus();
    }
    let lane = lanes.get(step.lane);
    if (!lane) {
      makeRoom();
      lane = new Lane(step.lane, step.agent, step.agentId, step.color);
      lanes.set(step.lane, lane);
      updateLayout();
    }
    lane.enqueue(step);
    updateStatus();
  }

  function updateStatus() {
    const live = [...lanes.values()].filter((l) => l.busy()).length;
    const queued = [...lanes.values()].reduce((n, l) => n + l.queue.length, 0);
    statusEl.textContent = lanes.size
      ? `${live} agent(s) live · ${lanes.size} lane(s)${queued ? ` · ${queued} step(s) queued` : ''}`
      : 'waiting for agent activity…';
    document.body.classList.toggle('is-live', live > 0);
  }

  function populateFocus() {
    const want = ['', ...agentsSeen];
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

  // ---- loop ----------------------------------------------------------------------
  let sweepAt = 0;
  function frame(ts) {
    const dt = lastTs ? Math.min(60, ts - lastTs) : 16;
    lastTs = ts;
    for (const lane of lanes.values()) {
      lane.tick(dt);
      if (lane.root.style.display !== 'none') { lane.draw(dt); }
    }
    if (ts > sweepAt) {
      sweepAt = ts + 1000;
      for (const lane of [...lanes.values()]) {
        if (!lane.busy() && ts - lane.lastActive > LANE_TTL_MS) { closeLane(lane); }
      }
      updateStatus();
    }
    requestAnimationFrame(frame);
  }

  focusEl.addEventListener('change', () => { focusAgent = focusEl.value; updateLayout(); });
  window.addEventListener('resize', () => { for (const lane of lanes.values()) { lane.layout(); } });
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg) { return; }
    if (msg.type === 'step' && msg.step) {
      handleStep(msg.step);
    } else if (msg.type === 'reset') {
      for (const lane of [...lanes.values()]) { closeLane(lane); }
      updateStatus();
    }
  });

  applyZoom();
  updateLayout();
  requestAnimationFrame(frame);
  vscode.postMessage({ type: 'ready' });
})();
