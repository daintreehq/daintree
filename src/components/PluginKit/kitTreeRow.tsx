import type { MouseEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { LIST_DETAIL_ROW_CLASS } from "@/components/ui/paletteRowStyles";
import { Spinner } from "@/components/ui/Spinner";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_INLINE_LOADING_GATE_MS } from "@/lib/animationUtils";
import { cn } from "@/lib/utils";

// The kit's tree rows, one geometry for FileTree, TreeView and ObjectInspector:
// the host browser's (FileTreeView), so a plugin tree lines up with it.

export const TREE_INDENT_PX = 12;
export const TREE_BASE_PADDING_PX = 6;
export const TREE_ROW_HEIGHT_PX = 24;

export function treeRowPadding(depth: number): number {
  return TREE_BASE_PADDING_PX + depth * TREE_INDENT_PX;
}

/** The row box; the resting tone and the selected weight are the caller's. */
export const TREE_ROW_CLASS = cn(
  "flex h-6 w-full cursor-default select-none items-center gap-1 rounded-[var(--radius-md)] pr-2 text-xs",
  LIST_DETAIL_ROW_CLASS
);

/**
 * The disclosure. It opens and closes without moving the selection, as in
 * the host tree; the row itself carries `aria-expanded`.
 */
export function TreeChevron({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (event: MouseEvent<HTMLElement>) => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <span
      aria-hidden="true"
      data-tree-chevron=""
      onClick={(event) => {
        event.stopPropagation();
        onToggle(event);
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      className="flex h-4 w-4 shrink-0 items-center justify-center text-text-secondary"
    >
      <Chevron className="h-3 w-3" />
    </span>
  );
}

/** The gutter a leaf keeps so its content lines up under its parent's. */
export function TreeGutter() {
  return <span data-file-tree-gutter="" className="h-4 w-4 shrink-0" />;
}

// Per-item waits use the inline gate: most land inside it, where an indicator
// would only flash (FileTreeView's folder spinner).
export function GatedLoading() {
  const show = useDeferredLoading(true, UI_INLINE_LOADING_GATE_MS);
  if (!show) return <span className="sr-only">Loading…</span>;
  return (
    <>
      <Spinner size="xs" />
      <span>Loading…</span>
    </>
  );
}

export function GatedSpinner() {
  const show = useDeferredLoading(true, UI_INLINE_LOADING_GATE_MS);
  return show ? <Spinner size="xs" /> : null;
}

/**
 * A key as a DOM id fragment. A lone surrogate (a malformed string from
 * untyped JS) makes `encodeURIComponent` throw, so each is written as
 * `%u` and its code, which no encoded character can spell.
 */
export function idPart(key: string): string {
  try {
    return encodeURIComponent(key);
  } catch {
    let out = "";
    let run = "";
    for (let index = 0; index < key.length; index += 1) {
      const code = key.charCodeAt(index);
      const high = code >= 0xd800 && code <= 0xdbff;
      const low = code >= 0xdc00 && code <= 0xdfff;
      const next = key.charCodeAt(index + 1);
      if (high && next >= 0xdc00 && next <= 0xdfff) {
        run += key.slice(index, index + 2);
        index += 1;
      } else if (high || low) {
        out += `${encodeURIComponent(run)}%u${code.toString(16)}`;
        run = "";
      } else {
        run += key[index];
      }
    }
    return out + encodeURIComponent(run);
  }
}
