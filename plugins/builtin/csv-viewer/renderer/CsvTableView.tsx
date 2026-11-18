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
import { readDelimitedTable, type DelimitedTable, type Delimiter } from "./delimited";

/**
 * Columns drawn at once. The table virtualises rows but draws every column it
 * is given, and a file under the size cap can hold a record with hundreds of
 * thousands of fields, so a wider file is shown a window of columns at a time.
 */
export const COLUMN_WINDOW = 200;

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

/** Each column's width from its header and the first rows, so a wide table scrolls sideways. */
function columnWidths(table: DelimitedTable): number[] {
  const longest = table.header.map((name) => name.length);
  const sampled = table.rows.length > WIDTH_SAMPLE_ROWS ? WIDTH_SAMPLE_ROWS : table.rows.length;
  for (let r = 0; r < sampled; r += 1) {
    const row = table.rows[r]!;
    for (let c = 0; c < row.length; c += 1) {
      const length = row[c]!.length;
      if (length > longest[c]!) longest[c] = length;
    }
  }
  return longest.map(columnWidth);
}

/**
 * A CSV or TSV file as a read-only table (#17336): the first record as the
 * header, every record after it as a row in file order, through the host-owned
 * document. Nothing here can write the file.
 */
export function CsvTableView({ fileDocument }: PanelViewProps) {
  const [state, setState] = useState<ViewState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [columnOffset, setColumnOffset] = useState(0);
  const extension = fileDocument ? extensionOf(fileDocument.fileName) : null;

  useEffect(() => {
    if (!fileDocument) return;
    let disposed = false;
    let latest = 0;
    let shownRevision: string | null = null;
    const load = () => {
      const request = ++latest;
      fileDocument.read().then(
        (result) => {
          if (disposed || request !== latest) return;
          if (result.status !== "ok") {
            shownRevision = null;
            setState({ status: result.status });
            return;
          }
          if (result.revision === shownRevision) return;
          shownRevision = result.revision;
          setState({ status: "ready", table: readDelimitedTable(result.text, extension) });
        },
        () => {
          if (disposed || request !== latest) return;
          shownRevision = null;
          setState({ status: "unavailable" });
        }
      );
    };
    // Subscribed before the first read, so a change that lands while it is in
    // flight starts a newer read rather than being lost.
    const unsubscribe = fileDocument.onDidChange(load);
    load();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [fileDocument, extension, attempt]);

  const table = state.status === "ready" ? state.table : null;
  const columnCount = table?.columnCount ?? 0;
  // A file that lost columns since the window moved keeps a window that exists.
  const offset =
    columnOffset < columnCount ? columnOffset : Math.max(0, columnCount - COLUMN_WINDOW);
  const widths = useMemo(() => (table ? columnWidths(table) : []), [table]);

  const columns = useMemo<DataTableColumn<Row>[]>(() => {
    if (!table) return [];
    const end = Math.min(columnCount, offset + COLUMN_WINDOW);
    const digits = String(table.rows.length).length;
    const out: DataTableColumn<Row>[] = [
      {
        id: "row",
        header: "#",
        menuLabel: "Row",
        width: columnWidth(Math.max(2, digits)),
        numeric: true,
        render: (_row, index) => index + 1,
      },
    ];
    for (let index = offset; index < end; index += 1) {
      const name = table.header[index] ?? "";
      out.push({
        id: `c${index}`,
        header: name === "" ? `Column ${index + 1}` : name,
        width: widths[index] ?? MIN_COLUMN_PX,
        resizable: true,
        render: (row) => row[index] ?? "",
      });
    }
    return out;
  }, [table, columnCount, offset, widths]);

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

  const windowed = columnCount > COLUMN_WINDOW;
  const windowEnd = Math.min(columnCount, offset + COLUMN_WINDOW);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="csv-table-view">
      <div className="min-h-0 flex-1">
        <DataTable<Row>
          aria-label={fileDocument.fileName}
          columns={columns}
          rows={table.rows}
          rowKey={(_row, index) => index}
          density="compact"
          rowDividers
          stickyFirstColumn
        />
      </div>
      <StatusBar
        aria-label="Table details"
        left={[
          pluralize(table.rows.length, "row"),
          pluralize(columnCount, "column"),
          DELIMITER_NAMES[table.delimiter],
        ]}
        right={
          windowed
            ? [
                `Columns ${(offset + 1).toLocaleString()}–${windowEnd.toLocaleString()} of ${columnCount.toLocaleString()}`,
                <IconButton
                  key="previous"
                  icon="chevron-left"
                  aria-label="Previous columns"
                  disabled={offset === 0}
                  onClick={() => setColumnOffset(Math.max(0, offset - COLUMN_WINDOW))}
                />,
                <IconButton
                  key="next"
                  icon="chevron-right"
                  aria-label="Next columns"
                  disabled={windowEnd >= columnCount}
                  onClick={() => setColumnOffset(offset + COLUMN_WINDOW)}
                />,
              ]
            : undefined
        }
      />
    </div>
  );
}
