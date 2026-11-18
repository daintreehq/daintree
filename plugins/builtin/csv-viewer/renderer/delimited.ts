/** The separators a delimited file may use. */
export type Delimiter = "," | ";" | "\t";

const QUOTE = 34;
const LF = 10;
const CR = 13;

/**
 * Splits delimited text into records of fields, RFC 4180 style: a field that
 * starts with a double quote runs to the matching closing quote, `""` inside it
 * is one quote, and delimiters and line breaks inside it are part of the
 * field. Lenient where files are: a quote in the middle of an unquoted field is
 * literal, text after a closing quote is kept, and an unclosed quote runs to
 * the end of the file. A trailing line break ends the last record rather than
 * starting an empty one. `limit` stops after that many records, for sampling.
 */
export function parseDelimited(text: string, delimiter: Delimiter, limit = Infinity): string[][] {
  const records: string[][] = [];
  const delim = delimiter.charCodeAt(0);
  const length = text.length;
  let record: string[] = [];
  let i = 0;

  while (i < length && records.length < limit) {
    let field = "";
    if (text.charCodeAt(i) === QUOTE) {
      i += 1;
      let start = i;
      for (;;) {
        const close = text.indexOf('"', i);
        if (close === -1) {
          field += text.slice(start);
          i = length;
          break;
        }
        field += text.slice(start, close);
        if (text.charCodeAt(close + 1) === QUOTE) {
          field += '"';
          i = close + 2;
          start = i;
          continue;
        }
        i = close + 1;
        break;
      }
    }
    const start = i;
    while (i < length) {
      const code = text.charCodeAt(i);
      if (code === delim || code === LF || code === CR) break;
      i += 1;
    }
    if (i > start) field += text.slice(start, i);
    record.push(field);

    if (i >= length) break;
    const code = text.charCodeAt(i);
    i += 1;
    if (code === delim) {
      // A delimiter as the file's last character still owes the record an
      // empty final field.
      if (i >= length) record.push("");
      continue;
    }
    if (code === CR && text.charCodeAt(i) === LF) i += 1;
    records.push(record);
    record = [];
  }
  if (record.length > 0 && records.length < limit) records.push(record);
  return records;
}

/** How many records the delimiter guess looks at. */
const SAMPLE_RECORDS = 50;
/** How much of the file the delimiter guess reads, so a huge first field can't stall it. */
const SAMPLE_CHARS = 64 * 1024;

/**
 * The delimiter that splits the start of the file into the most rows of one
 * consistent width wider than a single column, the wider width breaking a tie.
 * A `.tsv` prefers tab on a full tie, anything else comma, then semicolon, then
 * tab, so a single-column file or one the sample can't decide keeps the
 * delimiter its extension names.
 */
export function detectDelimiter(text: string, extension: string | null): Delimiter {
  const order: readonly Delimiter[] =
    extension?.toLowerCase() === "tsv" ? ["\t", ",", ";"] : [",", ";", "\t"];
  const sample = text.length > SAMPLE_CHARS ? text.slice(0, SAMPLE_CHARS) : text;
  let best: Delimiter = order[0]!;
  let bestRows = 0;
  let bestWidth = 0;
  for (const delimiter of order) {
    const records = parseDelimited(sample, delimiter, SAMPLE_RECORDS);
    // A sample cut mid-file may end in a partial record; it says nothing.
    if (text.length > SAMPLE_CHARS && records.length > 1) records.pop();
    const widths = new Map<number, number>();
    for (const record of records) {
      if (record.length > 1) widths.set(record.length, (widths.get(record.length) ?? 0) + 1);
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
  /** The first record, padded with empty names to {@link columnCount}. */
  header: string[];
  /** Every record after the first, as written: rows may be shorter or longer than the header. */
  rows: string[][];
  /** The widest record's field count. */
  columnCount: number;
}

/** Reads a delimited file as a header row over data rows. */
export function readDelimitedTable(text: string, extension: string | null): DelimitedTable {
  const delimiter = detectDelimiter(text, extension);
  const records = parseDelimited(text, delimiter);
  let columnCount = 0;
  for (const record of records) {
    if (record.length > columnCount) columnCount = record.length;
  }
  const first = records[0] ?? [];
  const header = Array.from({ length: columnCount }, (_, index) => first[index] ?? "");
  return { delimiter, header, rows: records.slice(1), columnCount };
}
