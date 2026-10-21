#!/usr/bin/env node
'use strict';

// Writes examples/demo-trace.json: a small, entirely fictional agent trace
// ("add VAT to invoice totals" in an imaginary shop-api) used for the README
// screenshots and as a sample file for the replay. Nothing in it comes from a
// real project. Run `node examples/make-demo-trace.js` to regenerate it.

const fs = require('fs');
const path = require('path');

let clock = Date.parse('2026-03-04T09:00:00.000Z');
const advance = (s) => { clock += s * 1000; return new Date(clock).toISOString(); };
const steps = [];
const add = (agent, op, file, extra = {}, gapSeconds = 14) => steps.push({ t: advance(gapSeconds), agent, op, file, ...extra });

const MAIN = 'main';
const PLAN = 'planner:p1a2b3';
const IMPL = 'implementor:i4c5d6';
const REV = 'reviewer:r7e8f9';

// --- main session: understand the request ---------------------------------------------
add(MAIN, 'read', 'docs/42/instructions.md', { lines: [1, 38], detail: 'read whole file (38 lines)', caption: 'Let me read the issue first.' });
add(MAIN, 'search', 'src', { query: 'invoice total', hits: 5, hitFiles: ['src/orders/invoice.ts', 'src/orders/pricing.ts', 'src/orders/invoice.test.ts'], detail: 'grep "invoice total" → 5 hit(s) in 3 file(s)', caption: 'Find where invoice totals are calculated.' });
add(MAIN, 'read', 'src/orders/invoice.ts', { lines: [1, 80], detail: 'sed lines 1-80' });
add(MAIN, 'read', 'src/orders/pricing.ts', { lines: [1, 60], detail: 'sed lines 1-60' });
add(MAIN, 'bash', '(bash)', { detail: '$ Hand the issue to the planner' });

// --- planner: write the plan -------------------------------------------------------------
add(PLAN, 'read', 'docs/42/instructions.md', { lines: [1, 38], detail: 'read whole file (38 lines)', caption: 'Reading the acceptance criteria before planning.' }, 30);
add(PLAN, 'search', 'src', { query: 'vat|taxRate', hits: 0, hitFiles: [], detail: 'grep "vat|taxRate" → no hits', caption: 'Is there any existing tax handling?' });
add(PLAN, 'search', 'src', { query: 'calculateTotal', hits: 4, hitFiles: ['src/orders/invoice.ts', 'src/orders/invoice.test.ts'], detail: 'grep "calculateTotal" → 4 hit(s) in 2 file(s)' });
add(PLAN, 'read', 'src/orders/invoice.ts', { lines: [40, 92], detail: 'sed lines 40-92', caption: 'This is the function to change.' });
add(PLAN, 'read', 'src/orders/pricing.ts', { lines: [1, 60], detail: 'sed lines 1-60' });
add(PLAN, 'read', 'src/orders/invoice.test.ts', { lines: [1, 70], detail: 'sed lines 1-70' });
add(PLAN, 'write', 'docs/42/plan.md', { lines: [1, 34], detail: 'created (34 lines)', caption: 'Writing the plan: a pure applyVat helper, then use it in calculateTotal.' }, 40);
add(PLAN, 'write', 'docs/42/plan.md', { lines: [18, 22], detail: 'edited 5 line(s) @ line 18', caption: 'Rounding must happen once, at the end.' }, 25);

// --- implementor: make the change ----------------------------------------------------------
add(IMPL, 'read', 'docs/42/plan.md', { lines: [1, 36], detail: 'read whole file (36 lines)', caption: 'Following the plan.' }, 60);
add(IMPL, 'search', 'src', { query: 'calculateTotal', hits: 4, hitFiles: ['src/orders/invoice.ts', 'src/orders/invoice.test.ts'], detail: 'grep "calculateTotal" → 4 hit(s) in 2 file(s)' });
add(IMPL, 'read', 'src/orders/invoice.ts', { lines: [40, 92], detail: 'sed lines 40-92', symbol: 'calculateTotal' });
add(IMPL, 'write', 'src/orders/pricing.ts', { lines: [61, 74], detail: 'edited 14 line(s) @ line 61', symbol: 'applyVat', caption: 'Add the pure helper first.' }, 35);
add(IMPL, 'write', 'src/orders/invoice.ts', { lines: [52, 61], detail: 'edited 10 line(s) @ line 52', symbol: 'calculateTotal', caption: 'Use it in calculateTotal and round once.' }, 30);
add(IMPL, 'bash', '(bash)', { detail: '$ npm test' }, 20);
add(IMPL, 'read', 'src/orders/invoice.test.ts', { lines: [30, 70], detail: 'sed lines 30-70', caption: 'One test fails: it expects the old total.' }, 12);
add(IMPL, 'read', 'src/orders/invoice.ts', { lines: [48, 66], detail: 'sed lines 48-66', symbol: 'calculateTotal' });
add(IMPL, 'write', 'src/orders/invoice.ts', { lines: [55, 58], detail: 'edited 4 line(s) @ line 55', symbol: 'calculateTotal', caption: 'The VAT was applied before the discount, not after.' }, 25);
add(IMPL, 'write', 'src/orders/invoice.test.ts', { lines: [41, 58], detail: 'edited 18 line(s) @ line 41', symbol: 'invoice totals', caption: 'Update the expected totals and add VAT cases.' }, 40);
add(IMPL, 'bash', '(bash)', { detail: '$ npm test' }, 20);
add(IMPL, 'bash', '(bash)', { detail: '$ npm run lint' }, 15);

