import { ActivityEvent } from '../types';
import { attributeHits, parseBash } from './bashParse';
import { EventBuilder, oneLine } from './common';

// Turns the shell commands an agent ran into activity events: what they read
// (`sed -n`, `cat`, `head`), wrote (`>`, `tee`, `sed -i`) and searched (`grep`,
// `rg`, `find`, with the hits found in the command's output). Shared by every
// agent, because they all navigate code mostly through the shell.
export interface ShellCommand {
  command: string;
  cwd: string; // directory it ran in (relative paths resolve against it)
}

export function shellEvents(
  b: EventBuilder,
  cmds: ShellCommand[],
  stdout: string,
  failed: boolean,
  toolUseId: string,
  ts: string,
  description = '',
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const actions = cmds.flatMap((c) => parseBash(c.command, c.cwd)).filter((a) => !b.isNoise(a.file));
  const searches = actions.filter((a) => a.kind === 'search');
  const hitsBySearch = attributeHits(stdout, searches, cmds[0]?.cwd ?? b.root);
  for (const a of actions) {
    if (a.kind === 'search') {
      const hits = hitsBySearch[searches.indexOf(a)].filter((h) => !b.isNoise(h.file));
      events.push(b.search(a.tool, a.file, a.query ?? '', hits, toolUseId, ts, a.detail));
    } else if (!failed) {
      const ev = b.base(a.kind, a.tool, a.file, toolUseId, ts);
      ev.startLine = a.startLine;
      ev.endLine = a.endLine;
      ev.detail = a.detail;
      events.push(ev);
    }
  }
  if (!events.length && cmds.length) {
    const ev = b.base('bash', 'Bash', '', toolUseId, ts);
    ev.detail = `$ ${oneLine(description || cmds[0].command, 80)}`;
    events.push(ev);
  }
  return events;
}
