export interface JsonlError {
  /** 1-based line number in the input. */
  line: number;
  message: string;
  /** The offending line as written, without its line break. */
  text: string;
}

export interface ParsedJsonl {
  /** Every line that parsed, in file order. */
  records: unknown[];
  /** Every non-blank line that did not, in file order. */
  errors: JsonlError[];
}

/**
 * Parse JSON Lines text, collecting a bad line as an error rather than
 * throwing, so one corrupt entry in an append-only log does not hide the rest.
 * Blank lines are skipped and `\r\n` endings are accepted. A final line with
 * no line break that fails to parse is reported as possibly truncated: that
 * is what an interrupted append looks like, though it may just be a malformed
 * last record.
 */
export function parseJsonl(text: string): ParsedJsonl {
  const records: unknown[] = [];
  const errors: JsonlError[] = [];
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      // JSON.parse only ever throws a SyntaxError.
      const reason = (error as SyntaxError).message;
      const unterminated = index === lines.length - 1;
      errors.push({
        line: index + 1,
        message: unterminated ? `possibly truncated final line (no line break): ${reason}` : reason,
        text: line,
      });
    }
  }
  return { records, errors };
}

/**
 * One JSON Lines record, line break included, ready to append. JSON escapes
 * every line break inside a string, so the record is always a single line.
 * Throws for a value JSON cannot represent (`undefined`, a function, a symbol).
 */
export function stringifyJsonlLine(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError(`stringifyJsonlLine: ${typeof value} has no JSON representation`);
  }
  return `${json}\n`;
}
