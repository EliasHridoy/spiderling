// Masks credentials in the free text that goes into agent-trace.json (captions,
// shell commands, search queries, agent descriptions), because that file is
// shared in PRs. Best-effort, pattern based: it catches well-known token formats
// and `name=value` / `"name": "value"` assignments of secret-looking names, and
// errs on the side of masking. It cannot recognise an arbitrary secret that has
// no telltale format or name. No `vscode` import.

export const REDACTED = '[redacted]';

const PLACEHOLDER = /^(?:string|number|boolean|object|array|undefined|null|none|true|false|empty|value|required|optional|changeme|example|your[-_]?\w*|x{3,}|\*+|\.{3})$/i;

// Values that are references or code, not literals: $TOKEN, ${TOKEN}, <token>,
// [redacted], {{ token }}, %TOKEN%, process.env.X, token(), a bare path.
function isReference(value: string): boolean {
  return /^(?:\$|<|\[|\{|%|\.\.?\/|\/)/.test(value)
    || /^[A-Za-z_][\w.]*\(/.test(value)
    || /^(?:process\.env|os\.environ|env)\b/.test(value)
    || PLACEHOLDER.test(value);
}

const SECRET_NAME = '(?:password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential|auth[_-]?key|connection[_-]?string|signature)';

interface Rule {
  re: RegExp;
  // Returns the replacement, or null to leave the match untouched.
  fn: (...m: string[]) => string | null;
}

const RULES: Rule[] = [
  // PEM private key blocks (to the END line, or the end of the text if cut off)
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    fn: () => `${REDACTED} private key`,
  },
  // scheme://user:password@host
  {
    re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi,
    fn: (_m, scheme) => `${scheme}${REDACTED}@`,
  },
  // well-known token formats
  {
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b|\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b|\bAIza[0-9A-Za-z_-]{35}\b|\bnpm_[A-Za-z0-9]{30,}\b|\bglpat-[A-Za-z0-9_-]{20,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    fn: () => REDACTED,
  },
  // Authorization: Bearer xxx   /   Authorization=Basic xxx
  {
    re: /(\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)?\s*)([A-Za-z0-9._~+/=-]{8,})/gi,
    fn: (_m, head, value) => (isReference(value) ? null : `${head}${REDACTED}`),
  },
  // a lone "Bearer xxx"
  {
    re: /\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
    fn: (_m, head) => `${head}${REDACTED}`,
  },
  // curl -u user:password
  {
    re: /(\s(?:-u|--user)[\s=]+)(?!\$)([^\s"':]+:[^\s"']+)/g,
    fn: (_m, head) => `${head}${REDACTED}`,
  },
  // --password hunter2  /  --token=abc  /  --api-key abc
  {
    re: new RegExp(`(--[a-z-]*${SECRET_NAME}[a-z-]*(?:=|\\s+))(["']?)([^\\s"']{4,})`, 'gi'),
    fn: (_m, head, quote, value) => (isReference(value) ? null : `${head}${quote}${REDACTED}`),
  },
  // name=value, name: value, "name": "value"  (names containing a secret word)
  {
    re: new RegExp(`\\b([A-Za-z0-9_.-]*${SECRET_NAME}[A-Za-z0-9_.-]*)(["']?\\s*[:=]\\s*["']?)([^\\s"',;&)}\\]]{6,})`, 'gi'),
    fn: (_m, name, sep, value) => {
      if (isReference(value) || value.startsWith(REDACTED)) {
        return null;
      }
      // A bare "name: value" is as likely to be prose ("the token: expired") as
      // a literal; there only mask values that look like secrets.
      const assignment = /["'=]/.test(sep);
      if (!assignment && !(/[\d_+/=-]/.test(value) || value.length >= 16)) {
        return null;
      }
      return `${name}${sep}${REDACTED}`;
    },
  },
];

export interface RedactResult {
  text: string;
  count: number;
}

export function redact(text: string): RedactResult {
  let count = 0;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (...args) => {
      const groups = args.slice(0, -2).map(String); // drop offset + whole string
      const next = rule.fn(...groups);
      if (next === null) {
        return groups[0];
      }
      count++;
      return next;
    });
  }
  return { text: out, count };
}

// Stateful helper: masks text and keeps a running count of what it changed.
export class Redactor {
  count = 0;

  text(s: string): string;
  text(s: string | undefined): string | undefined;
  text(s: string | undefined): string | undefined {
    if (!s) {
      return s;
    }
    const r = redact(s);
    this.count += r.count;
    return r.text;
  }
}
