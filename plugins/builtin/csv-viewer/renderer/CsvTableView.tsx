import { useEffect, useMemo, useState } from "react";
import {
  DataTable,
  IconButton,
  PaneState,
  StatusBar,
  type DataTableColumn,
} from "@daintreehq/plugin-ui";
import type { PanelViewProps } from "@shared/types/plugin";
import { pluralize } from "@shared/utils/pluralize";
import { utf8ByteLength } from "@shared/utils/folderUpload";
import { readDelimitedTable, type DelimitedTable, type Delimiter } from "./delimited";

/**
 * Columns drawn at once. The table virtualises rows but draws every column it
 * is given, and a file under the size cap can hold a record with hundreds of
 * thousands of fields, so a wider file is shown a window of columns at a time.
 */
export const COLUMN_WINDOW = 200;

/**
 * Rows handed to the table at once. It keeps a model object per row, and a
 * file under the size cap can hold millions of short records, so a longer file
 * is shown a window of rows at a time, each parsed only when shown.
 */
export const ROW_WINDOW = 50_000;

/** The manifest's `maxBytes`: a draft larger than this is more than the table opens. */
const MAX_TABLE_BYTES = 2 * 1024 * 1024;

/** Rows read to size the columns; enough to see a column's usual width. */
const WIDTH_SAMPLE_ROWS = 200;
const CHAR_PX = 7;
const CELL_PADDING_PX = 24;
const MIN_COLUMN_PX = 64;
const MAX_COLUMN_PX = 360;

const DELIMITER_NAMES: Record<Delimiter, string> = {
  ",": "Comma-separated",
  ";": "Semicolon-separated",
  "\t": "Tab-separated",
};

type Row = readonly string[];

type ViewState =
  | { status: "loading" }
  | { status: "ready"; table: DelimitedTable }
  | { status: "too-large" | "not-text" | "unavailable" };

function extensionOf(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : null;
}

function columnWidth(chars: number): number {
  return Math.min(MAX_COLUMN_PX, Math.max(MIN_COLUMN_PX, chars * CHAR_PX + CELL_PADDING_PX));
}

/** A window's start that exists: the first one when everything fits, else clamped to the last. */
function clampWindow(offset: number, total: number, size: number): number {
  if (total <= size) return 0;
  const last = Math.floor((total - 1) / size) * size;
  return Math.min(Math.max(0, offset - (offset % size)), last);
}

/**
 * A CSV or TSV file as a read-only table (#17336): the first record as the
 * header, every record after it as a row in file order, through the host-owned
 * document. Nothing here can write the file. While another editor holds an
 * unsaved draft of it, the table previews that draft, as Rendered does.
 */
