import * as vscode from 'vscode';
import { ActivityEvent } from './types';
import { colorForAgent } from './palette';

interface ActiveTouch {
  file: string;
  color: string;
  op: string;
  expiry: number;
}

// A line-drawn spider, stroked in the agent's color, rendered in the gutter of
// any open editor whose file an agent just touched — the literal "spider appears
// on the file". It fades after `decorationTtlMs`. Smooth crawl *animation* lives
// in the webview crawl map; the editor API can only place/decorate, not animate.
export class SpiderDecorations implements vscode.Disposable {
  private readonly byColor = new Map<string, vscode.TextEditorDecorationType>();
  private readonly active = new Map<string, ActiveTouch>(); // key: file path
  private readonly timer: NodeJS.Timeout;
  private enabled: boolean;
  private ttlMs: number;

  constructor(enabled: boolean, ttlMs: number) {
    this.enabled = enabled;
    this.ttlMs = ttlMs;
    // One refresh loop handles both expiry and editors opened after the event.
    this.timer = setInterval(() => this.refresh(), 500);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.active.clear();
    }
    this.refresh();
  }

  setTtl(ms: number): void {
    this.ttlMs = ms;
  }

  onEvent(event: ActivityEvent): void {
    if (!this.enabled) {
      return;
    }
    this.active.set(event.file, {
      file: event.file,
      color: colorForAgent(event.agent),
      op: event.op,
      expiry: Date.now() + this.ttlMs,
    });
    this.refresh();
  }

  private decorationType(color: string): vscode.TextEditorDecorationType {
    let type = this.byColor.get(color);
    if (!type) {
      type = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(spiderDataUri(color)),
        gutterIconSize: 'contain',
        overviewRulerColor: color,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        isWholeLine: true,
        backgroundColor: hexToRgba(color, 0.08),
      });
      this.byColor.set(color, type);
    }
    return type;
  }

  // Rebuild decorations for every visible editor from the current active set,
  // dropping any that have expired.
  private refresh(): void {
    const now = Date.now();
    for (const [file, touch] of this.active) {
      if (touch.expiry <= now) {
        this.active.delete(file);
      }
    }

    for (const editor of vscode.window.visibleTextEditors) {
      const rel = vscode.workspace.asRelativePath(editor.document.uri, false).split('\\').join('/');
      // Clear all our decoration types on this editor, then re-apply the match.
      const touch = this.enabled ? this.active.get(rel) : undefined;
      for (const [color, type] of this.byColor) {
        if (touch && touch.color === color) {
          editor.setDecorations(type, [new vscode.Range(0, 0, 0, 0)]);
        } else {
          editor.setDecorations(type, []);
        }
      }
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const type of this.byColor.values()) {
      type.dispose();
    }
    this.byColor.clear();
    this.active.clear();
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) {
    return hex;
  }
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// A compact line-drawn spider as an inline SVG data URI, stroked in `color`.
function spiderDataUri(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-width="1" stroke-linecap="round">`
    + `<ellipse cx="8" cy="8" rx="2.4" ry="3" fill="${color}" fill-opacity="0.5"/>`
    + `<circle cx="8" cy="4.3" r="1.1" fill="${color}" fill-opacity="0.7"/>`
    // left legs
    + `<path d="M6 6 L2 4 M6 7.5 L1.5 7 M6 9 L2 10.5 M6.3 10.5 L3 13"/>`
    // right legs
    + `<path d="M10 6 L14 4 M10 7.5 L14.5 7 M10 9 L14 10.5 M9.7 10.5 L13 13"/>`
    + `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
