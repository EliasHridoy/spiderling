import { ActivityEvent } from './types';
import { BASE_MS, PlayStep, laneKey, linkHit } from './livePlayer';

// Plays a saved trace back through the Code Crawl. Unlike the LivePlayer, which
// follows agents as they work, steps here play strictly in the order they were
// recorded, one at a time, at a speed the viewer picks; each goes to its own
// agent's lane, so the lanes show who was doing what, step by step.

const MIN_MS = 220;
export const SPEEDS = [0.5, 1, 2, 4, 8];

export interface RecapState {
  index: number; // steps played so far
  total: number;
  playing: boolean;
  speed: number;
  current?: { agent: string; op: string; file: string; detail?: string };
}

interface TraceStep {
  t: string;
  agent: string;
  op: string;
  file: string;
  lines?: [number, number];
  detail?: string;
  query?: string;
  hits?: number;
  hitFiles?: string[];
  caption?: string;
  callKind?: string;
  target?: string;
}

// A saved step back into the event the Code Crawl plays. A trace holds paths,
// ranges and queries but never file text, so the viewer reads today's files.
export function stepToEvent(s: TraceStep, session: string): ActivityEvent | undefined {
  if (!s || typeof s.t !== 'string' || typeof s.agent !== 'string' || typeof s.file !== 'string') {
    return undefined;
  }
  if (s.op !== 'read' && s.op !== 'write' && s.op !== 'search' && s.op !== 'call') {
    return undefined; // shell commands have nothing to show
  }
  const colon = s.agent.indexOf(':');
  const agent = colon < 0 ? s.agent : s.agent.slice(0, colon);
  const agentId = colon < 0 ? '' : s.agent.slice(colon + 1);
  const ev: ActivityEvent = {
    ts: s.t, op: s.op, file: s.file, agent, agentId, session, toolUseId: '',
    tool: s.op === 'call' ? (s.detail?.split(' · ')[1] ?? 'call') : (s.detail?.split(/[ "]/)[0] || s.op),
    detail: s.detail, caption: s.caption,
  };
  if (Array.isArray(s.lines)) {
    ev.startLine = s.lines[0];
    ev.endLine = s.lines[1];
    ev.lines = s.lines[1] - s.lines[0] + 1;
  }
  if (s.op === 'search') {
    ev.query = s.query ?? '';
    ev.hitCount = typeof s.hits === 'number' ? s.hits : undefined;
    if (Array.isArray(s.hitFiles)) {
      ev.hits = s.hitFiles.map((file) => ({ file }));
    }
  } else if (s.op === 'call') {
    ev.callKind = s.callKind === 'agent' ? 'agent' : 'mcp';
    ev.target = s.target || s.detail || ev.callKind;
    ev.query = s.query ?? (s.detail ?? '');
  }
  return ev;
}

export class RecapPlayer {
  private i = 0;
  private playing = false;
  private speed = 1;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly lastSearch = new Map<string, ActivityEvent>();

  constructor(
    private readonly events: ActivityEvent[],
    private readonly sink: (step: PlayStep) => void,
    private readonly onState: (state: RecapState) => void,
  ) {}

  get total(): number {
    return this.events.length;
  }

  play(): void {
    if (this.playing) {
      return;
    }
    if (this.i >= this.events.length) {
      this.rewind();
    }
    this.playing = true;
    this.next();
  }

  pause(): void {
    this.playing = false;
    clearTimeout(this.timer);
    this.emit();
  }

  toggle(): void {
    if (this.playing) {
      this.pause();
    } else {
      this.play();
    }
  }

  setSpeed(speed: number): void {
    if (SPEEDS.includes(speed)) {
      this.speed = speed;
      this.emit();
    }
  }

  // Jump to step `index` (0-based); the host resets the lanes first.
  seek(index: number, reset: () => void): void {
    const was = this.playing;
    this.pause();
    reset();
    this.lastSearch.clear();
    this.i = Math.max(0, Math.min(this.events.length, Math.floor(index)));
    if (was) {
      this.play();
    } else {
      this.emit();
    }
  }

  private rewind(): void {
    this.i = 0;
    this.lastSearch.clear();
  }

  private next(): void {
    if (!this.playing) {
      return;
    }
    const event = this.events[this.i];
    if (!event) {
      this.playing = false;
      this.emit();
      return;
    }
    const key = laneKey(event);
    const durationMs = Math.max(MIN_MS, Math.round((BASE_MS[event.op] ?? 1500) / this.speed));
    const step: PlayStep = { ...event, lane: key, durationMs, queued: 0 };
    if (event.op === 'search') {
      this.lastSearch.set(key, event);
    } else {
      linkHit(step, this.lastSearch.get(key));
    }
    this.i++;
    this.sink(step);
    this.emit(event);
    this.timer = setTimeout(() => this.next(), durationMs);
  }

  private emit(event?: ActivityEvent): void {
    const at = event ?? this.events[this.i - 1];
    this.onState({
      index: this.i,
      total: this.events.length,
      playing: this.playing,
      speed: this.speed,
      current: at ? { agent: at.agentId ? `${at.agent} · ${at.agentId.slice(0, 6)}` : at.agent, op: at.op, file: at.file, detail: at.detail } : undefined,
    });
  }

  dispose(): void {
    this.playing = false;
    clearTimeout(this.timer);
  }
}
