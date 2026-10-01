import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Virtuoso, type ListRange, type VirtuosoHandle } from "react-virtuoso";
import type { PluginObjectInspectorProps } from "@shared/types/plugin-sdk-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/CopyButton";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  stopContextMenuPropagation,
} from "@/components/ui/context-menu";
import { HighlightedText, substringMatchIndices } from "@/components/ui/HighlightedText";
import { SearchField } from "@/components/ui/SearchField";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  resolveTreeKey,
  resolveTypeahead,
  TYPEAHEAD_RESET_MS,
} from "@/panels/file-browser/fileBrowserTree";
import { fn, nonEmpty, pickRootProps, positive, str, useKitOwnerAttributes } from "./kitProps";
import { isMenuKey } from "./kitMenu";
import { useKitOverlayZClass } from "./kitScope";
import {
  buildInspectorRows,
  copyTextOf,
  DEFAULT_CHUNK,
  DEFAULT_MAX_STRING,
  MAX_INSPECTOR_ROWS,
  type InspectorRow,
  type ValueKind,
} from "./kitObjectInspectorModel";
import { idPart, TREE_ROW_HEIGHT_PX, TreeChevron, TreeGutter, treeRowPadding } from "./kitTreeRow";

// The host console's value colours (DevPreview's ObjectInspector): strings and
// numbers in the syntax tokens CodeBlock uses, booleans in the category
// purple, and the empty values quiet.
const VALUE_CLASS: Record<ValueKind, string> = {
  string: "text-syntax-string",
  number: "text-syntax-number",
  bigint: "text-syntax-number",
  boolean: "text-category-purple",
  null: "text-text-secondary",
  undefined: "text-text-secondary",
  date: "text-syntax-string",
  symbol: "text-syntax-keyword",
  function: "text-category-cyan italic",
  circular: "text-text-secondary italic",
  object: "text-text-secondary",
  array: "text-text-secondary",
  map: "text-text-secondary",
  set: "text-text-secondary",
};

function Highlight({ text, query }: { text: string; query: string }) {
  return (
    <HighlightedText text={text} indices={query ? substringMatchIndices(text, query) : undefined} />
  );
}

interface InspectorContext {
  cursorPath: string | null;
  filter: string;
  rowId: (path: string) => string;
  menuPath: string | null;
  onRowClick: (row: InspectorRow) => void;
  onToggle: (row: InspectorRow) => void;
  onMore: (row: InspectorRow) => void;
  onCopy: (row: InspectorRow, what: "value" | "path") => void;
}

