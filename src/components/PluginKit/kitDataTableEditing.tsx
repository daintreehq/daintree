import { useEffect, useRef, useState } from "react";
import type { PluginDataTableProps } from "@shared/types/plugin-sdk-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { field, fn, useKitOwnerAttributes } from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";
import { ALIGN_CLASS, DENSITY_TEXT_CLASS, type TableDensity } from "./PluginKitLists";
import type { DrawnItem, DrawnRow, RowKey } from "./kitDataTableModel";
import { errorMessage } from "./kitLazyChildren";
import { isThenable } from "./kitDiagnostics";
import { omitKey } from "./kitDataTableShared";
import type { RichColumn } from "./kitDataTableColumns";

function startValue(column: RichColumn, row: unknown): string {
  if (column.editValue) return column.editValue(row);
  if (typeof row !== "object" || row === null) return "";
  const value = field(row, column.id);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export interface CellEdit {
  key: RowKey;
  columnId: string;
  draft: string;
  error: string | undefined;
}

export type CellMove = "next" | "previous" | null;

export function cellId(key: RowKey, columnId: string): string {
  return `${typeof key}:${key}\u0000${columnId}`;
}

/**
 * Scrolls the cell being edited out from under the pinned column on the left
 * and the Columns rail on the right. Native focus scrolling ignores both.
 */
function revealEditCell(scroller: HTMLElement, rail: number): void {
  const cell = scroller.querySelector<HTMLElement>("td[data-edit-cell]");
  if (!cell) return;
  const view = scroller.getBoundingClientRect();
  const box = cell.getBoundingClientRect();
  let pinned = 0;
  for (const stuck of scroller.querySelectorAll<HTMLElement>("thead th.kit-dt-sticky")) {
    const rect = stuck.getBoundingClientRect();
    if (rect.left < view.left + view.width / 2) pinned = Math.max(pinned, rect.right - view.left);
  }
  const left = view.left + pinned;
  const right = view.right - rail;
  if (box.left < left) scroller.scrollLeft -= left - box.left;
  else if (box.right > right) scroller.scrollLeft += Math.min(box.right - right, box.left - left);
}

export function CellEditor({
  column,
  edit,
  label,
  density,
  onDraft,
  onCommit,
  onCancel,
}: {
  column: RichColumn;
  edit: CellEdit;
  label: string;
  /** The field stays 24px tall; its type follows the table's. */
  density: TableDensity;
  onDraft: (draft: string) => void;
  /** False when the draft was refused and the editor stays open. */
  onCommit: (draft: string, move: CellMove) => boolean;
  onCancel: () => void;
}) {
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  // Enter, Tab and Escape settle the edit themselves; the blur that follows
  // as focus goes back to the grid must not commit it a second time.
  const settled = useRef(false);
  const settle = (run: () => boolean | void) => {
    if (settled.current) return;
    settled.current = true;
    if (run() === false) settled.current = false;
  };
  const invalid = edit.error !== undefined;
  // The open tooltip is the description: Radix appends its content id to the
  // trigger's aria-describedby, so a second copy of the message here would be
  // announced twice.
  const described = invalid ? { "aria-invalid": true } : {};

  // A select commits as soon as a choice is made; a refused choice keeps the
  // list open (Radix closes it after every choice) with the message showing.
  const [open, setOpen] = useState(true);
  const refused = useRef(false);
  const control =
    column.editor === "select" ? (
      <Select
        open={open}
        value={edit.draft === "" ? undefined : edit.draft}
        onValueChange={(value) => {
          onDraft(value);
          settle(() => {
            const accepted = onCommit(value, null);
            refused.current = !accepted;
            return accepted;
          });
        }}
        onOpenChange={(next) => {
          if (next) {
            setOpen(true);
            return;
          }
          if (refused.current) {
            refused.current = false;
            return;
          }
          setOpen(false);
          settle(onCancel);
        }}
      >
        <SelectTrigger
          aria-label={label}
          density="compact"
          {...described}
          className={cn("h-6 w-full min-w-0", DENSITY_TEXT_CLASS[density])}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          {...owner}
          className={overlayZ}
          onKeyDown={(event) => {
            // The list holds focus while open; Tab still moves to the next cell.
            if (event.key !== "Tab") return;
            event.preventDefault();
            event.stopPropagation();
            settle(() => onCommit(edit.draft, event.shiftKey ? "previous" : "next"));
          }}
        >
          {column.editOptions.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : (
      <Input
        autoFocus
        density="compact"
        type={column.editor === "number" ? "number" : "text"}
        aria-label={label}
        invalid={invalid}
        {...described}
        value={edit.draft}
        onChange={(event) => onDraft(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            settle(() => onCommit(event.currentTarget.value, null));
          } else if (event.key === "Escape") {
            event.preventDefault();
            settle(onCancel);
          } else if (event.key === "Tab") {
            event.preventDefault();
            settle(() => onCommit(event.currentTarget.value, event.shiftKey ? "previous" : "next"));
          }
        }}
        onBlur={(event) => settle(() => onCommit(event.currentTarget.value, null))}
        // The draft sits where the value did, so an end-aligned figure does not jump.
        className={cn(
          "h-6 w-full min-w-0 px-1.5 focus-visible:-outline-offset-2",
          DENSITY_TEXT_CLASS[density],
          ALIGN_CLASS[column.align],
          column.numeric && "tabular-nums"
        )}
      />
    );
  // One structure whether or not there is an error, so the field is never
  // remounted (and blurred) when a refusal arrives.
  return (
    <Tooltip open={invalid}>
      <TooltipTrigger asChild>{control}</TooltipTrigger>
      <TooltipContent side="bottom" align="start" className={overlayZ}>
        {edit.error}
      </TooltipContent>
    </Tooltip>
  );
}

export interface DataTableEditing {
  /** Whether any shown column can be edited. */
  canEdit: boolean;
  edit: CellEdit | null;
  /** Saves still running, by `cellId`: the cell shows the draft and a spinner. */
  pending: Record<string, { draft: string; generation: number }>;
  /** Saves that failed while the reader was elsewhere, by `cellId`. */
  failures: Record<string, { draft: string; error: string }>;
  /** The latest refusal or failure, for the live region. */
  message: string;
  beginEdit: (row: DrawnRow, column: RichColumn, draft?: string, error?: string) => void;
  changeDraft: (draft: string) => void;
  commitEdit: (draft: string, move: CellMove) => boolean;
  cancelEdit: () => void;
  /** Opens the row's first editable cell; false when it has none. */
  editRow: (index: number) => boolean;
}

/** In-place cell edits: the open editor, saves in flight, and saves that failed. */
export function useDataTableEditing({
  items,
  visible,
  onCellEdit,
  scroller,
  trailing,
  moveCursor,
  focusGrid,
}: {
  items: readonly DrawnItem[];
  visible: readonly RichColumn[];
  onCellEdit: PluginDataTableProps["onCellEdit"];
  scroller: HTMLElement | null;
  /** The Columns rail's width, which an opened editor is scrolled out from under. */
  trailing: number;
  moveCursor: (index: number, reveal?: boolean) => void;
  focusGrid: () => void;
}): DataTableEditing {
  const cellEdit = fn(onCellEdit);
  const editableColumns = visible.filter((column) => column.editable !== null);
  const canEdit = editableColumns.length > 0;
  // Edits.
  const [edit, setEdit] = useState<CellEdit | null>(null);
  const [pending, setPending] = useState<Record<string, { draft: string; generation: number }>>({});
  // Saves that failed while the reader was editing elsewhere: the cell keeps
  // the draft and the error until it is edited again.
  const [failures, setFailures] = useState<Record<string, { draft: string; error: string }>>({});
  const saveGeneration = useRef(0);
  const latestSave = useRef(new Map<string, number>());
  const [message, setMessage] = useState("");
  const editableIn = (row: unknown) =>
    editableColumns.filter((column) => column.editable !== null && column.editable(row));
  const rowItemByKey = (key: RowKey): { item: DrawnRow; index: number } | null => {
    const index = items.findIndex((item) => item.kind === "row" && item.key === key);
    const item = items[index];
    return item?.kind === "row" ? { item, index } : null;
  };
  const beginEdit = (row: DrawnRow, column: RichColumn, draft?: string, error?: string) => {
    const failure = failures[cellId(row.key, column.id)];
    setEdit({
      key: row.key,
      columnId: column.id,
      draft: draft ?? failure?.draft ?? startValue(column, row.row),
      error: error ?? failure?.error,
    });
  };
  const nextEditable = (from: DrawnRow, columnId: string, move: "next" | "previous") => {
    const start = items.findIndex((item) => item.id === from.id);
    const step = move === "next" ? 1 : -1;
    for (let index = start; index >= 0 && index < items.length; index += step) {
      const item = items[index];
      if (item?.kind !== "row") continue;
      const cells = editableIn(item.row);
      if (cells.length === 0) continue;
      if (index === start) {
        const at = cells.findIndex((column) => column.id === columnId);
        const candidate = cells[at + step];
        if (at >= 0 && candidate) return { item, index, column: candidate };
        continue;
      }
      const column = move === "next" ? cells[0] : cells[cells.length - 1];
      if (column) return { item, index, column };
    }
    return null;
  };
  const commitEdit = (draft: string, move: CellMove): boolean => {
    if (!edit) return true;
    const located = rowItemByKey(edit.key);
    const column = visible.find((candidate) => candidate.id === edit.columnId);
    if (!located || !column) {
      setEdit(null);
      return true;
    }
    const { item } = located;
    const id = cellId(item.key, column.id);
    if (failures[id]) setFailures((map) => omitKey(map, id));
    const refusal = column.validate?.(draft, item.row);
    if (refusal) {
      setEdit({ ...edit, draft, error: refusal });
      setMessage(refusal);
      return false;
    }
    const target = move ? nextEditable(item, column.id, move) : null;
    const leave = () => {
      if (target) {
        moveCursor(target.index);
        beginEdit(target.item, target.column);
      } else {
        setEdit(null);
        focusGrid();
      }
    };
    // Back to the stored value is no edit, even after a failed save: there is
    // nothing to send, and the failure was dropped above.
    if (draft === startValue(column, item.row) || !cellEdit) {
      leave();
      return true;
    }
    const failed: CellEdit = { key: item.key, columnId: column.id, draft, error: undefined };
    let result: unknown;
    try {
      result = cellEdit(item.row, column.id, draft);
    } catch (error) {
      // A save that throws at once is a failed save: the editor stays where it
      // is, focused, on the draft.
      const text = errorMessage(error);
      setMessage(text);
      setEdit({ ...failed, error: text });
      return false;
    }
    leave();
    if (!isThenable(result)) return true;
    // Each save of a cell is its own generation: only the newest one settles
    // the cell, so an older save landing late cannot clear a newer one's
    // spinner or bring back a draft the newer save replaced.
    saveGeneration.current += 1;
    const generation = saveGeneration.current;
    latestSave.current.set(id, generation);
    setPending((map) => ({ ...map, [id]: { draft, generation } }));
    const settleSave = (error: unknown, failedSave: boolean) => {
      setPending((map) => (map[id]?.generation === generation ? omitKey(map, id) : map));
      if (!failedSave) return;
      const text = errorMessage(error);
      setMessage(text);
      if (latestSave.current.get(id) !== generation) return;
      // Reopen only into an idle table. An edit the reader has moved on to
      // keeps its draft, and the failed cell keeps its own, marked, until
      // it is edited again.
      setFailures((map) => ({ ...map, [id]: { draft, error: text } }));
      // Reopening focuses the field, so it happens only while the reader is
      // still in this table; anywhere else the marked cell waits for them.
      const active = typeof document === "undefined" ? null : document.activeElement;
      if (scroller === null || active === null || !scroller.contains(active)) return;
      setEdit((current) => current ?? { ...failed, error: text });
    };
    Promise.resolve(result).then(
      () => settleSave(undefined, false),
      (error: unknown) => settleSave(error, true)
    );
    return true;
  };
  // An editor opened (or reached by Tab) under the pinned column or the
  // Columns rail is scrolled out from under them.
  const editKey = edit === null ? null : cellId(edit.key, edit.columnId);
  useEffect(() => {
    if (editKey !== null && scroller !== null) revealEditCell(scroller, trailing);
  }, [editKey, scroller, trailing]);
  // Escape discards the draft, a failed save's included: the cell shows the
  // row's value again rather than holding a draft only a successful save clears.
  const cancelEdit = () => {
    if (edit) {
      const id = cellId(edit.key, edit.columnId);
      if (failures[id]) setFailures((map) => omitKey(map, id));
    }
    setEdit(null);
    focusGrid();
  };
  const editRow = (index: number) => {
    const item = items[index];
    if (item?.kind !== "row") return false;
    const cells = editableIn(item.row);
    const column = cells[0];
    if (!column) return false;
    beginEdit(item, column);
    return true;
  };
  const changeDraft = (draft: string) => {
    if (edit) setEdit({ ...edit, draft });
  };
  return {
    canEdit,
    edit,
    pending,
    failures,
    message,
    beginEdit,
    changeDraft,
    commitEdit,
    cancelEdit,
    editRow,
  };
}
