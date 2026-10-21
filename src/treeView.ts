import * as vscode from 'vscode';
import * as path from 'path';
import { ActivityState } from './activityState';

type Node = AgentNode | FileNode;
interface AgentNode { kind: 'agent'; agent: string; }
interface FileNode { kind: 'file'; agent: string; file: string; }

// The "Spiderling Activity" explorer view: agents at the top level, each expanding to
// the files it has touched (most recent first), with read/write counts.
export class ActivityTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly state: ActivityState,
    private readonly workspaceRoot: vscode.Uri,
  ) {
    state.onDidChange(() => this.changeEmitter.fire());
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'agent') {
      const agent = this.state.getAgents().find((a) => a.agent === node.agent);
      const item = new vscode.TreeItem(node.agent, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('bug');
      item.description = agent ? `${agent.reads}R / ${agent.writes}W` : '';
      item.contextValue = 'spiderlingAgent';
      return item;
    }
    const base = node.file.split('/').pop() ?? node.file;
    const file = this.state.getFiles().find((f) => f.file === node.file);
    const item = new vscode.TreeItem(base, vscode.TreeItemCollapsibleState.None);
    // Transcript events outside the workspace (e.g. a worktree) carry absolute paths.
    item.resourceUri = path.isAbsolute(node.file)
      ? vscode.Uri.file(node.file)
      : vscode.Uri.joinPath(this.workspaceRoot, node.file);
    if (file) {
      item.description = file.lastDetail || node.file;
      item.tooltip = `${node.file}\n${file.reads} read(s), ${file.writes} write(s)`
        + (file.lastDetail ? `\nlast: ${file.lastDetail}` : '');
    } else {
      item.tooltip = node.file;
    }
    item.iconPath = file && file.writes > 0 ? new vscode.ThemeIcon('pencil') : new vscode.ThemeIcon('eye');
    item.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [item.resourceUri],
    };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.state.getAgents().map((a): AgentNode => ({ kind: 'agent', agent: a.agent }));
    }
    if (node.kind === 'agent') {
      const agent = this.state.getAgents().find((a) => a.agent === node.agent);
      if (!agent) {
        return [];
      }
      // Most-recent-first, de-duplicated.
      const seen = new Set<string>();
      const files: FileNode[] = [];
      for (let i = agent.trail.length - 1; i >= 0; i--) {
        const f = agent.trail[i];
        if (!seen.has(f)) {
          seen.add(f);
          files.push({ kind: 'file', agent: node.agent, file: f });
        }
      }
      return files;
    }
    return [];
  }
}