function InspectorRowView({ row, context }: { row: InspectorRow; context: InspectorContext }) {
  const cursor = context.cursorPath === row.path;
  const keyText = row.key;
  return (
    <div
      id={context.rowId(row.path)}
      role="treeitem"
      aria-label={row.key === null ? row.preview : `${row.key}: ${row.preview}`}
      aria-level={row.depth + 1}
      aria-posinset={row.posInSet}
      aria-setsize={row.setSize}
      aria-selected={cursor}
      {...(row.isDirectory && { "aria-expanded": row.isExpanded })}
      data-inspector-path={row.path}
      data-state={context.menuPath === row.path ? "open" : undefined}
      onClick={() => context.onRowClick(row)}
      style={{ paddingLeft: treeRowPadding(row.depth) }}
      className={cn(
        "group/row palette-row relative flex min-h-6 w-full cursor-default select-text items-start gap-1 rounded-[var(--radius-md)] border border-transparent pr-14 font-mono text-xs leading-6",
        "aria-selected:bg-overlay-highlight not-aria-selected:hover:bg-overlay-subtle",
        "data-[state=open]:outline data-[state=open]:outline-1 data-[state=open]:-outline-offset-1 data-[state=open]:outline-border-strong"
      )}
    >
      <span className="flex h-6 shrink-0 items-center">
        {row.isDirectory ? (
          <TreeChevron expanded={row.isExpanded} onToggle={() => context.onToggle(row)} />
        ) : (
          <TreeGutter />
        )}
      </span>
      {keyText !== null ? (
        <span className="shrink-0 whitespace-pre text-text-secondary">
          {row.keyKind === "range" ? keyText : <Highlight text={keyText} query={context.filter} />}
          {row.keyKind === "range" ? null : <span className="text-syntax-punctuation">:</span>}
        </span>
      ) : null}
      {row.keyKind === "range" ? null : (
        <span
          className={cn(
            "min-w-0",
            row.truncated || row.kind !== "string" ? "truncate" : "whitespace-pre-wrap break-all",
            VALUE_CLASS[row.kind]
          )}
        >
          {row.isDirectory || row.kind === "circular" ? (
            row.preview
          ) : (
            <Highlight text={row.preview} query={context.filter} />
          )}
        </span>
      )}
      {row.truncated ? (
        <button
          type="button"
          tabIndex={-1}
          onClick={(event) => {
            event.stopPropagation();
            context.onMore(row);
          }}
          className="shrink-0 rounded-[var(--radius-xs)] font-sans text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
        >
          more
        </button>
      ) : null}
      <span
        className={cn(
          "absolute right-1 top-0 hidden h-6 items-center gap-0.5",
          "group-hover/row:flex",
          cursor && "flex"
        )}
      >
        <CopyButton
          text={() => copyTextOf(row.value, row.kind)}
          aria-label="Copy value"
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          className="h-5 w-5 text-text-secondary"
        />
      </span>
    </div>
  );
}

function renderInspectorRow(
  _index: number,
  row: InspectorRow,
  context: InspectorContext
): ReactNode {
  return <InspectorRowView row={row} context={context} />;
}

function inspectorRowKey(_index: number, row: InspectorRow): string {
  return row.path;
}

function useControllable<T>(
  controlled: T | undefined,
  initial: () => T,
  onChange: ((value: T) => void) | undefined
): [T, (value: T) => void] {
  const [own, setOwn] = useState<T>(initial);
  const value = controlled ?? own;
  const set = (next: T) => {
    if (controlled === undefined) setOwn(next);
    onChange?.(next);
  };
  return [value, set];
}

function readDepth(value: unknown): number {
  if (value === Infinity) return Infinity;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 1;
}