// --- reviewer: check it ------------------------------------------------------------------------
add(REV, 'read', 'src/orders/pricing.ts', { lines: [55, 80], detail: 'sed lines 55-80', symbol: 'applyVat', caption: 'Reviewing the new helper.' }, 70);
add(REV, 'read', 'src/orders/invoice.ts', { lines: [45, 70], detail: 'sed lines 45-70', symbol: 'calculateTotal' });
add(REV, 'search', 'src', { query: 'toFixed', hits: 2, hitFiles: ['src/orders/invoice.ts', 'src/reports/summary.ts'], detail: 'grep "toFixed" → 2 hit(s) in 2 file(s)', caption: 'Check nothing else rounds the total.' });
add(REV, 'read', 'src/reports/summary.ts', { lines: [12, 40], detail: 'sed lines 12-40' });
add(REV, 'read', 'src/orders/invoice.ts', { lines: [45, 70], detail: 'sed lines 45-70', symbol: 'calculateTotal' });
add(REV, 'read', 'src/orders/invoice.ts', { lines: [45, 70], detail: 'sed lines 45-70', symbol: 'calculateTotal' });
add(REV, 'read', 'src/orders/invoice.ts', { lines: [45, 70], detail: 'sed lines 45-70', symbol: 'calculateTotal', caption: 'Looks right; the rounding is only done once.' });
add(REV, 'bash', '(bash)', { detail: '$ npm test -- --coverage' }, 20);

// --- ship it -------------------------------------------------------------------------------------------
add(MAIN, 'bash', '(bash)', { detail: '$ git commit -m "feat: add VAT to invoice totals"' }, 45);
add(MAIN, 'bash', '(bash)', { detail: '$ git push' }, 10);
add(MAIN, 'bash', '(bash)', { detail: '$ gh pr create' }, 10);

const agents = [
  { key: MAIN, type: 'main', steps: steps.filter((s) => s.agent === MAIN).length, tokens: { 'claude-opus-5-5': { input: 4200, output: 6100, cacheRead: 410000, cacheCreate: 22000, messages: 14 } } },
  { key: PLAN, type: 'planner', description: 'Plan VAT for invoices', steps: steps.filter((s) => s.agent === PLAN).length, tokens: { 'claude-sonnet-5-5': { input: 3100, output: 5200, cacheRead: 280000, cacheCreate: 18000, messages: 12 } } },
  { key: IMPL, type: 'implementor', description: 'Implement the plan for #42', steps: steps.filter((s) => s.agent === IMPL).length, tokens: { 'claude-sonnet-5-5': { input: 5200, output: 9800, cacheRead: 520000, cacheCreate: 31000, messages: 21 } } },
  { key: REV, type: 'reviewer', description: 'Review the change for #42', steps: steps.filter((s) => s.agent === REV).length, errors: 9, tokens: { 'claude-opus-5-5': { input: 2100, output: 3300, cacheRead: 190000, cacheCreate: 9000, messages: 9 } } },
].map((a) => {
  const mine = steps.filter((s) => s.agent === a.key);
  return { ...a, startedAt: mine[0].t, endedAt: mine[mine.length - 1].t, durationMs: Date.parse(mine[mine.length - 1].t) - Date.parse(mine[0].t) };
});

const tokens = {};
for (const a of agents) {
  for (const [model, t] of Object.entries(a.tokens)) {
    const sum = tokens[model] || (tokens[model] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, messages: 0 });
    for (const k of Object.keys(sum)) sum[k] += t[k];
  }
}

const doc = {
  schema: 'spiderling.agent-trace/v1',
  issue: '42',
  sessions: {
    'demo-session-0001': {
      title: 'Add VAT to invoice totals',
      source: 'claude',
      branch: 'feat/42-invoice-vat',
      redactions: 0,
      startedAt: steps[0].t,
      endedAt: steps[steps.length - 1].t,
      pr: { number: 57, url: 'https://github.com/example/shop-api/pull/57', repository: 'example/shop-api' },
      metrics: { costUSD: 3.42, durationMs: Date.parse(steps[steps.length - 1].t) - Date.parse(steps[0].t), linesAdded: 42, linesRemoved: 9, tokens },
      agents,
      steps,
    },
  },
};

fs.writeFileSync(path.join(__dirname, 'demo-trace.json'), `${JSON.stringify(doc, null, 2)}\n`);
console.log(`demo-trace.json: ${steps.length} steps, ${agents.length} agents`);
