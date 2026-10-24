import { useRef, useState } from "react";
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
import { field, useKitOwnerAttributes } from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";
import { ALIGN_CLASS, DENSITY_TEXT_CLASS, type TableDensity } from "./PluginKitLists";
import type { RowKey } from "./kitDataTableModel";
import type { RichColumn } from "./kitDataTableColumns";

export function startValue(column: RichColumn, row: unknown): string {
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

/**
 * Scrolls the cell being edited out from under the pinned column on the left
 * and the Columns rail on the right. Native focus scrolling ignores both.
 */
export function revealEditCell(scroller: HTMLElement, rail: number): void {
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