function KitObjectInspector(props: PluginObjectInspectorProps) {
  const {
    value,
    name,
    expandDepth,
    toolbar,
    filter: filterProp,
    defaultFilter,
    onFilterChange,
    maxStringLength,
    arrayChunkSize,
    sortKeys,
    "aria-label": ariaLabel,
    className,
  } = props;
  const [depth, setDepth] = useState(() => readDepth(expandDepth));
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [fullStrings, setFullStrings] = useState<ReadonlySet<string>>(() => new Set());
  const [filter, setFilter] = useControllable<string>(
    typeof filterProp === "string" ? filterProp : undefined,
    () => str(defaultFilter) ?? "",
    fn(onFilterChange)
  );
  const build = buildInspectorRows(value, {
    name: nonEmpty(name) ?? null,
    expandDepth: depth,
    overrides,
    filter,
    maxStringLength: Math.floor(positive(maxStringLength, 1_000_000) ?? DEFAULT_MAX_STRING),
    chunkSize: Math.floor(positive(arrayChunkSize, 100_000) ?? DEFAULT_CHUNK),
    sortKeys: sortKeys === true,
    expandedStrings: fullStrings,
    maxRows: MAX_INSPECTOR_ROWS,
  });
  const rows = build.rows;
  const byPath = new Map(rows.map((row) => [row.path, row]));

  const [ownCursor, setCursor] = useState<string | null>(null);
  const cursorPath = ownCursor !== null && byPath.has(ownCursor) ? ownCursor : null;
  const cursorIndex = cursorPath === null ? -1 : rows.findIndex((row) => row.path === cursorPath);
  const [announcement, setAnnouncement] = useState("");
  const { copy: writeCopy } = useCopyWithFeedback();

  const baseId = useId();
  const rowId = (path: string) => `${baseId}oi-${idPart(path)}`;
  const virtuoso = useRef<VirtuosoHandle>(null);
  const container = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ buffer: "", at: 0 });
  const [range, setRange] = useState<ListRange | null>(null);
  useEffect(() => {
    if (cursorIndex >= 0)
      virtuoso.current?.scrollIntoView({ index: cursorIndex, behavior: "auto" });
  }, [cursorIndex]);

  const toggle = (row: InspectorRow, open: boolean) => {
    if (!row.isDirectory || row.isExpanded === open) return;
    setOverrides((current) => new Map(current).set(row.path, open));
  };
  const showMore = (row: InspectorRow) => {
    if (!row.truncated) return;
    setFullStrings((current) => new Set(current).add(row.path));
  };
  const copy = (row: InspectorRow, what: "value" | "path") => {
    const text = what === "value" ? copyTextOf(row.value, row.kind) : row.copyPath;
    if (what === "path" && text === "") return;
    void writeCopy(text).then((ok) => {
      if (!ok) setAnnouncement("Couldn't copy");
    });
  };

  const [menu, setMenu] = useState<{ path: string | null; open: boolean }>({
    path: null,
    open: false,
  });
  const menuRow = menu.path === null ? undefined : byPath.get(menu.path);
  const owner = useKitOwnerAttributes();
  const overlayZ = useKitOverlayZClass();
  const openMenu = (event: MouseEvent<HTMLElement>) => {
    const target =
      event.target instanceof Element ? event.target.closest("[data-inspector-path]") : null;
    const path = target?.getAttribute("data-inspector-path") ?? null;
    if (path === null || !byPath.has(path)) {
      event.preventDefault();
      return;
    }
    stopContextMenuPropagation(event);
    setCursor(path);
    setMenu({ path, open: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const current = cursorPath === null ? undefined : byPath.get(cursorPath);
    if (isMenuKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      const element = cursorPath === null ? null : document.getElementById(rowId(cursorPath));
      if (!element) return;
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(
        new globalThis.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 8,
          clientY: rect.top + rect.height / 2,
        })
      );
      return;
    }
    const primary = isMac() ? event.metaKey : event.ctrlKey;
    if (primary && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c") {
      // A text selection inside the rows copies as text, as anywhere else.
      if (current && !window.getSelection()?.toString()) {
        event.preventDefault();
        copy(current, "value");
      }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length === 1 && event.key !== " ") {
      const now = Date.now();
      const state = typeahead.current;
      const buffer = now - state.at > TYPEAHEAD_RESET_MS ? event.key : state.buffer + event.key;
      typeahead.current = { buffer, at: now };
      const match = resolveTypeahead(buffer, rows, cursorPath);
      if (match !== null) {
        event.preventDefault();
        setCursor(match);
      }
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && current) {
      event.preventDefault();
      if (current.truncated) showMore(current);
      else if (current.isDirectory) toggle(current, !current.isExpanded);
      return;
    }
    const intent = resolveTreeKey(event.key, rows, cursorPath);
    if (!intent) return;
    event.preventDefault();
    const row = byPath.get(intent.path);
    if (!row) return;
    if (intent.type === "select") setCursor(row.path);
    else if (intent.type === "expand") toggle(row, true);
    else if (intent.type === "collapse") toggle(row, false);
  };

  const query = filter.trim();
  const context: InspectorContext = {
    cursorPath,
    filter: query,
    rowId,
    menuPath: menu.open ? menu.path : null,
    onRowClick: (row) => setCursor(row.path),
    onToggle: (row) => toggle(row, !row.isExpanded),
    onMore: showMore,
    onCopy: copy,
  };
  const mounted =
    cursorIndex >= 0 &&
    range !== null &&
    cursorIndex >= range.startIndex &&
    cursorIndex <= range.endIndex;
  const label = str(ariaLabel) ?? "";
  const showToolbar = toolbar !== false;
  const allOpen = depth === Infinity && overrides.size === 0;

  return (
    <div
      {...pickRootProps(props)}
      className={cn("flex h-full min-h-0 w-full flex-col", str(className))}
    >
      {showToolbar ? (
        <div className="flex shrink-0 items-center gap-1 border-b border-divider px-2 py-1">
          <SearchField
            size="dense"
            value={filter}
            placeholder="Filter keys and values"
            aria-label={`Filter ${label || "value"}`}
            onChange={(event) => setFilter(event.target.value)}
            onClear={() => setFilter("")}
            fieldClassName="min-w-0 flex-1"
          />
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setOverrides(new Map());
              setDepth(allOpen ? 1 : Infinity);
            }}
          >
            {allOpen ? "Collapse all" : "Expand all"}
          </Button>
        </div>
      ) : null}
      <ContextMenu
        onOpenChange={(open) => {
          if (!open) setMenu((state) => ({ ...state, open: false }));
        }}
      >
        <ContextMenuTrigger asChild onContextMenu={openMenu}>
          <div
            ref={container}
            role="tree"
            aria-label={label}
            aria-activedescendant={mounted && cursorPath !== null ? rowId(cursorPath) : undefined}
            tabIndex={0}
            data-row-menu=""
            onKeyDown={onKeyDown}
            onFocus={(event) => {
              if (event.target === event.currentTarget && cursorPath === null && rows[0]) {
                setCursor(rows[0].path);
              }
            }}
            onPointerDown={(event) => {
              if (event.target instanceof Element && event.target.closest("button")) return;
              container.current?.focus({ preventScroll: true });
            }}
            className={cn(
              "min-h-0 w-full flex-1 overflow-hidden py-1 focus-visible:-outline-offset-2",
              "focus-visible:[&_[aria-selected=true]]:outline focus-visible:[&_[aria-selected=true]]:outline-2 focus-visible:[&_[aria-selected=true]]:-outline-offset-2 focus-visible:[&_[aria-selected=true]]:outline-accent-primary"
            )}
          >
            {rows.length === 0 || (query !== "" && !build.matched) ? (
              <p className="px-3 py-2 text-xs text-text-secondary">
                {query ? `Nothing matches "${query}"` : "No value"}
              </p>
            ) : (
              <Virtuoso<InspectorRow, InspectorContext>
                ref={virtuoso}
                data={rows}
                context={context}
                computeItemKey={inspectorRowKey}
                itemContent={renderInspectorRow}
                defaultItemHeight={TREE_ROW_HEIGHT_PX}
                rangeChanged={(next) =>
                  setRange((current) =>
                    current?.startIndex === next.startIndex && current.endIndex === next.endIndex
                      ? current
                      : next
                  )
                }
                className="h-full w-full overflow-y-auto"
              />
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent {...owner} className={overlayZ}>
          <ContextMenuItem
            onSelect={() => {
              if (menuRow) copy(menuRow, "value");
            }}
          >
            Copy value
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!menuRow || menuRow.copyPath === ""}
            onSelect={() => {
              if (menuRow) copy(menuRow, "path");
            }}
          >
            Copy path
          </ContextMenuItem>
          {menuRow?.isDirectory ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => toggle(menuRow, !menuRow.isExpanded)}>
                {menuRow.isExpanded ? "Collapse" : "Expand"}
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
      {build.clipped ? (
        <p className="shrink-0 border-t border-divider px-3 py-1 text-xs text-text-secondary">
          Showing the first {MAX_INSPECTOR_ROWS.toLocaleString()} rows
        </p>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}

export const pluginKitObjectInspector = { ObjectInspector: KitObjectInspector };
