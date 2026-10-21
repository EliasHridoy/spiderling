import * as vscode from 'vscode';
import * as path from 'path';
import { ActivityEvent } from './types';
import { ActivityState } from './activityState';
import { SpiderDecorations } from './decorations';
import { CrawlMapPanel } from './crawlMap';
import { CodeCrawlPanel } from './codeCrawl';
import { ActivityTreeProvider } from './treeView';
import { SessionWatcher } from './transcript/sessionWatcher';
import { ReplayPanel, findTraceFiles, readTrace, traceFolderFor } from './replay';

// How many recent events to retain so a crawl map opened mid-run can replay the
// whole recap instead of starting blank.
const BACKLOG_MAX = 5000;
const POLL_MS = 700;

function config() {
  return vscode.workspace.getConfiguration('spiderling');
}

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }
  const root = folder.uri;
  const output = vscode.window.createOutputChannel('Spiderling');

  const state = new ActivityState(config().get<number>('trailLength', 8));
  const decorations = new SpiderDecorations(
    config().get<boolean>('showDecorations', true),
    config().get<number>('decorationTtlMs', 4000),
  );
  const backlog: ActivityEvent[] = [];
  let crawlMap: CrawlMapPanel | undefined;
  let codeCrawl: CodeCrawlPanel | undefined;
  let lastEvent: ActivityEvent | undefined;

  // Stay silent in workspaces no agent has worked in: the status bar item only
  // appears once there is activity to show.
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'spiderling.openCodeCrawl';
  statusBar.tooltip = 'Open the Spiderling Code Crawl';
  const refreshStatusBar = () => {
    if (state.totalFiles() === 0) {
      statusBar.hide();
      return;
    }
    statusBar.text = `$(bug) ${state.activeAgentCount()} agent(s) · ${state.totalFiles()} file(s)`;
    statusBar.show();
  };
  refreshStatusBar();
  state.onDidChange(refreshStatusBar);

  const treeProvider = new ActivityTreeProvider(state, root);
  const treeView = vscode.window.createTreeView('spiderlingActivity', { treeDataProvider: treeProvider });

  const onEvent = (event: ActivityEvent, live: boolean) => {
    if (event.op === 'call') {
      codeCrawl?.post(event, live); // MCP / subagent calls have no file: live view and trace only
      return;
    }
    state.apply(event);
    // Gutter markers only for what is happening now, not replayed history.
    if (live && (event.op === 'read' || event.op === 'write')) {
      decorations.onEvent(event);
    }

    backlog.push(event);
    while (backlog.length > BACKLOG_MAX) {
      backlog.shift();
    }
    if (event.op !== 'bash') {
      lastEvent = event;
    }
    crawlMap?.post(event);
    codeCrawl?.post(event, live);

    if (live && event.op === 'write' && config().get<boolean>('autoRevealOnWrite', false)) {
      const uri = path.isAbsolute(event.file) ? vscode.Uri.file(event.file) : vscode.Uri.joinPath(root, event.file);
      vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true }).then(
        undefined,
        () => { /* file may not exist on disk (e.g. deleted) — ignore */ },
      );
    }
  };

  // The agents' own session logs (Claude Code transcripts, Codex rollouts,
  // Antigravity conversations): full detail with shell reads/searches, exact
  // line ranges, captions and tokens. Nothing needs installing in the agents.
  const watcher = new SessionWatcher({
    root: root.fsPath,
    lookbackMs: Math.max(0, config().get<number>('sessionLookbackMinutes', 60)) * 60_000,
    pollMs: POLL_MS,
    sources: config().get<string[]>('agentSources', ['claude', 'codex', 'antigravity']),
    symbols: config().get<boolean>('resolveSymbols', true),
    writeTraces: config().get<boolean>('writeTraceFile', true),
    issueDocs: config().get<boolean>('traceNextToIssueDocs', false),
    traceFallbackDir: traceFolderFor(root),
    onEvent,
    onTraceWritten: (file) => output.appendLine(`${new Date().toISOString()}  trace written: ${file}`),
    onError: (message) => output.appendLine(message),
  });

  const RELOAD_SETTINGS = [
    'agentSources', 'sessionLookbackMinutes', 'writeTraceFile', 'resolveSymbols', 'traceFolder', 'traceNextToIssueDocs',
  ].map((s) => `spiderling.${s}`);

  context.subscriptions.push(
    output,
    statusBar,
    treeView,
    decorations,
    state,
    { dispose: () => watcher.dispose() },
    vscode.commands.registerCommand('spiderling.openCrawlMap', () => {
      crawlMap = CrawlMapPanel.show(context, backlog);
    }),
    vscode.commands.registerCommand('spiderling.openCodeCrawl', () => {
      codeCrawl = CodeCrawlPanel.show(context, root, lastEvent);
    }),
    vscode.commands.registerCommand('spiderling.playRecap', async () => {
      const files = await findTraceFiles(root);
      if (!files.length) {
        vscode.window.showInformationMessage('Spiderling: no agent traces yet. They appear in .spiderling/traces/ once an agent has run here.');
        return;
      }
      const traceFile = files.length === 1 ? files[0] : (await vscode.window.showQuickPick(
        files.map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u })),
        { placeHolder: 'Pick a trace to play back' },
      ))?.uri;
      const doc = traceFile && readTrace(traceFile) as { sessions?: Record<string, { title?: string; startedAt?: string; steps?: unknown[] }> } | undefined;
      const sessions = Object.entries(doc?.sessions ?? {}).filter(([, s]) => s.steps?.length);
      if (!sessions.length) {
        if (traceFile) {
          vscode.window.showInformationMessage('Spiderling: that trace has no steps to play.');
        }
        return;
      }
      const [id, session] = sessions.length === 1 ? sessions[0] : ((await vscode.window.showQuickPick(
        sessions.map((e) => ({ label: e[1].title || e[0].slice(0, 8), description: `${e[1].steps?.length} steps · ${e[1].startedAt ?? ''}`, entry: e })),
        { placeHolder: 'Pick a session to play back' },
      ))?.entry ?? [undefined, undefined]);
      if (!id || !session) {
        return;
      }
      codeCrawl = CodeCrawlPanel.show(context, root);
      codeCrawl.playRecap(session.steps ?? [], id, session.title || id.slice(0, 8));
    }),
    vscode.commands.registerCommand('spiderling.openTraceReplay', () => ReplayPanel.show(context, root)),
    vscode.commands.registerCommand('spiderling.exportTraceHtml', () => ReplayPanel.exportHtml(context, root)),
    vscode.commands.registerCommand('spiderling.showTraceForSelection', () => ReplayPanel.showForSelection(context, root)),
    vscode.commands.registerCommand('spiderling.copyTraceSummary', () => ReplayPanel.copySummary(context, root)),
    vscode.commands.registerCommand('spiderling.toggleDecorations', async () => {
      const next = !config().get<boolean>('showDecorations', true);
      await config().update('showDecorations', next, vscode.ConfigurationTarget.Workspace);
      decorations.setEnabled(next);
      vscode.window.showInformationMessage(`Spiderling decorations ${next ? 'enabled' : 'disabled'}.`);
    }),
    vscode.commands.registerCommand('spiderling.clearActivity', () => {
      state.clear();
      backlog.length = 0;
      crawlMap?.reset();
      codeCrawl?.reset();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('spiderling.showDecorations')) {
        decorations.setEnabled(config().get<boolean>('showDecorations', true));
      }
      if (e.affectsConfiguration('spiderling.decorationTtlMs')) {
        decorations.setTtl(config().get<number>('decorationTtlMs', 4000));
      }
      if (e.affectsConfiguration('spiderling.trailLength')) {
        state.setTrailLength(config().get<number>('trailLength', 8));
      }
      if (RELOAD_SETTINGS.some((s) => e.affectsConfiguration(s))) {
        vscode.window.showInformationMessage('Spiderling: reload the window to apply the new capture settings.');
      }
    }),
  );
}

export function deactivate(): void {
  // Disposables registered on context.subscriptions are cleaned up by VS Code.
}
