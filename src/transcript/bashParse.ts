import * as path from 'path';
import * as os from 'os';

// Agents mostly navigate code through Bash (`grep -rn`, `sed -n '120,180p'`,
// `cat`, `find`) rather than the Read/Grep tools. This turns one Bash command
// into the file actions it performs, so the spider can follow them too.
//
// It is a best-effort reader of common shell, not a shell: anything it can't
// resolve (unknown variables, subshells, loops) is skipped, never guessed.

export interface BashAction {
  kind: 'read' | 'write' | 'search';
  tool: string; // grep | rg | sed | cat | head | tail | find | redirect | ...
  file: string; // absolute; for a search, its root
  startLine?: number;
  endLine?: number;
  query?: string; // search pattern / find expression
  detail: string;
  listsFiles?: boolean; // search output is bare paths (grep -l, find)
  matcher?: RegExp; // the search pattern as a JS regex, when it translates
  nameMatcher?: RegExp; // find -name: the file name each result must match
  cwd?: string; // directory the command ran in (relative search output resolves against it)
}

interface Redirect {
  op: string;
  target: string;
}

interface Segment {
  words: string[];
  redirs: Redirect[];
  pipePos: number; // 0 = producer of its pipeline
}

// ---- lexer ---------------------------------------------------------------

function splitSegments(cmd: string): Segment[] {
  const segments: Segment[] = [];
  let words: string[] = [];
  let redirs: Redirect[] = [];
  let pipePos = 0;
  let word = '';
  let inWord = false;
  let pendingRedir: string | null = null;
  const heredocs: string[] = [];

  const endWord = () => {
    if (!inWord) {
      return;
    }
    if (pendingRedir) {
      if (pendingRedir.startsWith('<<') && pendingRedir !== '<<<') {
        heredocs.push(word);
      } else {
        redirs.push({ op: pendingRedir, target: word });
      }
      pendingRedir = null;
    } else {
      words.push(word);
    }
    word = '';
    inWord = false;
  };
  const endSegment = (nextPipePos: number) => {
    endWord();
    if (words.length || redirs.length) {
      segments.push({ words, redirs, pipePos });
    }
    words = [];
    redirs = [];
    pipePos = nextPipePos;
  };

  let i = 0;
  const n = cmd.length;
  while (i < n) {
    const c = cmd[i];

    if (c === '\n') {
      endSegment(0);
      i++;
      // Skip heredoc bodies: everything up to each delimiter line.
      while (heredocs.length) {
        const delim = heredocs.shift() as string;
        while (i < n) {
          const eol = cmd.indexOf('\n', i);
          const line = cmd.slice(i, eol < 0 ? n : eol);
          i = eol < 0 ? n : eol + 1;
          if (line.trim() === delim) {
            break;
          }
        }
      }
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      i++;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i < n && cmd[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (c === "'") {
      const close = cmd.indexOf("'", i + 1);
      word += cmd.slice(i + 1, close < 0 ? n : close);
      inWord = true;
      i = close < 0 ? n : close + 1;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n && cmd[i] !== '"') {
        if (cmd[i] === '\\' && i + 1 < n && '"\\$`'.includes(cmd[i + 1])) {
          // Keep an escaped `$` escaped so it is not mistaken for a variable.
          word += cmd[i + 1] === '$' ? '\\$' : cmd[i + 1];
          i += 2;
          continue;
        }
        word += cmd[i++];
      }
      i++;
      inWord = true;
      continue;
    }
    if (c === '\\' && i + 1 < n) {
      word += cmd[i + 1] === '\n' ? '' : cmd[i + 1];
      inWord = cmd[i + 1] !== '\n' || inWord;
      i += 2;
      continue;
    }
    if ((c === '$' && cmd[i + 1] === '(') || c === '`') {
      // Command substitution: skip it (balanced) and leave a marker that makes
      // the word unresolvable, so it is never guessed at.
      let j = i + 1;
      if (c === '`') {
        const close = cmd.indexOf('`', j);
        j = close < 0 ? n : close + 1;
      } else {
        let depth = 0;
        for (; j < n; j++) {
          if (cmd[j] === '(') {
            depth++;
          } else if (cmd[j] === ')' && --depth === 0) {
            j++;
            break;
          }
        }
      }
      word += '$(cmd)';
      inWord = true;
      i = j;
      continue;
    }
    if (c === '&' && cmd[i + 1] === '&') {
      endSegment(0);
      i += 2;
      continue;
    }
    if (c === '|' && cmd[i + 1] === '|') {
      endSegment(0);
      i += 2;
      continue;
    }
    if (c === '|') {
      endSegment(pipePos + 1);
      i += cmd[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === ';' || c === '&') {
      if (c === '&' && cmd[i + 1] === '>') {
        endWord();
        pendingRedir = cmd[i + 2] === '>' ? '>>' : '>';
        i += cmd[i + 2] === '>' ? 3 : 2;
        continue;
      }
      endSegment(0);
      i++;
      continue;
    }
    if ((c === '(' || c === ')' || c === '{' || c === '}') && !inWord) {
      endSegment(0);
      i++;
      continue;
    }
    // Redirections: [n]> [n]>> < << <<- <<< >&n
    const redir = /^(\d?)(>>|>&|>|<<<|<<-|<<|<)/.exec(cmd.slice(i, i + 4));
    if (redir && (!inWord || /^\d$/.test(word))) {
      if (inWord) {
        word = '';
        inWord = false;
      } else {
        endWord();
      }
      const op = redir[2];
      i += redir[0].length;
      if (op === '>&') {
        // fd duplication (2>&1): consume the target, not a file.
        while (i < n && /[0-9-]/.test(cmd[i])) {
          i++;
        }
        continue;
      }
      pendingRedir = op;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endSegment(0);
  return segments;
}

// ---- helpers -------------------------------------------------------------

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const LEAD_KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', 'time', 'sudo', 'command', 'exec', 'nohup']);

function expand(word: string, vars: Map<string, string>): string | null {
  let out = word.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
    const v = vars.get(a || b);
    return v === undefined ? '\u0000' : v;
  });
  if (out.includes('\u0000') || out.includes('$(cmd)')) {
    return null;
  }
  out = out.replace(/\\\$/g, '$');
  if (out === '~' || out.startsWith('~/')) {
    out = os.homedir() + out.slice(1);
  }
  return out;
}

function resolvePath(cwd: string, p: string): string {
  return path.resolve(cwd, p);
}

// Paths that are never interesting to show as "code the agent looked at".
function isNoise(abs: string): boolean {
  return abs.startsWith('/dev/') || abs.startsWith('/proc/') || abs === '/dev/null';
}

const hasGlob = (s: string) => /[*?[\]]/.test(s);

interface FlagSpec {
  withArg: Set<string>; // short flags taking a value, e.g. 'e', 'A'
  longWithArg: Set<string>; // long flags taking a value when written without '='
}

const GREP_FLAGS: FlagSpec = {
  withArg: new Set(['e', 'f', 'A', 'B', 'C', 'm', 'd', 'D']),
  longWithArg: new Set(['--regexp', '--file', '--after-context', '--before-context', '--context', '--max-count', '--include', '--exclude', '--exclude-dir', '--label']),
};
const RG_FLAGS: FlagSpec = {
  withArg: new Set(['e', 'f', 'g', 't', 'T', 'A', 'B', 'C', 'm', 'M', 'j', 'E', 'r']),
  longWithArg: new Set(['--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--after-context', '--before-context', '--context', '--max-count', '--max-columns', '--threads', '--encoding', '--replace', '--max-depth', '--sort', '--sortr']),
};

// Split args into flags (with their values) and positionals.
function parseArgs(args: string[], spec: FlagSpec): { flags: Map<string, string[]>; positionals: string[] } {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  const add = (k: string, v: string) => flags.set(k, [...(flags.get(k) ?? []), v]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        add(a.slice(0, eq), a.slice(eq + 1));
      } else if (spec.longWithArg.has(a) && i + 1 < args.length) {
        add(a, args[++i]);
      } else {
        add(a, '');
      }
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d+$/.test(a)) {
      // Combined short flags (-rn); one taking a value consumes the rest or the next arg.
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (spec.withArg.has(f)) {
          const rest = a.slice(j + 1);
          add(`-${f}`, rest || (i + 1 < args.length ? args[++i] : ''));
          break;
        }
        add(`-${f}`, '');
      }
      continue;
    }
    if (/^-\d+$/.test(a)) {
      add('-NUM', a.slice(1));
      continue;
    }
    positionals.push(a);
  }
  return { flags, positionals };
}

