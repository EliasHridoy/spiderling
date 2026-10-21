import * as vscode from 'vscode';
import { ActivityEvent } from './types';
import { colorForAgent } from './palette';

// Owns the single "Crawl Map" webview: an animated canvas where each file is a
// node and each agent is a line-drawn spider crawling between the files it reads
// and writes, trailing silk between recent touches. This is where real animation
// lives (the editor gutter can only place a static glyph).
export class CrawlMapPanel {
  private static current: CrawlMapPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  static show(context: vscode.ExtensionContext, backlog: ActivityEvent[]): CrawlMapPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (CrawlMapPanel.current) {
      CrawlMapPanel.current.panel.reveal(column);
      return CrawlMapPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'spiderlingCrawlMap',
      'Spiderling Crawl Map',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );
    CrawlMapPanel.current = new CrawlMapPanel(panel, context, backlog);
    return CrawlMapPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    backlog: ActivityEvent[],
  ) {
    this.panel.webview.html = this.html(context.extensionUri);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // Replay backlog once the webview signals it is ready to receive.
    this.panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg?.type === 'ready') {
          this.panel.webview.postMessage({ type: 'reset' });
          for (const event of backlog) {
            this.post(event);
          }
        }
      },
      null,
      this.disposables,
    );
  }

  post(event: ActivityEvent): void {
    if (this.disposed) {
      return; // the extension may still hold a closed panel
    }
    this.panel.webview.postMessage({
      type: 'event',
      event: { ...event, color: colorForAgent(event.agent) },
    });
  }

  reset(): void {
    if (!this.disposed) {
      this.panel.webview.postMessage({ type: 'reset' });
    }
  }

  private html(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'crawlmap.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'crawlmap.css'));
    const nonce = nonceString();
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${style}" rel="stylesheet" />
  <title>Spiderling Crawl Map</title>
</head>
<body>
  <div id="toolbar">
    <button id="toggle">⏸ Pause</button>
    <span class="zoom">
      <button id="zoom-out" title="Zoom out">−</button>
      <span id="zoom-level">100%</span>
      <button id="zoom-in" title="Zoom in">+</button>
      <button id="zoom-reset" title="Reset view">⤢</button>
    </span>
    <button id="recap-toggle" title="Toggle flow recap">☰ Recap</button>
    <label class="focus-label">Focus <select id="focus"><option value="">all agents</option></select></label>
    <span id="legend"></span>
    <span id="stats"></span>
  </div>
  <div id="stage">
    <canvas id="canvas"></canvas>
    <aside id="recap" class="hidden">
      <div id="recap-title">Flow recap</div>
      <div id="recap-body"></div>
    </aside>
  </div>
  <div id="ticker"></div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    CrawlMapPanel.current = undefined;
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
