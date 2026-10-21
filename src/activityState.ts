import * as vscode from 'vscode';
import { ActivityEvent } from './types';

export interface AgentState {
  agent: string;
  currentFile: string;
  trail: string[]; // most-recent-last list of files this agent touched
  reads: number;
  writes: number;
  lastSeen: number; // epoch ms
}

export interface FileState {
  file: string;
  reads: number;
  writes: number;
  agents: Set<string>;
  lastDetail: string; // e.g. "read lines 1-200", "edited 5 line(s) @ line 42"
}

// In-memory rollup of the event stream, shared by the tree view, status bar and
// crawl map. It keeps a bounded trail per agent and never holds raw event history.
export class ActivityState {
  private readonly agents = new Map<string, AgentState>();
  private readonly files = new Map<string, FileState>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private trailLength: number) {}

  setTrailLength(n: number): void {
    this.trailLength = Math.max(1, n);
  }

  apply(event: ActivityEvent): void {
    const agent = this.agents.get(event.agent) ?? {
      agent: event.agent,
      currentFile: '',
      trail: [],
      reads: 0,
      writes: 0,
      lastSeen: 0,
    };
    agent.currentFile = event.file;
    agent.lastSeen = Date.parse(event.ts) || Date.now();
    if (event.op === 'write') {
      agent.writes++;
    } else {
      agent.reads++; // read / search / bash all count as "inspecting"
    }
    // Keep the trail compact and free of immediate repeats.
    if (agent.trail[agent.trail.length - 1] !== event.file) {
      agent.trail.push(event.file);
      while (agent.trail.length > this.trailLength) {
        agent.trail.shift();
      }
    }
    this.agents.set(event.agent, agent);

    const file = this.files.get(event.file) ?? {
      file: event.file,
      reads: 0,
      writes: 0,
      agents: new Set<string>(),
      lastDetail: '',
    };
    if (event.op === 'write') {
      file.writes++;
    } else {
      file.reads++;
    }
    file.agents.add(event.agent);
    if (event.detail) {
      file.lastDetail = event.detail;
    }
    this.files.set(event.file, file);

    this.changeEmitter.fire();
  }

  getAgents(): AgentState[] {
    return [...this.agents.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  getFiles(): FileState[] {
    return [...this.files.values()];
  }

  totalFiles(): number {
    return this.files.size;
  }

  // Agents considered "active": seen within the window.
  activeAgentCount(windowMs = 15000): number {
    const cutoff = Date.now() - windowMs;
    return this.getAgents().filter((a) => a.lastSeen >= cutoff).length;
  }

  clear(): void {
    this.agents.clear();
    this.files.clear();
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
