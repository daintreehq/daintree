// SQL tokens the way SQLite's own tokenizer reads them, for checks that must
// agree with SQLite about where statements, strings and names begin and end.
// Pure, so the manifest schema can run it without opening a database.

export type SqlTokenKind =
  "space" | "comment" | "string" | "quoted" | "word" | "variable" | "semicolon" | "other";
export interface SqlToken {
  kind: SqlTokenKind;
  text: string;
}

const isSqlSpace = (c: number): boolean => c === 0x20 || (c >= 0x09 && c <= 0x0d);
// SQLite's IdChar: ASCII letters, digits, `_`, `$`, and every byte of a
// multi-byte UTF-8 character (so every UTF-16 unit at or past 0x80).
const isIdChar = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) ||
  (c >= 0x41 && c <= 0x5a) ||
  (c >= 0x61 && c <= 0x7a) ||
  c === 0x5f ||
  c === 0x24 ||
  c >= 0x80;

/**
 * Split SQL into tokens the way SQLite's own tokenizer (tokenize.c) does, as
 * far as statement boundaries and keywords are concerned. It has to agree
 * with SQLite exactly: any place it reads a quote or a comment differently is
 * a place where a statement can hide from the checks built on it.
 */
export function lexSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  const push = (kind: SqlTokenKind, end: number): void => {
    tokens.push({ kind, text: sql.slice(i, end) });
    i = end;
  };
  const closeQuoted = (quote: string, from: number): number => {
    let j = from;
    for (;;) {
      const next = sql.indexOf(quote, j);
      if (next < 0) return sql.length;
      // A doubled delimiter is an escaped one, except for `]`.
      if (quote !== "]" && sql[next + 1] === quote) {
        j = next + 2;
        continue;
      }
      return next + 1;
    }
  };
  while (i < sql.length) {
    const c = sql.charCodeAt(i);
    const ch = sql[i]!;
    if (c === 0xfeff) {
      // SQLite reads a byte-order mark that starts a token as whitespace.
      push("space", i + 1);
    } else if (isSqlSpace(c)) {
      let j = i + 1;
      while (j < sql.length && isSqlSpace(sql.charCodeAt(j))) j++;
      push("space", j);
    } else if (ch === "-" && sql[i + 1] === "-") {
      // Only \n ends a line comment; a bare \r does not.
      const end = sql.indexOf("\n", i + 2);
      push("comment", end < 0 ? sql.length : end);
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      push("comment", end < 0 ? sql.length : end + 2);
    } else if (ch === "'") {
      push("string", closeQuoted("'", i + 1));
    } else if (ch === '"' || ch === "`") {
      push("quoted", closeQuoted(ch, i + 1));
    } else if (ch === "[") {
      push("quoted", closeQuoted("]", i + 1));
    } else if (ch === ";") {
      push("semicolon", i + 1);
    } else if (ch === "$" || ch === "@" || ch === ":" || ch === "#") {
      // A named parameter, including the Tcl forms `$a::b` and `$a(…)`,
      // whose parentheses may hold anything up to whitespace or `)` —
      // quotes and semicolons included.
      let j = i + 1;
      let named = 0;
      while (j < sql.length) {
        const d = sql.charCodeAt(j);
        if (isIdChar(d)) {
          named++;
          j++;
        } else if (sql[j] === "(" && named > 0) {
          j++;
          while (j < sql.length && !isSqlSpace(sql.charCodeAt(j)) && sql[j] !== ")") j++;
          if (sql[j] === ")") j++;
          break;
        } else if (sql[j] === ":" && sql[j + 1] === ":") {
          j += 2;
        } else {
          break;
        }
      }
      push(named > 0 ? "variable" : "other", Math.max(j, i + 1));
    } else if (isIdChar(c)) {
      let j = i + 1;
      while (j < sql.length && (isIdChar(sql.charCodeAt(j)) || sql[j] === ".")) {
        // `.` only continues a number (`1.5`); after a name it is a separator.
        if (sql[j] === "." && !(c >= 0x30 && c <= 0x39)) break;
        j++;
      }
      push("word", j);
    } else {
      push("other", i + 1);
    }
  }
  return tokens;
}

export const isInsignificant = (token: SqlToken): boolean =>
  token.kind === "space" || token.kind === "comment";

/** A bare keyword; a quoted identifier is never one. */
export const isKeyword = (token: SqlToken | undefined, keyword: string): boolean =>
  token?.kind === "word" && token.text.toUpperCase() === keyword;

/**
 * A name with its quotes removed. SQLite's `nm` rule takes a string literal as
 * a name too (`PRAGMA 'temp_store_directory'`), so single quotes count.
 */
export function identifierText(token: SqlToken | undefined): string | null {
  if (!token) return null;
  if (token.kind === "word") return token.text.toLowerCase();
  if (token.kind === "quoted" || token.kind === "string") {
    return token.text.slice(1, -1).toLowerCase();
  }
  return null;
}
