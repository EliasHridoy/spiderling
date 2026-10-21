import * as fs from 'fs';
import * as path from 'path';

// Names the function/class around a line, from the CodeGraph index of the repo
// the file lives in (`<repo>/.codegraph/codegraph.db`, a SQLite file CodeGraph
// keeps in sync as files change). Lets the trace say "edited parseInvoice()"
// instead of "edited lines 140-162".
//
// Strictly optional: it needs `node:sqlite` (Node 22+; older hosts simply get no
// names), a CodeGraph index, and it never throws. The index describes the code
// as it was indexed, so only use it for steps that just happened, not for
// replaying history after the code has moved on.

interface Stmt {
  get(...params: unknown[]): { name?: string; qualified_name?: string } | undefined;
}
interface Db {
  prepare(sql: string): Stmt;
  close(): void;
}

const SQL = `SELECT name, qualified_name FROM nodes
  WHERE file_path = ? AND start_line <= ? AND end_line >= ?
    AND kind NOT IN ('file', 'import', 'variable', 'constant')
  ORDER BY (end_line - start_line) ASC LIMIT 1`;

export class SymbolIndex {
  private readonly dbs = new Map<string, { db: Db; stmt: Stmt } | null>(); // repo root -> handle
  private readonly rootOf = new Map<string, string | null>(); // directory -> repo root with an index
  private sqlite: { DatabaseSync: new (file: string, opts: { readOnly: boolean }) => Db } | null | undefined;

  private driver(): NonNullable<SymbolIndex['sqlite']> | null {
    if (this.sqlite === undefined) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        this.sqlite = require('node:sqlite');
      } catch {
        this.sqlite = null;
      }
    }
    return this.sqlite ?? null;
  }

  private repoWithIndex(dir: string): string | null {
    const seen: string[] = [];
    let d = dir;
    let found: string | null = null;
    for (let i = 0; i < 40; i++) {
      const cached = this.rootOf.get(d);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      seen.push(d);
      if (fs.existsSync(path.join(d, '.codegraph', 'codegraph.db'))) {
        found = d;
        break;
      }
      const parent = path.dirname(d);
      if (parent === d) {
        break;
      }
      d = parent;
    }
    for (const s of seen) {
      this.rootOf.set(s, found);
    }
    return found;
  }

  private open(root: string): { db: Db; stmt: Stmt } | null {
    if (this.dbs.has(root)) {
      return this.dbs.get(root) ?? null;
    }
    let handle: { db: Db; stmt: Stmt } | null = null;
    const driver = this.driver();
    if (driver) {
      try {
        const db = new driver.DatabaseSync(path.join(root, '.codegraph', 'codegraph.db'), { readOnly: true });
        handle = { db, stmt: db.prepare(SQL) };
      } catch {
        handle = null;
      }
    }
    this.dbs.set(root, handle);
    return handle;
  }

  lookup(absFile: string, line: number): string | undefined {
    try {
      const root = this.repoWithIndex(path.dirname(absFile));
      const handle = root && this.open(root);
      if (!root || !handle) {
        return undefined;
      }
      const rel = path.relative(root, absFile).split(path.sep).join('/');
      const row = handle.stmt.get(rel, line, line);
      return (row && (row.qualified_name || row.name)) || undefined;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    for (const h of this.dbs.values()) {
      try {
        h?.db.close();
      } catch {
        // already closed
      }
    }
    this.dbs.clear();
  }
}
