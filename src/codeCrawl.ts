import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ActivityEvent } from './types';
import { colorForAgent } from './palette';
import { LivePlayer, PlayStep } from './livePlayer';
import { RecapPlayer, RecapState, SPEEDS, stepToEvent } from './recapPlayer';

// Cap how much of a file we ship into the webview so a huge file can't bloat the
// DOM; the spider crawls the first MAX_LINES lines.
const MAX_LINES = 1200;
const MAX_BYTES = 512 * 1024;

// Owns the single "Code Crawl" webview: one lane per active agent (up to four,
// in a grid). Live steps are paced by the LivePlayer so each lane follows its
// agent file by file; a search shows the query being typed and its hits, and a
// read that opens one of those hits crawls from the hit into the file.
export class CodeCrawlPanel {
  private static current: CodeCrawlPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly player: LivePlayer;
  // Per lane: the file + mtime whose text the webview already has.
  private readonly sent = new Map<string, { file: string; mtime: number }>();
  private ready = false;
  private disposed = false;
  private pending?: PlayStep;
  private recap?: RecapPlayer; // set while a saved session is being played back
  private recapState?: RecapState;
  private recapTitle = '';
  private autoplay = false;

  static show(context: vscode.ExtensionContext, root: vscode.Uri, last?: ActivityEvent): CodeCrawlPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (CodeCrawlPanel.current) {
      CodeCrawlPanel.current.panel.reveal(column);
      return CodeCrawlPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'spiderlingCodeCrawl',
      'Spiderling Code Crawl',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );
    CodeCrawlPanel.current = new CodeCrawlPanel(panel, context, root, last);
    return CodeCrawlPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    private readonly root: vscode.Uri,
    last?: ActivityEvent,
  ) {
    this.player = new LivePlayer((step) => this.send(step));
    this.panel.webview.html = this.html(context.extensionUri);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg?.type === 'ready') {
          this.ready = true;
          this.sent.clear(); // a (re)loaded webview has no file text yet
          if (this.recap) {
            this.postRecap();
            if (this.autoplay) {
              this.autoplay = false;
              this.recap.play();
            }
          }
          if (this.pending) {
            this.send(this.pending);
            this.pending = undefined;
          }
        } else if (msg?.type === 'recap' && this.recap) {
          if (msg.action === 'toggle') {
            this.recap.toggle();
          } else if (msg.action === 'speed' && typeof msg.value === 'number') {
            this.recap.setSpeed(msg.value);
          } else if (msg.action === 'seek' && typeof msg.value === 'number') {
            this.recap.seek(msg.value, () => this.clearLanes());
          } else if (msg.action === 'live') {
            this.stopRecap();
          }
        } else if (msg?.type === 'laneClosed' && typeof msg.lane === 'string') {
          this.sent.delete(msg.lane); // a reopened lane needs the file text again
        } else if (msg?.type === 'open' && typeof msg.file === 'string') {
          const uri = vscode.Uri.file(this.abs(msg.file));
          const line = typeof msg.line === 'number' ? Math.max(0, msg.line - 1) : 0;
          vscode.window.showTextDocument(uri, { preview: true, selection: new vscode.Range(line, 0, line, 0) })
            .then(undefined, () => { /* file gone — ignore */ });
        }
      },
      null,
      this.disposables,
    );
    // Show where the most recent agent was, so the view isn't blank on open.
    if (last && last.op !== 'bash' && last.op !== 'call') {
      this.player.push(last);
    }
  }

  // Only live events are played; replayed history belongs to the recap.
  post(event: ActivityEvent, live: boolean): void {
    if (live && !this.disposed && !this.recap) {
      this.player.push(event);
    }
  }

  // Play a saved session back, step by step, through the same lanes as live.
  // A trace holds paths, ranges and queries but no file text, so files are
  // read as they are today.
  playRecap(steps: unknown[], session: string, title: string): void {
    if (this.disposed) {
      return;
    }
    this.stopRecap(false);
    const events = steps.map((s) => stepToEvent(s as never, session)).filter((e): e is ActivityEvent => !!e);
    this.player.clear();
    this.clearLanes();
    this.recapTitle = title;
    this.recap = new RecapPlayer(events, (step) => this.send(step), (state) => {
      this.recapState = state;
      this.postRecap();
    });
    this.recapState = { index: 0, total: events.length, playing: false, speed: 1 };
    this.postRecap();
    if (this.ready) {
      this.recap.play();
    } else {
      this.autoplay = true;
    }
  }

  private stopRecap(notify = true): void {
    this.recap?.dispose();
    this.recap = undefined;
    this.recapState = undefined;
    this.autoplay = false;
    if (notify && !this.disposed) {
      this.clearLanes();
      this.panel.webview.postMessage({ type: 'recap', on: false });
    }
  }

  private postRecap(): void {
    if (this.recapState && !this.disposed) {
      this.panel.webview.postMessage({ type: 'recap', on: true, title: this.recapTitle, speeds: SPEEDS, ...this.recapState });
    }
  }

  private clearLanes(): void {
    this.pending = undefined;
    this.sent.clear();
    this.panel.webview.postMessage({ type: 'reset' });
  }

  reset(): void {
    if (this.disposed) {
      return;
    }
    this.player.clear();
    this.sent.clear();
    this.panel.webview.postMessage({ type: 'reset' });
  }

  private send(step: PlayStep): void {
    if (!this.ready) {
      this.pending = step;
      return;
    }
    const msg: Record<string, unknown> = { ...step, color: colorForAgent(step.agent) };
    if (step.op !== 'search' && step.op !== 'call') {
      const info = this.readLines(step.file);
      const prev = this.sent.get(step.lane);
      if (!info) {
        msg.unreadable = true;
        this.sent.delete(step.lane);
      } else if (!prev || prev.file !== step.file || prev.mtime !== info.mtime) {
        msg.lines = info.lines;
        this.sent.set(step.lane, { file: step.file, mtime: info.mtime });
      }
    }
    this.panel.webview.postMessage({ type: 'step', step: msg });
  }

  private abs(file: string): string {
    if (file.startsWith('~/')) {
      return path.join(os.homedir(), file.slice(2)); // traces write home-relative paths as ~/…
    }
    return path.isAbsolute(file) ? file : vscode.Uri.joinPath(this.root, file).fsPath;
  }

  private readLines(file: string): { lines: string[]; mtime: number } | undefined {
    try {
      const abs = this.abs(file);
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > MAX_BYTES) {
        return undefined;
      }
      const text = fs.readFileSync(abs, 'utf8');
      if (text.slice(0, 4096).includes('\u0000')) {
        return undefined; // looks binary
      }
      return { lines: text.split(/\r?\n/).slice(0, MAX_LINES), mtime: stat.mtimeMs };
    } catch {
      return undefined;
    }
  }

  private html(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'codecrawl.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'codecrawl.css'));
    const nonce = nonceString();
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${style}" rel="stylesheet" />
  <title>Spiderling Code Crawl</title>
</head>
<body>
  <div id="toolbar">
    <span class="live-dot"></span>
    <span id="status">waiting for agent activity…</span>
    <label class="focus-label">Focus <select id="focus"><option value="">all agents</option></select></label>
    <span id="zoom-controls">
      <button id="zoom-out" title="Zoom out (Ctrl+-)">−</button>
      <span id="zoom-level">100%</span>
      <button id="zoom-in" title="Zoom in (Ctrl++)">+</button>
      <button id="zoom-reset" title="Reset zoom">⤢</button>
    </span>
  </div>
  <div id="recap" class="hidden">
    <button id="r-play" title="Play / pause">⏸</button>
    <select id="r-speed" title="Speed"></select>
    <input id="r-scrub" type="range" min="0" max="0" value="0" />
    <span id="r-pos"></span>
    <span id="r-now"></span>
    <button id="r-live" title="Stop the recap and follow agents live">Live</button>
  </div>
  <div id="lanes"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    CodeCrawlPanel.current = undefined;
    this.player.dispose();
    this.recap?.dispose();
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function nonceString(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
