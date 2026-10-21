// Turns the steps of an agent-trace.json session into the things a reviewer
// wants to know: which PHASES the work went through, what led each step (search
// -> the file it opened; the reads behind each edit), what looks like DRIFT, and a
// FLOW of queries -> files read -> files edited.
//
// Pure functions over the trace's own data, no DOM and no VS Code API, so the
// same file runs in the replay page, in the exported HTML, in the extension
// (PR summary) and in tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TraceAnalysis = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GAP_MS = 30 * 60 * 1000; // a longer pause between two steps is idle time

  const typeOf = (agentKey) => String(agentKey || '').split(':')[0];

  // ---- phases -----------------------------------------------------------------

  // What an agent's name says about the phase its steps belong to (the first
  // match wins, so "test-generator" is verification, not implementation).
  const ROLES = [
    ['plan', /planner|architect|story-writer|spec-writer/i],
    ['explore', /researcher|explore/i],
    ['verify', /review|qa\b|tester|test-|e2e|browser|bug-triage|verif|audit/i],
    ['ship', /release|deploy/i], // github-manager is neutral: it starts an issue as well as ships it
    ['implement', /implementor|developer|coder|builder/i],
  ];
  const TEST_CMD = /\b(test|jest|vitest|pytest|playwright|cypress|karma|lint|tsc|typecheck|e2e|build|compile|verify)\b/i;
  const SHIP_CMD = /\bgit (commit|push|merge|tag)\b|\bgh (pr (create|merge)|release)\b/i;
  const PLAN_DOC = /(^|\/)docs\/[^/]+\/(plan|instructions|research|spec)[^/]*\.md$|(^|\/)docs\/stories\//i;

  // Notes and plans are rewritten as they are refined; that is the work, not drift.
  const isDoc = (file) => /\.(md|mdx|txt|rst|adoc)$/i.test(file || '');

  // A path short enough to read in a sentence: workspace-relative paths stay,
  // absolute ones (another repo or worktree) keep their last three segments.
  function shortFile(file) {
    const f = String(file || '');
    if (!/^(\/|~|[A-Za-z]:[\\/])/.test(f)) { return f; }
    const segs = f.split(/[\\/]/).filter(Boolean);
    return segs.length > 3 ? `…/${segs.slice(-3).join('/')}` : f;
  }

  function roleOf(agentKey) {
    const type = typeOf(agentKey);
    for (const [kind, re] of ROLES) {
      if (re.test(type)) { return kind; }
    }
    return null;
  }

  // The phase one step belongs to on its own, or null when it says nothing
  // (an unremarkable shell command): such a step takes its neighbours' phase.
  function classify(step) {
    const role = roleOf(step.agent);
    if (role) { return role; }
    if (step.op === 'bash') {
      const d = step.detail || '';
      if (SHIP_CMD.test(d)) { return 'ship'; }
      return TEST_CMD.test(d) ? 'verify' : null;
    }
    if (step.op === 'write') { return PLAN_DOC.test(step.file || '') ? 'plan' : 'implement'; }
    if (step.op === 'read' || step.op === 'search') { return 'explore'; }
    return null;
  }

  const MIN_PHASE_STEPS = { ship: 2, verify: 3 };
  const DEFAULT_MIN_STEPS = 4;
  const MAX_PHASES = 14;
  const SANDWICH_MS = 15 * 60 * 1000;
  const SMOOTH = 3; // look this many steps each way to vote on a step's phase

  // How strongly a step speaks for its phase. Edits and explicit test/commit
  // commands are deliberate; reads and searches happen in every phase.
  function weight(step, kind, explicit) {
    if (!explicit) { return 0.5; } // took its neighbours' phase
    if (roleOf(step.agent)) { return 1; } // the agent's name, not what this step did
    if (step.op === 'bash' && (kind === 'verify' || kind === 'ship')) { return 3; }
    if (step.op === 'write') { return 2; }
    return 1;
  }

  function activeMs(steps, from, to) {
    let ms = 0;
    for (let i = from; i < to; i++) {
      const d = Date.parse(steps[i + 1].t) - Date.parse(steps[i].t);
      if (d > 0 && d <= GAP_MS) { ms += d; }
    }
    return ms;
  }

  function phases(steps) {
    const n = steps.length;
    if (!n) { return []; }

    const raw = [];
    const w = [];
    let last = 'explore';
    for (let i = 0; i < n; i++) {
      const c = classify(steps[i]);
      if (c) { last = c; }
      raw.push(c || last);
      w.push(weight(steps[i], raw[i], !!c));
    }

    // Agents work in parallel, so steps of different phases interleave in time:
    // each step takes the phase that carries the most weight among the steps
    // around it (its own, on a tie).
    const kinds = new Array(n);
    for (let i = 0; i < n; i++) {
      const score = {};
      for (let j = Math.max(0, i - SMOOTH); j <= Math.min(n - 1, i + SMOOTH); j++) {
        score[raw[j]] = (score[raw[j]] || 0) + w[j];
      }
      let best = raw[i];
      for (const k of Object.keys(score)) {
        if (score[k] > score[best]) { best = k; }
      }
      kinds[i] = best;
    }

    let runs = [];
    for (let i = 0; i < n; i++) {
      const r = runs[runs.length - 1];
      if (r && r.kind === kinds[i]) { r.to = i; } else { runs.push({ kind: kinds[i], from: i, to: i }); }
    }

    const size = (r) => r.to - r.from + 1;
    const minOf = (r) => MIN_PHASE_STEPS[r.kind] || DEFAULT_MIN_STEPS;
    const fuse = () => {
      const out = [];
      for (const r of runs) {
        const p = out[out.length - 1];
        if (p && p.kind === r.kind) { p.to = r.to; } else { out.push({ ...r }); }
      }
      runs = out;
    };
    // Fold the smallest too-short run into its larger neighbour until none is left.
    const foldShortest = (onlyShort) => {
      let idx = -1;
      for (let i = 0; i < runs.length; i++) {
        if ((!onlyShort || size(runs[i]) < minOf(runs[i])) && (idx < 0 || size(runs[i]) < size(runs[idx]))) { idx = i; }
      }
      if (idx < 0 || runs.length < 2) { return false; }
      const prev = runs[idx - 1];
      const next = runs[idx + 1];
      const into = !next || (prev && size(prev) >= size(next)) ? prev : next;
      into.from = Math.min(into.from, runs[idx].from);
      into.to = Math.max(into.to, runs[idx].to);
      runs.splice(idx, 1);
      fuse();
      return true;
    };
    while (foldShortest(true)) { /* keep folding */ }
    // A brief look around between two stretches of the same work is part of that
    // work, not a phase of its own (implementing is read-edit-read-edit).
    for (let i = 1; i < runs.length - 1; ) {
      const r = runs[i];
      if (r.kind === 'explore' && runs[i - 1].kind === runs[i + 1].kind && runs[i - 1].kind !== 'explore'
          && activeMs(steps, r.from, r.to) < SANDWICH_MS) {
        runs.splice(i, 1);
        fuse();
        i = Math.max(1, i - 1);
      } else {
        i++;
      }
    }
    while (runs.length > MAX_PHASES && foldShortest(false)) { /* cap the count */ }

    return runs.map((r) => {
      const slice = steps.slice(r.from, r.to + 1);
      const tally = (op) => slice.filter((s) => s.op === op).length;
      const touched = {};
      for (const s of slice) {
        if (s.op === 'write' || s.op === 'read') {
          touched[s.file] = (touched[s.file] || 0) + (s.op === 'write' ? 3 : 1);
        }
      }
      return {
        kind: r.kind,
        from: r.from,
        to: r.to,
        count: slice.length,
        startedAt: steps[r.from].t,
        endedAt: steps[r.to].t,
        activeMs: activeMs(steps, r.from, r.to),
        reads: tally('read'),
        writes: tally('write'),
        searches: tally('search'),
        commands: tally('bash'),
        agents: [...new Set(slice.map((s) => typeOf(s.agent)))],
        topFiles: Object.entries(touched).sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]),
      };
    });
  }

  // ---- what led each step -------------------------------------------------------

  const RECENT_SEARCHES = 12;
  const MAX_CONTEXT_READS = 8;

  // opened:  a read/edit of a file that an earlier search by the same agent found
  //          -> { search, step, file }
  // context: for every edit, the files the agent read (and the searches it ran)
  //          since its previous edit -> { write, file, reads: [{step, file}], searches: [step] }
  function edges(steps) {
    const opened = [];
    const context = [];
    const recent = new Map(); // agent -> recent searches [{idx, files}]
    const sinceWrite = new Map(); // agent -> { reads: [{step,file}], searches: [idx] }
    const bucket = (a) => {
      let b = sinceWrite.get(a);
      if (!b) { b = { reads: [], searches: [] }; sinceWrite.set(a, b); }
      return b;
    };
    steps.forEach((s, i) => {
      const a = s.agent;
      if (s.op === 'search') {
        const list = recent.get(a) || [];
        list.push({ idx: i, files: new Set(s.hitFiles || []) });
        if (list.length > RECENT_SEARCHES) { list.shift(); }
        recent.set(a, list);
        bucket(a).searches.push(i);
      } else if (s.op === 'read' || s.op === 'write') {
        const list = recent.get(a) || [];
        for (let k = list.length - 1; k >= 0; k--) {
          if (list[k].files.has(s.file)) { opened.push({ search: list[k].idx, step: i, file: s.file }); break; }
        }
        const b = bucket(a);
        if (s.op === 'read') {
          b.reads.push({ step: i, file: s.file });
        } else {
          const seen = new Set();
          const reads = [];
          for (let k = b.reads.length - 1; k >= 0 && reads.length < MAX_CONTEXT_READS; k--) {
            if (!seen.has(b.reads[k].file)) { seen.add(b.reads[k].file); reads.push(b.reads[k]); }
          }
          context.push({ write: i, file: s.file, reads: reads.reverse(), searches: b.searches.slice(-3) });
          sinceWrite.set(a, { reads: [], searches: [] });
        }
      }
    });
    return { opened, context };
  }

  // ---- drift signals --------------------------------------------------------------

  function fmtDur(ms) {
    if (!ms || ms < 1000) { return '0s'; }
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
  }

  const label = (agents, key) => {
    const a = (agents || []).find((x) => x.key === key);
    return a ? (a.description ? `${a.type} (${a.description})` : a.type) : typeOf(key);
  };

  // Things worth a second look. Not verdicts: a file read many times may be a
  // legitimately central one; these only point at where to look.
  function drift(steps, agents) {
    const out = [];
    const add = (f) => out.push(f);

    // the same file read again and again by one agent
    const reads = new Map();
    steps.forEach((s, i) => {
      if (s.op !== 'read') { return; }
      const k = `${s.agent}\u0000${s.file}`;
      const e = reads.get(k) || { agent: s.agent, file: s.file, steps: [] };
      e.steps.push(i);
      reads.set(k, e);
    });
    for (const e of reads.values()) {
      if (e.steps.length >= 4) {
        add({ kind: 'reread', level: e.steps.length >= 8 ? 'warn' : 'info', count: e.steps.length, title: `Read ${shortFile(e.file)} ${e.steps.length} times`, detail: label(agents, e.agent), steps: e.steps });
      }
    }

    // a file edited many times, and the same lines rewritten
    const writes = new Map();
    steps.forEach((s, i) => {
      if (s.op !== 'write' || isDoc(s.file)) { return; }
      const e = writes.get(s.file) || { file: s.file, steps: [], ranges: [], overlaps: [] };
      if (s.lines) {
        if (e.ranges.some((r) => s.lines[0] <= r[1] && s.lines[1] >= r[0])) { e.overlaps.push(i); }
        e.ranges.push(s.lines);
      }
      e.steps.push(i);
      writes.set(s.file, e);
    });
    for (const e of writes.values()) {
      if (e.steps.length >= 4) {
        add({ kind: 'churn', level: e.steps.length >= 7 ? 'warn' : 'info', count: e.steps.length, title: `Edited ${shortFile(e.file)} ${e.steps.length} times`, detail: `${new Set(e.steps.map((i) => typeOf(steps[i].agent))).size} agent(s)`, steps: e.steps });
      }
      if (e.overlaps.length >= 2) {
        add({ kind: 'rewrite', level: 'warn', count: e.overlaps.length + 1, title: `The same lines of ${shortFile(e.file)} were rewritten ${e.overlaps.length + 1} times`, detail: 'overlapping edits', steps: e.overlaps });
      }
    }

    // searching blind: a run of searches that found nothing / the same search again
    const byAgent = new Map();
    steps.forEach((s, i) => {
      if (s.op !== 'search') { return; }
      const e = byAgent.get(s.agent) || { run: [], runs: [], queries: new Map() };
      if (s.hits === 0) { e.run.push(i); } else { if (e.run.length >= 4) { e.runs.push(e.run); } e.run = []; }
      const q = String(s.query || '').trim().toLowerCase();
      if (q) { e.queries.set(q, [...(e.queries.get(q) || []), i]); }
      byAgent.set(s.agent, e);
    });
    for (const [agent, e] of byAgent) {
      if (e.run.length >= 4) { e.runs.push(e.run); }
      for (const run of e.runs) {
        add({ kind: 'blind', level: 'info', count: run.length, title: `${run.length} searches in a row found nothing`, detail: label(agents, agent), steps: run });
      }
      for (const [q, idxs] of e.queries) {
        if (idxs.length >= 3) {
          add({ kind: 'repeat', level: 'info', count: idxs.length, title: `Searched for "${q.slice(0, 40)}" ${idxs.length} times`, detail: label(agents, agent), steps: idxs });
        }
      }
    }

    // failed tool calls
    for (const a of agents || []) {
      if ((a.errors || 0) >= 8) {
        add({ kind: 'errors', level: a.errors / Math.max(1, a.steps) >= 0.25 ? 'warn' : 'info', count: a.errors, title: `${a.errors} failed tool calls`, detail: label(agents, a.key), steps: [] });
      }
    }

    // time spent waiting (pauses longer than half an hour)
    let idle = 0;
    let gaps = 0;
    for (let i = 1; i < steps.length; i++) {
      const d = Date.parse(steps[i].t) - Date.parse(steps[i - 1].t);
      if (d > GAP_MS) { idle += d; gaps++; }
    }
    if (idle >= 60 * 60 * 1000) {
      add({ kind: 'idle', level: 'info', count: gaps, title: `Idle for ${fmtDur(idle)}`, detail: `${gaps} pause(s) over 30 minutes`, steps: [] });
    }

    const rank = { warn: 0, info: 1 };
    return out.sort((a, b) => rank[a.level] - rank[b.level] || b.count - a.count).slice(0, 12);
  }

  // ---- flow: queries -> files read -> files edited -----------------------------------

  const FLOW_QUERIES = 10;
  const FLOW_READS = 14;
  const FLOW_WRITES = 10;

  function flow(steps, upTo) {
    const upto = steps.slice(0, Math.max(0, upTo + 1));
    const e = edges(upto);
    const readN = new Map();
    const writeN = new Map();
    const symbols = new Map();
    upto.forEach((s) => {
      if (s.op === 'read') { readN.set(s.file, (readN.get(s.file) || 0) + 1); }
      if (s.op === 'write') {
        writeN.set(s.file, (writeN.get(s.file) || 0) + 1);
        if (s.symbol) { symbols.set(s.file, s.symbol); }
      }
    });
    const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    const reads = top(readN, FLOW_READS);
    const writes = top(writeN, FLOW_WRITES);
    const readSet = new Set(reads.map((r) => r[0]));
    const writeSet = new Set(writes.map((w) => w[0]));

    // queries ranked by how many files they led the agent to
    const led = new Map();
    for (const o of e.opened) { led.set(o.search, (led.get(o.search) || 0) + 1); }
    const queries = top(led, FLOW_QUERIES).map(([idx, n]) => ({ id: `q${idx}`, idx, n, label: upto[idx].query || upto[idx].detail || 'search' }));
    const queryIds = new Set(queries.map((q) => q.id));

    const weights = new Map();
    const link = (from, to, kind) => {
      const k = `${from}\u0000${to}\u0000${kind}`;
      weights.set(k, (weights.get(k) || 0) + 1);
    };
    for (const o of e.opened) {
      const from = `q${o.search}`;
      if (!queryIds.has(from)) { continue; }
      if (upto[o.step].op === 'read' && readSet.has(o.file)) { link(from, `r:${o.file}`, 'opened'); }
      else if (upto[o.step].op === 'write' && writeSet.has(o.file)) { link(from, `w:${o.file}`, 'opened'); }
    }
    for (const c of e.context) {
      if (!writeSet.has(c.file)) { continue; }
      for (const r of c.reads) {
        if (readSet.has(r.file)) { link(`r:${r.file}`, `w:${c.file}`, 'context'); }
      }
    }
    return {
      queries,
      reads: reads.map(([file, n]) => ({ id: `r:${file}`, file, n })),
      writes: writes.map(([file, n]) => ({ id: `w:${file}`, file, n, symbol: symbols.get(file) })),
      links: [...weights.entries()].map(([k, w]) => { const [from, to, kind] = k.split('\u0000'); return { from, to, kind, w }; }),
    };
  }

  // ---- PR summary ------------------------------------------------------------------------

  const PHASE_LABEL = { explore: 'explore', plan: 'plan', implement: 'implement', verify: 'verify', ship: 'ship' };

  // A short markdown summary of one session, for pasting into a PR description.
  function markdown(doc, sessionId) {
    const ids = Object.keys((doc && doc.sessions) || {});
    const id = sessionId && doc.sessions[sessionId] ? sessionId : ids[ids.length - 1];
    const s = id && doc.sessions[id];
    if (!s) { return ''; }
    const steps = s.steps || [];
    const m = s.metrics || {};
    const ph = phases(steps);
    const dr = drift(steps, s.agents || []);
    const tok = Object.values(m.tokens || {}).reduce((n, t) => n + t.input + t.output, 0);
    const lines = [];
    lines.push(`### Agent trace${doc.issue ? ` for #${doc.issue}` : ''}${s.title ? `: ${s.title}` : ''}`);
    const facts = [
      s.source ? `${s.source}` : '',
      `${(s.agents || []).length} agent(s)`,
      `${steps.length} steps`,
      m.durationMs ? fmtDur(m.durationMs) : '',
      m.costUSD != null ? `$${m.costUSD.toFixed(2)}` : '',
      tok ? `${tok >= 1e6 ? `${(tok / 1e6).toFixed(1)}M` : `${Math.round(tok / 1e3)}k`} tokens` : '',
      m.linesAdded != null ? `+${m.linesAdded} / -${m.linesRemoved || 0} lines` : '',
    ].filter(Boolean);
    lines.push(facts.join(' · '));
    if (ph.length) {
      lines.push('');
      lines.push(`**Phases:** ${ph.map((p) => `${PHASE_LABEL[p.kind]} ${fmtDur(p.activeMs) === '0s' ? `${p.count} steps` : fmtDur(p.activeMs)}`).join(' → ')}`);
    }
    const edited = new Map();
    for (const st of steps) {
      if (st.op !== 'write') { continue; }
      const e = edited.get(st.file) || { n: 0, symbols: new Set() };
      e.n++;
      if (st.symbol) { e.symbols.add(st.symbol); }
      edited.set(st.file, e);
    }
    if (edited.size) {
      lines.push('');
      lines.push(`**Edited ${edited.size} file(s):**`);
      for (const [file, e] of [...edited.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 8)) {
        const sym = e.symbols.size ? `, in ${[...e.symbols].slice(0, 3).map((x) => `\`${x}\``).join(', ')}` : '';
        lines.push(`- \`${shortFile(file)}\` (${e.n} edit${e.n === 1 ? '' : 's'}${sym})`);
      }
    }
    const worth = dr.filter((d) => d.level === 'warn').concat(dr.filter((d) => d.level !== 'warn')).slice(0, 5);
    if (worth.length) {
      lines.push('');
      lines.push('**Worth a look:**');
      for (const d of worth) { lines.push(`- ${d.title}${d.detail ? ` (${d.detail})` : ''}`); }
    }
    return lines.join('\n');
  }

  return { GAP_MS, typeOf, shortFile, roleOf, classify, phases, edges, drift, flow, markdown, fmtDur };
});