export function CsvTableView({ fileDocument }: PanelViewProps) {
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [columnOffset, setColumnOffset] = useState(0);
  const [rowOffset, setRowOffset] = useState(0);
  const extension = fileDocument ? extensionOf(fileDocument.fileName) : null;

  useEffect(() => {
    if (!fileDocument) return;
    let disposed = false;
    let latest = 0;
    // What the table shows now, so a change that leaves it the same parses nothing.
    let shown: { draft: string } | { revision: string } | null = null;
    const show = (source: { draft: string } | { revision: string }, text: string) => {
      if (
        shown !== null &&
        ("draft" in source
          ? "draft" in shown && shown.draft === source.draft
          : "revision" in shown && shown.revision === source.revision)
      ) {
        return;
      }
      shown = source;
      setState({ status: "ready", table: readDelimitedTable(text, extension) });
    };
    const load = () => {
      const request = ++latest;
      const draft = fileDocument.getDraft();
      if (draft !== null) {
        if (draft.length > MAX_TABLE_BYTES || utf8ByteLength(draft) > MAX_TABLE_BYTES) {
          shown = null;
          setState({ status: "too-large" });
        } else {
          show({ draft }, draft);
        }
        return;
      }
      fileDocument.read().then(
        (result) => {
          if (disposed || request !== latest) return;
          if (result.status !== "ok") {
            shown = null;
            setState({ status: result.status });
            return;
          }
          show({ revision: result.revision }, result.text);
        },
        () => {
          if (disposed || request !== latest) return;
          shown = null;
          setState({ status: "unavailable" });
        }
      );
    };
    const unsubscribe = fileDocument.onDidChange(load);
    load();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [fileDocument, extension, attempt]);

  const table = state.status === "ready" ? state.table : null;
  const columnCount = table?.columnCount ?? 0;
  const rowCount = table?.rowCount ?? 0;
  // A file that changed under a moved window keeps a window that exists.
  const colStart = clampWindow(columnOffset, columnCount, COLUMN_WINDOW);
  const colEnd = Math.min(columnCount, colStart + COLUMN_WINDOW);
  const rowStart = clampWindow(rowOffset, rowCount, ROW_WINDOW);
  const rowEnd = Math.min(rowCount, rowStart + ROW_WINDOW);
  const rows = useMemo(
    () => (table ? table.rows(rowStart, rowEnd) : []),
    [table, rowStart, rowEnd]
  );

  const columns = useMemo<DataTableColumn<Row>[]>(() => {
    if (!table) return [];
    // Sized from the header and the window's first rows, so a wide table
    // scrolls sideways rather than squeezing every column.
    const longest = new Map<number, number>();
    const sample = rows.length > WIDTH_SAMPLE_ROWS ? rows.slice(0, WIDTH_SAMPLE_ROWS) : rows;
    for (let index = colStart; index < colEnd; index += 1) {
      let max = (table.header[index] ?? "").length;
      for (const row of sample) {
        const length = row[index]?.length ?? 0;
        if (length > max) max = length;
      }
      longest.set(index, max);
    }
    const out: DataTableColumn<Row>[] = [
      {
        id: "row",
        header: "#",
        menuLabel: "Row",
        width: columnWidth(Math.max(2, String(rowEnd).length)),
        numeric: true,
        render: (_row, index) => rowStart + index + 1,
      },
    ];
    for (let index = colStart; index < colEnd; index += 1) {
      const name = table.header[index] ?? "";
      out.push({
        id: `c${index}`,
        header: name === "" ? `Column ${index + 1}` : name,
        width: columnWidth(longest.get(index) ?? 0),
        resizable: true,
        render: (row) => row[index] ?? "",
      });
    }
    return out;
  }, [table, rows, colStart, colEnd, rowStart, rowEnd]);

  // A file editor host always hands over the document; without one there is
  // nothing to read.
  if (!fileDocument) {
    return (
      <PaneState
        kind="error"
        title="Couldn't read this file"
        description="No document was opened for it."
      />
    );
  }
  if (state.status === "loading") return null;
  if (state.status === "too-large") {
    return (
      <PaneState
        kind="error"
        title="Too large for the table"
        description="It's over the size this table opens. Open it outside Daintree instead."
      />
    );
  }
  if (state.status === "not-text") {
    return (
      <PaneState
        kind="error"
        title="Not a text file"
        description="It can't be read as UTF-8 text, so it can't be shown as a table."
      />
    );
  }
  if (state.status === "unavailable" || !table) {
    return (
      <PaneState
        kind="error"
        title="Couldn't read this file"
        description="It may have been moved or deleted."
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  }
  if (columnCount === 0) {
    return (
      <PaneState
        kind="empty"
        title="This file is empty"
        description="Rows show here once it has some."
      />
    );
  }

  const windowControls = (
    noun: string,
    start: number,
    end: number,
    total: number,
    size: number,
    setOffset: (offset: number) => void
  ) =>
    total > size ? (
      // One unit, so a narrow pane wraps whole groups and never clips a button.
      <span key={noun} className="inline-flex items-center gap-1">
        <span>{`${noun} ${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`}</span>
        <IconButton
          icon="chevron-left"
          aria-label={`Previous ${noun.toLowerCase()}`}
          disabled={start === 0}
          onClick={() => setOffset(Math.max(0, start - size))}
        />
        <IconButton
          icon="chevron-right"
          aria-label={`Next ${noun.toLowerCase()}`}
          disabled={end >= total}
          onClick={() => setOffset(start + size)}
        />
      </span>
    ) : null;
  const rowControls = windowControls("Rows", rowStart, rowEnd, rowCount, ROW_WINDOW, setRowOffset);
  const columnControls = windowControls(
    "Columns",
    colStart,
    colEnd,
    columnCount,
    COLUMN_WINDOW,
    setColumnOffset
  );
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="csv-table-view">
      <div className="min-h-0 flex-1">
        <DataTable<Row>
          aria-label={fileDocument.fileName}
          columns={columns}
          rows={rows}
          rowKey={(_row, index) => rowStart + index}
          density="compact"
          rowDividers
          stickyFirstColumn
        />
      </div>
      {(rowControls !== null || columnControls !== null) && (
        <div
          role="group"
          aria-label="Table pages"
          className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-divider px-2 py-1 text-xs text-text-secondary"
        >
          {rowControls}
          {columnControls}
        </div>
      )}
      <StatusBar
        aria-label="Table details"
        left={[
          pluralize(rowCount, "row"),
          pluralize(columnCount, "column"),
          DELIMITER_NAMES[table.delimiter],
        ]}
      />
    </div>
  );
}
