/** The separators a delimited file may use. */
export type Delimiter = "," | ";" | "\t";

const QUOTE = 34;
const LF = 10;
const CR = 13;

interface RecordScan {
  /** Where the next record starts. */
  next: number;
  /** How many fields the record has. */
  fields: number;
  /** A quote the record's fields can't account for: mid-field, after a closing quote, or never closed. */
  stray: boolean;
}

/**
 * Reads one record starting at `start`, RFC 4180 style: a field that starts
 * with a double quote runs to the matching closing quote, `""` inside it is
 * one quote, and delimiters and line breaks inside it are part of the field.
 * Lenient where files are: a quote in the middle of an unquoted field is
 * literal, text after a closing quote is kept, and an unclosed quote runs to
 * the end of the file; each marks the record `stray`. A trailing line break
 * ends the record rather than starting an empty one. Fields are collected
 * into `out` when given, and only counted otherwise.
 */
function scanRecord(text: string, start: number, delim: number, out: string[] | null): RecordScan {
  const length = text.length;
  let i = start;
  let fields = 0;
  let stray = false;
  for (;;) {
    let field = "";
    if (i < length && text.charCodeAt(i) === QUOTE) {
      i += 1;
      let from = i;
      for (;;) {
        const close = text.indexOf('"', i);
        if (close === -1) {
          if (out) field += text.slice(from);
          i = length;
          stray = true;
          break;
        }
        if (out) field += text.slice(from, close);
        if (text.charCodeAt(close + 1) === QUOTE) {
          if (out) field += '"';
          i = close + 2;
          from = i;
          continue;
        }
        i = close + 1;
        break;
      }
    }
    const from = i;
    while (i < length) {
      const code = text.charCodeAt(i);
      if (code === delim || code === LF || code === CR) break;
      if (code === QUOTE) stray = true;
      i += 1;
    }
    // Text left between a closing quote and the delimiter is stray too.
    if (i > from && from > start && text.charCodeAt(from - 1) === QUOTE) stray = true;
    if (out) out.push(i > from ? field + text.slice(from, i) : field);
    fields += 1;

    if (i >= length) return { next: length, fields, stray };
    const code = text.charCodeAt(i);
    i += 1;
    if (code === delim) {
      // A delimiter as the file's last character still owes the record an
      // empty final field.
      if (i >= length) {
        if (out) out.push("");
        return { next: length, fields: fields + 1, stray };
      }
      continue;
    }
    if (code === CR && text.charCodeAt(i) === LF) i += 1;
    return { next: i, fields, stray };
  }
}

/** Splits delimited text into records of fields; `limit` stops after that many records. */
export function parseDelimited(text: string, delimiter: Delimiter, limit = Infinity): string[][] {
  const delim = delimiter.charCodeAt(0);
  const records: string[][] = [];
  let i = 0;
  while (i < text.length && records.length < limit) {
    const fields: string[] = [];
    i = scanRecord(text, i, delim, fields).next;
    records.push(fields);
  }
  return records;
}

/** How many records the delimiter guess looks at. */
const SAMPLE_RECORDS = 50;
/** How much of the file the delimiter guess reads, so a huge first field can't stall it. */
const SAMPLE_CHARS = 64 * 1024;

/**
 * The delimiter that splits the start of the file into the most rows of one
 * consistent width wider than a single column, the wider width breaking a tie.
 * A record only counts when its quotes make sense under that delimiter, so a
 * delimiter that only appears inside quoted values can't win. A `.tsv` prefers
 * tab on a full tie, anything else comma, then semicolon, then tab, so a
 * single-column file or one the sample can't decide keeps the delimiter its
 * extension names.
 */
export function detectDelimiter(text: string, extension: string | null): Delimiter {
  const order: readonly Delimiter[] =
    extension?.toLowerCase() === "tsv" ? ["\t", ",", ";"] : [",", ";", "\t"];
  const sample = text.length > SAMPLE_CHARS ? text.slice(0, SAMPLE_CHARS) : text;
  const truncated = text.length > SAMPLE_CHARS;
  let best: Delimiter = order[0]!;
  let bestRows = 0;
  let bestWidth = 0;
  for (const delimiter of order) {
    const delim = delimiter.charCodeAt(0);
    const widths = new Map<number, number>();
    let i = 0;
    for (let n = 0; n < SAMPLE_RECORDS && i < sample.length; n += 1) {
      const scan = scanRecord(sample, i, delim, null);
      i = scan.next;
      // A sample cut mid-file may end in a partial record; it says nothing.
      if (truncated && i >= sample.length && n > 0) break;
      if (scan.fields > 1 && !scan.stray) {
        widths.set(scan.fields, (widths.get(scan.fields) ?? 0) + 1);
      }
    }
    for (const [width, rows] of widths) {
      if (rows > bestRows || (rows === bestRows && width > bestWidth)) {
        best = delimiter;
        bestRows = rows;
        bestWidth = width;
      }
    }
  }
  return best;
}

export interface DelimitedTable {
  delimiter: Delimiter;
  /** The first record's fields, as written. */
  header: readonly string[];
  /** Records after the first. */
  rowCount: number;
  /** The widest record's field count, the header included. */
  columnCount: number;
  /**
   * Data rows `from` up to `to`, parsed on demand: a 2 MiB file can hold
   * millions of records, and only the ones on screen need to exist as arrays.
   * Rows may be shorter or longer than the header.
   */
  rows(from: number, to: number): string[][];
}

/**
 * Reads a delimited file as a header row over data rows. One pass finds where
 * every record starts and how wide the widest is without building a field;
 * rows are parsed when asked for.
 */
export function readDelimitedTable(text: string, extension: string | null): DelimitedTable {
  const delimiter = detectDelimiter(text, extension);
  const delim = delimiter.charCodeAt(0);
  const starts: number[] = [];
  let columnCount = 0;
  let i = 0;
  while (i < text.length) {
    starts.push(i);
    const scan = scanRecord(text, i, delim, null);
    if (scan.fields > columnCount) columnCount = scan.fields;
    i = scan.next;
  }
  const header: string[] = [];
  if (starts.length > 0) scanRecord(text, 0, delim, header);
  const rowCount = Math.max(0, starts.length - 1);
  return {
    delimiter,
    header,
    rowCount,
    columnCount,
    rows(from, to) {
      const out: string[][] = [];
      const end = Math.min(to, rowCount);
      for (let row = Math.max(0, from); row < end; row += 1) {
        const fields: string[] = [];
        scanRecord(text, starts[row + 1]!, delim, fields);
        out.push(fields);
      }
      return out;
    },
  };
}
