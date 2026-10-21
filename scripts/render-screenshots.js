#!/usr/bin/env node
'use strict';

// Regenerates docs/images/*.png from the fictional demo trace with a headless
// Chrome/Chromium: the replay page, its Flow tab, and the live Code Crawl.
//
//   npm run compile && node scripts/render-screenshots.js
//
// Needs Chrome or Chromium (set CHROME_BIN if it is not on the PATH).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const media = path.join(root, 'media');
const outDir = path.join(root, 'docs', 'images');
const demo = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'demo-trace.json'), 'utf8'));
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

function findChrome() {
  const candidates = [process.env.CHROME_BIN, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) { return c; }
  }
  throw new Error('No Chrome/Chromium found. Set CHROME_BIN.');
}

const chrome = findChrome();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spiderling-shots-'));

function shoot(name, html, { width, height, budgetMs }) {
  const page = path.join(tmp, `${name}.html`);
  fs.writeFileSync(page, html);
  const png = path.join(outDir, `${name}.png`);
  const r = spawnSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--window-size=${width},${height}`, `--virtual-time-budget=${budgetMs}`, `--screenshot=${png}`, `file://${page}`,
  ], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(png)) { throw new Error(`screenshot ${name} failed: ${r.stderr}`); }
  console.log(`docs/images/${name}.png`);
}

// ---- replay page (the same page the exported HTML uses) ---------------------------
const replaySrc = read('out', 'replay.js');
const body = /const BODY = `([\s\S]*?)`;/.exec(replaySrc)[1];
const data = JSON.stringify(demo).replace(/</g, '\\u003c');
function replayPage(stepIndex, tab) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${read('media', 'replay.css')}</style></head><body>${body}
<script>window.__TRACE__=${data};</script><script>${read('media', 'traceAnalysis.js')}</script><script>${read('media', 'replay.js')}</script>
<script>setTimeout(()=>{const s=document.getElementById('scrub');s.value=${stepIndex};s.dispatchEvent(new Event('input'));${tab === 'flow' ? "document.querySelector('#tabs button[data-tab=flow]').click();" : ''}},60);</script></body></html>`;
}

// ---- live code crawl --------------------------------------------------------------------
const INVOICE = `import { applyVat, type Money } from './pricing';

export interface LineItem {
  sku: string;
  quantity: number;
  unitPrice: Money;
}

export interface Invoice {
  id: string;
  items: LineItem[];
  discount: number; // 0..1
  vatRate: number; // 0..1
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function subtotal(items: LineItem[]): Money {
  return items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
}

export function calculateTotal(invoice: Invoice): Money {
  const gross = subtotal(invoice.items);
  const discounted = gross * (1 - invoice.discount);
  const withVat = applyVat(discounted, invoice.vatRate);
  // round once, at the end
  return round2(withVat);
}

export function describe(invoice: Invoice): string {
  const total = calculateTotal(invoice).toFixed(2);
  return \`Invoice \${invoice.id}: \${invoice.items.length} item(s), total \${total}\`;
}

export function isPaidInFull(invoice: Invoice, paid: Money): boolean {
  return paid >= calculateTotal(invoice);
}
`.split('\n');

function crawlPage() {
  const steps = [
    { lane: 'implementor:i4c5d6', agent: 'implementor', agentId: 'i4c5d6', color: '#f58231', op: 'search', tool: 'grep', file: 'src', query: 'calculateTotal', durationMs: 2600, detail: 'grep "calculateTotal" → 4 hit(s) in 2 file(s)',
      caption: 'Find every caller of calculateTotal before changing it.', hitCount: 4,
      hits: [
        { file: 'src/orders/invoice.ts', line: 22, text: 'export function calculateTotal(invoice: Invoice): Money {' },
        { file: 'src/orders/invoice.ts', line: 31, text: 'const total = calculateTotal(invoice).toFixed(2);' },
        { file: 'src/orders/invoice.ts', line: 36, text: 'return paid >= calculateTotal(invoice);' },
        { file: 'src/orders/invoice.test.ts', line: 14, text: 'expect(calculateTotal(invoice)).toBe(120);' },
      ] },
    { lane: 'reviewer:r7e8f9', agent: 'reviewer', agentId: 'r7e8f9', color: '#3cb44b', op: 'write', tool: 'Edit', file: 'src/orders/invoice.ts', startLine: 22, endLine: 29, durationMs: 9000,
      detail: 'edited 8 line(s) @ line 22', caption: 'Apply the VAT after the discount, and round once.', lines: INVOICE },
  ];
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="file://${path.join(media, 'codecrawl.css')}">
<style>:root{--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#d4d4d4;--vscode-sideBar-background:#252526;--vscode-panel-border:#3c3c3c;--vscode-input-background:#3c3c3c;--vscode-textLink-foreground:#3794ff;--vscode-font-family:system-ui,sans-serif;--vscode-editor-font-family:ui-monospace,monospace}</style></head>
<body><div id="toolbar"><span class="live-dot"></span><span id="status"></span><label class="focus-label">Focus <select id="focus"><option value="">all agents</option></select></label><span id="zoom-controls"><button id="zoom-out">−</button><span id="zoom-level">100%</span><button id="zoom-in">+</button><button id="zoom-reset">⤢</button></span></div><div id="lanes"></div>
<script>window.requestAnimationFrame=(cb)=>setTimeout(()=>cb(performance.now()),16);window.acquireVsCodeApi=()=>({postMessage:()=>{}});</script>
<script>${read('media', 'codecrawl.js').replace('Math.min(60, ts - lastTs)', 'Math.min(1000, ts - lastTs)')}</script>
<script>const S=${JSON.stringify(steps)};S.forEach((s,i)=>setTimeout(()=>window.postMessage({type:'step',step:s},'*'),i*10));</script></body></html>`;
}

fs.mkdirSync(outDir, { recursive: true });
const steps = demo.sessions['demo-session-0001'].steps;
shoot('replay', replayPage(steps.findIndex((s) => s.symbol === 'calculateTotal' && s.op === 'write'), 'steps'), { width: 1360, height: 860, budgetMs: 2500 });
shoot('flow', replayPage(steps.length - 1, 'flow'), { width: 1360, height: 860, budgetMs: 2500 });
shoot('code-crawl', crawlPage(), { width: 1360, height: 560, budgetMs: 6500 });
fs.rmSync(tmp, { recursive: true, force: true });
