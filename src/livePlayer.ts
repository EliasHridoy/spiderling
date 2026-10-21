import { ActivityEvent } from './types';

// Paces live events for the Code Crawl. An agent can read 20 files in one
// burst; the live view can't show 20 files at once, so each agent gets a lane
// that plays its steps one file at a time. The more steps are waiting, the
// faster each one plays, and a lane that falls too far behind drops its oldest
// steps — the live view stays in sync with where the agent is *now*, while the
// Crawl Map recap keeps the complete history.

export interface PlayStep extends ActivityEvent {
  lane: string;
  durationMs: number;
  queued: number; // steps still waiting in this lane
  fromHit?: number; // index into the lane's last search hits this step opened
  hitLine?: number;
}

const BASE_MS: Record<string, number> = { read: 1500, write: 2000, search: 2600 };
const MIN_MS = 350;
const MAX_QUEUE = 24;

interface Lane {
  queue: ActivityEvent[];
  busyUntil: number;
  timer?: ReturnType<typeof setTimeout>;
  lastSearch?: ActivityEvent;
}

export function laneKey(event: ActivityEvent): string {
  return event.agentId || event.agent;
}

export class LivePlayer {
  private readonly lanes = new Map<string, Lane>();

  constructor(private readonly sink: (step: PlayStep) => void) {}

  push(event: ActivityEvent): void {
    if (event.op === 'bash') {
      return; // no file or search to show; it stays in the Crawl Map
    }
    const key = laneKey(event);
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { queue: [], busyUntil: 0 };
      this.lanes.set(key, lane);
    }
    lane.queue.push(event);
    if (lane.queue.length > MAX_QUEUE) {
      lane.queue.splice(0, lane.queue.length - MAX_QUEUE);
    }
    this.pump(key, lane);
  }

  private pump(key: string, lane: Lane): void {
    if (lane.timer) {
      return;
    }
    const now = Date.now();
    if (now < lane.busyUntil) {
      lane.timer = setTimeout(() => {
        lane.timer = undefined;
        this.pump(key, lane);
      }, lane.busyUntil - now);
      return;
    }
    const event = lane.queue.shift();
    if (!event) {
      return;
    }
    const durationMs = Math.max(MIN_MS, Math.round((BASE_MS[event.op] ?? 1500) / (1 + lane.queue.length * 0.6)));
    const step: PlayStep = { ...event, lane: key, durationMs, queued: lane.queue.length };

    if (event.op === 'search') {
      lane.lastSearch = event;
    } else if (lane.lastSearch?.hits?.length) {
      // Did the agent just open something its last search turned up?
      const hits = lane.lastSearch.hits;
      const inRange = (line?: number) => line === undefined || event.startLine === undefined
        || (line >= event.startLine && line <= (event.endLine ?? event.startLine));
      let idx = hits.findIndex((h) => h.file === event.file && inRange(h.line));
      if (idx < 0) {
        idx = hits.findIndex((h) => h.file === event.file);
      }
      if (idx >= 0) {
        step.fromHit = idx;
        step.hitLine = hits[idx].line;
      }
    }

    this.sink(step);
    lane.busyUntil = now + durationMs;
    if (lane.queue.length) {
      this.pump(key, lane);
    }
  }

  clear(): void {
    for (const lane of this.lanes.values()) {
      if (lane.timer) {
        clearTimeout(lane.timer);
      }
    }
    this.lanes.clear();
  }

  dispose(): void {
    this.clear();
  }
}