function trunc(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ---- per-command readers ---------------------------------------------------

function grepLike(tool: string, args: string[], cwd: string, vars: Map<string, string>): BashAction[] {
  const { flags, positionals } = parseArgs(args, tool === 'grep' ? GREP_FLAGS : RG_FLAGS);
  const patterns = [...(flags.get('-e') ?? []), ...(flags.get('--regexp') ?? [])];
  const rest = [...positionals];
  if (!patterns.length) {
    if (!rest.length) {
      return [];
    }
    patterns.push(rest.shift() as string);
  }
  const recursive = tool !== 'grep' || flags.has('-r') || flags.has('-R') || flags.has('--recursive');
  if (!rest.length && !recursive) {
    return []; // grep with no file reads stdin: a filter, not a search
  }
  const roots = rest.length ? rest : ['.'];
  const resolved = roots.map((r) => expand(r, vars)).filter((r): r is string => !!r);
  if (!resolved.length) {
    return [];
  }
  const root = hasGlob(resolved[0]) ? path.dirname(resolved[0]) : resolved[0];
  const query = patterns.join(' | ');
  const listsFiles = flags.has('-l') || flags.has('--files-with-matches') || flags.has('--files');
  return [{
    kind: 'search',
    tool,
    file: resolvePath(cwd, root),
    query,
    listsFiles,
    matcher: toRegExp(tool, patterns, flags),
    detail: `${tool} "${trunc(query, 48)}"`,
  }];
}

// grep's basic regex (`\|`, `\(`) or a fixed string, as a JS RegExp. Used only
// to tell which of several searches in one command produced an output line.
function toRegExp(tool: string, patterns: string[], flags: Map<string, string[]>): RegExp | undefined {
  const fixed = flags.has('-F') || flags.has('--fixed-strings');
  const basic = tool !== 'rg' && !flags.has('-E') && !flags.has('-P') && !flags.has('--extended-regexp');
  const src = patterns.map((p) => {
    if (fixed) {
      return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return basic ? p.replace(/\\([|(){}+?])/g, '$1') : p;
  }).join('|');
  try {
    return new RegExp(src, flags.has('-i') || flags.has('--ignore-case') ? 'i' : '');
  } catch {
    return undefined;
  }
}

function sedAction(args: string[], cwd: string, vars: Map<string, string>): BashAction[] {
  const { flags, positionals } = parseArgs(args, { withArg: new Set(['e', 'f']), longWithArg: new Set(['--expression', '--file']) });
  const inPlace = [...flags.keys()].some((k) => k === '-i' || k.startsWith('--in-place'));
  const scripts = [...(flags.get('-e') ?? []), ...(flags.get('--expression') ?? [])];
  const rest = [...positionals];
  if (!scripts.length && rest.length) {
    scripts.push(rest.shift() as string);
  }
  const files = rest.map((f) => expand(f, vars)).filter((f): f is string => !!f && !hasGlob(f));
  if (!files.length) {
    return []; // stdin filter
  }
  if (inPlace) {
    return files.map((f) => ({ kind: 'write' as const, tool: 'sed', file: resolvePath(cwd, f), detail: 'sed -i (in place)' }));
  }
  // `sed -n '120,180p'` / `'42p'` / `'10,+20p'` print an exact range.
  let startLine: number | undefined;
  let endLine: number | undefined;
  for (const s of scripts) {
    const m = /^\s*(\d+)(?:\s*,\s*(\+?)(\d+))?\s*p\s*;?\s*$/.exec(s);
    if (m) {
      const a = Number(m[1]);
      const b = m[3] ? (m[2] ? a + Number(m[3]) : Number(m[3])) : a;
      startLine = startLine === undefined ? a : Math.min(startLine, a);
      endLine = endLine === undefined ? b : Math.max(endLine, b);
    }
  }
  return files.map((f) => ({
    kind: 'read' as const,
    tool: 'sed',
    file: resolvePath(cwd, f),
    startLine,
    endLine,
    detail: startLine !== undefined ? `sed lines ${startLine}-${endLine}` : 'sed (whole file)',
  }));
}

function headTail(tool: 'head' | 'tail', args: string[], cwd: string, vars: Map<string, string>): BashAction[] {
  const { flags, positionals } = parseArgs(args, { withArg: new Set(['n', 'c']), longWithArg: new Set(['--lines', '--bytes']) });
  const nRaw = flags.get('-n')?.[0] ?? flags.get('--lines')?.[0] ?? flags.get('-NUM')?.[0];
  const count = nRaw !== undefined && /^\+?\d+$/.test(nRaw) ? Number(nRaw.replace('+', '')) : 10;
  const files = positionals.map((f) => expand(f, vars)).filter((f): f is string => !!f && !hasGlob(f));
  return files.map((f) => (tool === 'head'
    ? { kind: 'read' as const, tool, file: resolvePath(cwd, f), startLine: 1, endLine: count, detail: `head ${count} lines` }
    : { kind: 'read' as const, tool, file: resolvePath(cwd, f), detail: `tail ${count} lines` }));
}

function findAction(tool: string, args: string[], cwd: string, vars: Map<string, string>): BashAction[] {
  // `find … -delete` / `-exec …` act on what they find; that is not a search.
  if (args.some((a) => a === '-delete' || a === '-exec' || a === '-execdir' || a === '-ok')) {
    return [];
  }
  // find ROOT... EXPR — roots are the leading args that aren't options/expressions.
  const roots: string[] = [];
  let i = 0;
  while (i < args.length && !args[i].startsWith('-') && !['(', '!', ')'].includes(args[i])) {
    roots.push(args[i++]);
  }
  const expr = args.slice(i).filter((a) => !['-print', '-print0'].includes(a));
  const root = expand(roots[0] ?? '.', vars);
  if (!root) {
    return [];
  }
  const name = expr.findIndex((a) => a === '-name' || a === '-iname');
  const glob = name >= 0 ? expr[name + 1] : undefined;
  const query = glob ?? (expr.join(' ') || '*');
  return [{
    kind: 'search',
    tool,
    file: resolvePath(cwd, root),
    query,
    listsFiles: true,
    nameMatcher: glob ? globToRegExp(glob, expr[name] === '-iname') : undefined,
    detail: `${tool} ${trunc(query, 48)}`,
  }];
}

function globToRegExp(glob: string, ignoreCase: boolean): RegExp | undefined {
  const src = glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  try {
    return new RegExp(`^${src}$`, ignoreCase ? 'i' : '');
  } catch {
    return undefined;
  }
}

// ---- entry point ------------------------------------------------------------

export function parseBash(command: string, cwd: string): BashAction[] {
  const actions: BashAction[] = [];
  const vars = new Map<string, string>();
  let dir = cwd;

  for (const seg of splitSegments(command)) {
    let words = seg.words.slice();
    while (words.length && LEAD_KEYWORDS.has(words[0])) {
      words.shift();
    }
    // Leading assignments: on their own they set shell vars; before a command
    // they only set its environment.
    let assigns = 0;
    while (assigns < words.length && ASSIGN.test(words[assigns])) {
      assigns++;
    }
    if (assigns === words.length) {
      for (const w of words) {
        const m = ASSIGN.exec(w) as RegExpExecArray;
        const v = expand(m[2], vars);
        if (v !== null) {
          vars.set(m[1], v);
        } else {
          vars.delete(m[1]);
        }
      }
      words = [];
    } else {
      words = words.slice(assigns);
    }

    // Output redirection writes a file, whatever the command. It is recorded
    // after the command's own reads (`cat a > b` reads a, then writes b).
    const redirWrites: BashAction[] = [];
    for (const r of seg.redirs) {
      if (r.op === '>' || r.op === '>>') {
        const t = expand(r.target, vars);
        if (t && !isNoise(resolvePath(dir, t)) && !/^\d$/.test(t)) {
          redirWrites.push({ kind: 'write', tool: 'redirect', file: resolvePath(dir, t), detail: r.op === '>>' ? 'appended (>>)' : 'wrote (>)' });
        }
      }
    }

    command: {
      if (!words.length) {
        break command;
      }

      const prog = path.basename(words[0]);
      const args = words.slice(1);

      if (prog === 'cd') {
        const target = expand(args[0] ?? '~', vars);
        if (target) {
          dir = resolvePath(dir, target);
        }
        break command;
      }
      if (prog === 'export') {
        for (const a of args) {
          const m = ASSIGN.exec(a);
          if (m) {
            const v = expand(m[2], vars);
            if (v !== null) {
              vars.set(m[1], v);
            }
          }
        }
        break command;
      }
      if (prog === 'for' || prog === 'case' || prog === 'function') {
        break command;
      }

      if ((prog === 'grep' || prog === 'egrep' || prog === 'fgrep' || prog === 'rg' || prog === 'ag' || prog === 'ack') && seg.pipePos === 0) {
        actions.push(...grepLike(prog === 'egrep' || prog === 'fgrep' ? 'grep' : prog, args, dir, vars));
      } else if (prog === 'git' && args[0] === 'grep' && seg.pipePos === 0) {
        actions.push(...grepLike('git grep', args.slice(1), dir, vars));
      } else if (prog === 'sed') {
        actions.push(...sedAction(args, dir, vars));
      } else if (prog === 'cat' || prog === 'bat' || prog === 'batcat' || prog === 'nl' || prog === 'less' || prog === 'more') {
        const files = args.filter((a) => !a.startsWith('-')).map((f) => expand(f, vars)).filter((f): f is string => !!f && !hasGlob(f));
        for (const f of files) {
          actions.push({ kind: 'read', tool: prog, file: resolvePath(dir, f), detail: `${prog} (whole file)` });
        }
      } else if (prog === 'head' || prog === 'tail') {
        actions.push(...headTail(prog, args, dir, vars));
      } else if ((prog === 'find' || prog === 'fd' || prog === 'fdfind') && seg.pipePos === 0) {
        actions.push(...findAction(prog === 'find' ? 'find' : 'fd', args, dir, vars));
      } else if (prog === 'tee') {
        for (const f of args.filter((a) => !a.startsWith('-'))) {
          const t = expand(f, vars);
          if (t) {
            actions.push({ kind: 'write', tool: 'tee', file: resolvePath(dir, t), detail: 'wrote (tee)' });
          }
        }
      }
    }
    actions.push(...redirWrites);
    for (let k = actions.length - 1; k >= 0 && actions[k].cwd === undefined; k--) {
      actions[k].cwd = dir;
    }
  }
  return actions.filter((a) => !isNoise(a.file));
}

export interface Hit {
  file: string;
  line?: number;
  text?: string;
}

const under = (root: string, file: string) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// Hits for each search a Bash command ran, from its combined stdout. A line is
// kept only if it lies under that search's root (so `ls`/`echo` output in the
// same command is ignored) and, when the command ran several searches, it is
// given to the first one whose pattern matches its text.
export function attributeHits(stdout: string, searches: BashAction[], fallbackCwd: string): Hit[][] {
  const claimed = new Set<string>();
  return searches.map((s) => {
    const hits = parseHits(stdout, s, s.cwd ?? fallbackCwd)
      .filter((h) => under(s.file, h.file) && (!s.nameMatcher || s.nameMatcher.test(path.basename(h.file))));
    if (searches.length === 1) {
      return hits;
    }
    return hits.filter((h) => {
      const key = `${h.file}:${h.line ?? ''}:${h.text ?? ''}`;
      if (claimed.has(key) || (h.text !== undefined && s.matcher && !s.matcher.test(h.text))) {
        return false;
      }
      claimed.add(key);
      return true;
    });
  });
}

// Parse search output into hits. Handles `path:line:text`, `line:text` (single
// file), `path:text` and bare paths (grep -l / find).
export function parseHits(
  stdout: string,
  action: Pick<BashAction, 'file' | 'listsFiles'>,
  cwd: string,
  cap = 2000,
): Hit[] {
  const hits: Hit[] = [];
  const lines = stdout.split('\n');
  for (const raw of lines.slice(0, cap)) {
    const l = raw.replace(/\r$/, '');
    if (!l || l === '--') {
      continue;
    }
    if (action.listsFiles) {
      if (!l.includes(':') || /^[A-Za-z]:\\/.test(l)) {
        hits.push({ file: resolvePath(cwd, l.trim()) });
      }
      continue;
    }
    let m = /^(.+?):(\d+):(.*)$/.exec(l);
    if (m) {
      hits.push({ file: resolvePath(cwd, m[1]), line: Number(m[2]), text: m[3] });
      continue;
    }
    m = /^(\d+):(.*)$/.exec(l);
    if (m) {
      hits.push({ file: action.file, line: Number(m[1]), text: m[2] });
      continue;
    }
    m = /^(.+?):(.*)$/.exec(l);
    if (m && !m[1].includes(' ')) {
      hits.push({ file: resolvePath(cwd, m[1]), text: m[2] });
    }
  }
  return hits;
}
