import {
  isValidElement,
  useContext,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import Fuse, { type FuseResultMatch } from "fuse.js";
import { Check, ChevronRight, MoreHorizontal } from "lucide-react";
import { Virtuoso, type ItemProps, type ListProps, type VirtuosoHandle } from "react-virtuoso";
import type {
  PluginBreadcrumbsProps,
  PluginCommandPaletteItem,
  PluginCommandPaletteProps,
  PluginContextMenuProps,
  PluginNavListProps,
  PluginSheetProps,
  PluginStepState,
  PluginStepperProps,
} from "@shared/types/plugin-sdk-react";
import { AppPaletteDialog, PaletteNoMatchHint } from "@/components/ui/AppPaletteDialog";
import { COUNT_BADGE_CLASS } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
  stopContextMenuPropagation,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { findMatchIndices, HighlightedText } from "@/components/ui/HighlightedText";
import { KbdChord } from "@/components/ui/Kbd";
import {
  LIST_ROW_HOVER_CLASS,
  PALETTE_ROW_CLASS,
  PALETTE_SECTION_LABEL_CLASS,
} from "@/components/ui/paletteRowStyles";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { formatCompactCount } from "@/lib/formatCount";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import { useListNavigation } from "@/pluginUi/listNavigation";
import { KitDialogFrame } from "./kitDialog";
import { renderMenuEntries, stopReactPropagation, type KitMenuParts } from "./kitMenu";
import {
  field,
  fn,
  node,
  nonEmpty,
  oneOf,
  pickRootProps,
  PluginStyleScope,
  str,
  useKitOwnerAttributes,
} from "./kitProps";
import { PluginKitLayerContext, useKitOverlayZClass } from "./kitScope";
import { sizedIcon } from "./PluginKitPatterns";

const CONTEXT_MENU_PARTS: KitMenuParts = {
  Item: ContextMenuItem,
  CheckboxItem: ContextMenuCheckboxItem,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
  Shortcut: ContextMenuShortcut,
};

function isMenuKey(event: KeyboardEvent): boolean {
  return (
    event.key === "ContextMenu" ||
    (event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey)
  );
}

/**
 * Shift+F10 and the Menu key, replayed as a `contextmenu` on the surface at
 * the focused element: Radix's context menu has no imperative open. Prevented
 * so the browser's own menu event cannot open it a second time.
 */
function openFromKeyboard(event: KeyboardEvent<HTMLElement>) {
  if (event.defaultPrevented || !isMenuKey(event)) return;
  const surface = event.currentTarget;
  const anchor = event.target instanceof Element ? event.target : surface;
  const rect = anchor.getBoundingClientRect();
  event.preventDefault();
  event.stopPropagation();
  surface.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 8,
      clientY: rect.top + rect.height / 2,
    })
  );
}

function KitContextMenu({
  children,
  items,
  onOpenChange,
  "aria-label": ariaLabel,
  disabled,
  onCloseAutoFocus,
  stopPropagation,
}: PluginContextMenuProps) {
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  if (!isValidElement(children)) return null;
  if (disabled === true) return children;
  const closeAutoFocus = fn(onCloseAutoFocus);
  const isolate = stopPropagation === true;
  return (
    <ContextMenu onOpenChange={fn(onOpenChange)}>
      <ContextMenuTrigger
        asChild
        // The global Shift+F10 handler opens the focused panel's menu; this
        // marker makes it stand down so the keys reach this surface's own.
        data-row-menu=""
        onKeyDown={openFromKeyboard}
        // A menu belongs to the object under the pointer, so an enclosing
        // kit ContextMenu does not open as well.
        onContextMenu={stopContextMenuPropagation}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        {...owner}
        className={overlayZ}
        aria-label={str(ariaLabel)}
        onCloseAutoFocus={closeAutoFocus ? (event) => closeAutoFocus(event) : undefined}
        onClick={isolate ? stopReactPropagation : undefined}
        onPointerDown={isolate ? stopReactPropagation : undefined}
        onKeyDown={isolate ? stopReactPropagation : undefined}
      >
        {renderMenuEntries(CONTEXT_MENU_PARTS, items)}
      </ContextMenuContent>
    </ContextMenu>
  );
}

const SHEET_SIZE = { sm: "sm", md: "md", lg: "lg", xl: "4xl" } as const;

function KitSheet({
  open,
  onOpenChange,
  title,
  icon,
  description,
  children,
  side,
  size,
  primaryAction,
  secondaryAction,
  hint,
  footer,
  dismissible,
  layer,
  "data-testid": testId,
}: PluginSheetProps) {
  const change = fn(onOpenChange);
  return (
    <KitDialogFrame
      open={open}
      onClose={change ? () => change(false) : undefined}
      title={title}
      icon={icon}
      description={description}
      size={SHEET_SIZE[oneOf(size, ["sm", "md", "lg", "xl"] as const) ?? "md"]}
      placement={oneOf(side, ["right", "left"] as const) ?? "right"}
      primaryAction={primaryAction}
      secondaryAction={secondaryAction}
      hint={hint}
      footer={footer}
      dismissible={dismissible}
      layer={layer}
      testId={testId}
    >
      {children}
    </KitDialogFrame>
  );
}

interface PaletteItem {
  id: string;
  label: string;
  description: string | undefined;
  icon: unknown;
  keywords: string[];
  shortcut: string | undefined;
  group: string;
  disabled: boolean;
  /** The plugin's own object, handed back to `onSelect` as it was given. */
  source: PluginCommandPaletteItem;
}

interface PaletteResult {
  item: PaletteItem;
  matches: readonly FuseResultMatch[] | undefined;
}

type PaletteRow =
  | { kind: "head"; label: string; first: boolean }
  | { kind: "item"; index: number; result: PaletteResult };

function readPaletteItems(items: unknown): PaletteItem[] {
  const entries: readonly PluginCommandPaletteItem[] = Array.isArray(items) ? items : [];
  const seen = new Set<string>();
  const out: PaletteItem[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = nonEmpty(field(entry, "id"));
    const label = str(field(entry, "label"));
    if (id === undefined || label === undefined || seen.has(id)) continue;
    seen.add(id);
    const keywords = field(entry, "keywords");
    out.push({
      id,
      label,
      description: nonEmpty(field(entry, "description")),
      icon: field(entry, "icon"),
      keywords: Array.isArray(keywords)
        ? keywords.filter((word): word is string => typeof word === "string")
        : [],
      shortcut: nonEmpty(field(entry, "shortcut")),
      group: str(field(entry, "group")) ?? "",
      disabled: field(entry, "disabled") === true,
      source: entry,
    });
  }
  return out;
}

const PALETTE_FUSE_OPTIONS = {
  keys: ["label", "description", "keywords"],
  threshold: 0.4,
  ignoreLocation: true,
  includeMatches: true,
};

// Above this many items a fuzzy pass can hold up typing, so it trails the
// field by a frame, as the host palettes' own filter does.
const PALETTE_DEFER_MIN_ITEMS = 300;

const PALETTE_ROW_PX = 34;

/**
 * Rows sharing a group sit together, groups in the order they first appear in
 * `items`; within a group the results keep their rank. Exported for tests.
 */
export function groupPaletteResults(
  results: readonly PaletteResult[],
  items: readonly PaletteItem[]
): PaletteResult[] {
  const rank = new Map<string, number>();
  for (const item of items) if (!rank.has(item.group)) rank.set(item.group, rank.size);
  if (rank.size <= 1) return [...results];
  return results
    .map((result, order) => ({ result, order }))
    .sort(
      (a, b) =>
        (rank.get(a.result.item.group) ?? 0) - (rank.get(b.result.item.group) ?? 0) ||
        a.order - b.order
    )
    .map(({ result }) => result);
}

/** The enabled index nearest `from` going `dir`, wrapping; -1 when none is. */
function stepEnabled(results: readonly PaletteResult[], from: number, dir: 1 | -1): number {
  const count = results.length;
  for (let steps = 0; steps < count; steps++) {
    const at = (((from + dir * steps) % count) + count) % count;
    if (!results[at]!.item.disabled) return at;
  }
  return -1;
}

/** The list's rows with a heading before each group, and each result's row. */
function paletteRows(
  results: readonly PaletteResult[],
  grouped: boolean
): { rows: PaletteRow[]; rowOf: number[] } {
  const rows: PaletteRow[] = [];
  const rowOf: number[] = [];
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    const group = result.item.group;
    if (grouped && group !== "" && (index === 0 || results[index - 1]!.item.group !== group)) {
      rows.push({ kind: "head", label: group, first: rows.length === 0 });
    }
    rowOf.push(rows.length);
    rows.push({ kind: "item", index, result });
  }
  return { rows, rowOf };
}

interface PaletteListContext {
  listId: string;
  label: string;
}

function PaletteList({
  context,
  ref,
  style,
  children,
}: ListProps & { context: PaletteListContext; ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} style={style} id={context.listId} role="listbox" aria-label={context.label}>
      {children}
    </div>
  );
}

function PaletteItemWrapper({
  context: _context,
  item: _item,
  ...props
}: ItemProps<unknown> & { context: PaletteListContext }) {
  return <div {...props} role="none" />;
}

const PALETTE_COMPONENTS = { List: PaletteList, Item: PaletteItemWrapper };

function KitCommandPalette({
  open,
  onOpenChange,
  items,
  onSelect,
  title,
  placeholder,
  shortcut,
  onQueryChange,
  filter,
  loading,
  emptyText,
  actionLabel,
}: PluginCommandPaletteProps) {
  const isOpen = open === true;
  const change = fn(onOpenChange);
  const select = fn(onSelect);
  const reportQuery = fn(onQueryChange);
  const heading = str(title) ?? "";
  const action = nonEmpty(actionLabel);
  const layer = useContext(PluginKitLayerContext);

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  // The query the plugin last heard, so every close tells it the search is
  // empty again exactly once, however the palette closed.
  const reportedQuery = useRef("");
  // Closed from outside, the palette still opens next time on an empty search.
  const [wasOpen, setWasOpen] = useState(isOpen);
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (!isOpen) {
      setQuery("");
      setCursor(0);
    }
  }
  useEffect(() => {
    if (isOpen || reportedQuery.current === "") return;
    reportedQuery.current = "";
    reportQuery?.("");
  }, [isOpen, reportQuery]);

  const normalized = useMemo(() => readPaletteItems(items), [items]);
  const fuse = useMemo(() => new Fuse(normalized, PALETTE_FUSE_OPTIONS), [normalized]);
  const deferredQuery = useDeferredValue(query);
  const filterQuery = normalized.length > PALETTE_DEFER_MIN_ITEMS ? deferredQuery : query;
  const filtering = filter !== false;
  const results = useMemo(() => {
    const needle = filterQuery.trim();
    const ranked: PaletteResult[] =
      filtering && needle
        ? fuse.search(needle).map((hit) => ({ item: hit.item, matches: hit.matches }))
        : normalized.map((item) => ({ item, matches: undefined }));
    return groupPaletteResults(ranked, normalized);
  }, [filtering, filterQuery, fuse, normalized]);

  const clamped = results.length === 0 ? -1 : Math.min(Math.max(cursor, 0), results.length - 1);
  const active = clamped < 0 ? -1 : stepEnabled(results, clamped, 1);

  const grouped = results.some((result) => result.item.group !== "");
  const { rows, rowOf } = paletteRows(results, grouped);

  const baseId = useId();
  const listId = `${baseId}list`;
  const optionPrefix = `${baseId}option`;
  const handle = useRef<VirtuosoHandle>(null);
  const [listPx, setListPx] = useState<number | null>(null);

  const moveTo = (index: number) => {
    if (index < 0) return;
    setCursor(index);
    const row = rowOf[index];
    if (row !== undefined) handle.current?.scrollIntoView({ index: row });
  };

  // A new search puts the cursor's row in view: the list keeps its scroll
  // across results, so the active row could otherwise sit outside the rendered
  // range, named by the field's active descendant but never drawn. Keyed on
  // the query the results reflect, not the items, so a plugin refreshing its
  // items does not pull the list back while it is being scrolled.
  const revealedQuery = useRef(filterQuery);
  const activeRow = rowOf[active];
  useEffect(() => {
    if (revealedQuery.current === filterQuery) return;
    revealedQuery.current = filterQuery;
    if (activeRow === undefined) return;
    // The first row takes its band's heading into view with it.
    if (activeRow <= 1) handle.current?.scrollToIndex({ index: 0 });
    else handle.current?.scrollIntoView({ index: activeRow });
  }, [filterQuery, activeRow]);

  const handleQuery = (next: string) => {
    setQuery(next);
    setCursor(0);
    reportedQuery.current = next;
    reportQuery?.(next);
  };

  const close = () => {
    if (reportedQuery.current !== "") {
      reportedQuery.current = "";
      reportQuery?.("");
    }
    change?.(false);
  };

  const choose = (index: number) => {
    const result = results[index];
    if (!result || result.item.disabled) return;
    select?.(result.item.source);
    close();
  };

  const renderRow = (row: PaletteRow): ReactNode => {
    if (row.kind === "head") {
      // An inert option rather than a group: inside a listbox, Chromium and
      // VoiceOver drop a group's label, as the host palettes found.
      return (
        <div
          role="option"
          aria-disabled="true"
          aria-selected="false"
          aria-label={row.label}
          className={cn(PALETTE_SECTION_LABEL_CLASS, "px-3 pb-1", row.first ? "pt-0" : "pt-3")}
        >
          {row.label}
        </div>
      );
    }
    const { index, result } = row;
    const { item, matches } = result;
    const selected = index === active;
    const glyph = sizedIcon(item.icon, "h-4 w-4");
    return (
      <div className="pb-1">
        <div
          id={`${optionPrefix}-${item.id}`}
          role="option"
          aria-selected={selected}
          aria-disabled={item.disabled || undefined}
          aria-posinset={grouped ? index + 1 : undefined}
          aria-setsize={grouped ? results.length : undefined}
          // The search field keeps focus; rows are driven by its active descendant.
          onPointerDown={(event) => event.preventDefault()}
          onPointerMove={() => {
            if (!selected && !item.disabled) setCursor(index);
          }}
          onClick={() => choose(index)}
          className={cn(
            PALETTE_ROW_CLASS,
            "flex w-full items-center gap-3 rounded-[var(--radius-md)] px-3 text-left text-text-secondary",
            item.description ? "py-2" : "py-1.5",
            item.disabled ? "cursor-not-allowed" : "cursor-pointer"
          )}
        >
          {glyph ? (
            <PluginStyleScope>
              <span className="flex shrink-0 text-text-secondary">{glyph}</span>
            </PluginStyleScope>
          ) : null}
          <div className="min-w-0 flex-1">
            <div
              className={cn(
                "truncate text-sm font-medium",
                item.disabled ? "text-text-secondary" : "text-text-primary"
              )}
            >
              <HighlightedText text={item.label} indices={findMatchIndices(matches, "label")} />
            </div>
            {item.description ? (
              <div className="truncate text-xs leading-snug text-text-secondary">
                <HighlightedText
                  text={item.description}
                  indices={findMatchIndices(matches, "description")}
                />
              </div>
            ) : null}
          </div>
          {item.shortcut ? (
            <span aria-hidden="true" className="shrink-0">
              <KbdChord shortcut={item.shortcut} density="compact" />
            </span>
          ) : null}
        </div>
      </div>
    );
  };

  const body = () => {
    if (results.length === 0) {
      // The header's loading bar is the one signal while items arrive.
      if (loading === true) return null;
      return (
        <AppPaletteDialog.Empty
          query={query}
          emptyMessage={nonEmpty(emptyText) ?? "Nothing to show"}
          noMatchContent={<PaletteNoMatchHint />}
        />
      );
    }
    const estimate = rows.length * PALETTE_ROW_PX;
    return (
      <PluginStyleScope block>
        <Virtuoso
          ref={handle}
          // Sized to its rows up to the palette body's own cap, so a short list
          // does not stretch the palette and a long one scrolls inside it.
          style={{ height: `min(${listPx ?? estimate}px, calc(60vh - 1rem))` }}
          context={{ listId, label: heading }}
          components={PALETTE_COMPONENTS}
          data={rows}
          defaultItemHeight={PALETTE_ROW_PX}
          increaseViewportBy={8 * PALETTE_ROW_PX}
          initialTopMostItemIndex={Math.max(0, (rowOf[active] ?? 0) - 1)}
          computeItemKey={(index, row) =>
            row.kind === "head" ? `head-${index}-${row.label}` : row.result.item.id
          }
          itemContent={(_index, row) => renderRow(row)}
          totalListHeightChanged={setListPx}
        />
      </PluginStyleScope>
    );
  };

  return (
    <SearchablePalette<PaletteResult>
      tier="command"
      // Opened from inside a nested kit dialog, it has to stack above it.
      zIndex={layer === "nested" ? "nested" : undefined}
      isOpen={isOpen}
      query={query}
      results={results}
      selectedIndex={active}
      onQueryChange={handleQuery}
      onSelectPrevious={() => moveTo(stepEnabled(results, active - 1, -1))}
      onSelectNext={() => moveTo(stepEnabled(results, active + 1, 1))}
      onSelectIndex={(index) => moveTo(stepEnabled(results, index, index === 0 ? 1 : -1))}
      onHoverIndex={(index) => setCursor(index)}
      onConfirm={() => choose(active)}
      onClose={close}
      getItemId={(result) => result.item.id}
      renderItem={() => null}
      renderBody={body}
      label={heading}
      ariaLabel={heading}
      shortcut={nonEmpty(shortcut)}
      searchPlaceholder={nonEmpty(placeholder) ?? "Search"}
      listId={listId}
      itemIdPrefix={optionPrefix}
      isLoading={loading === true}
      isFiltering={query !== filterQuery}
      getActionLabel={action ? (result) => (result.item.disabled ? null : action) : undefined}
    />
  );
}

const CRUMB_CLASS = "inline-flex min-w-0 items-center gap-1 rounded-[var(--radius-sm)] px-1 py-0.5";
const CRUMB_LINK_CLASS = cn(
  CRUMB_CLASS,
  "max-w-48 text-text-secondary transition-colors duration-150 ease-out hover:text-text-primary",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
);

interface Crumb {
  label: string;
  onSelect: (() => void) | undefined;
  icon: unknown;
}

function readCrumbs(items: unknown): Crumb[] {
  if (!Array.isArray(items)) return [];
  const out: Crumb[] = [];
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null) continue;
    const label = nonEmpty(field(entry, "label"));
    if (label === undefined) continue;
    const onSelect = field(entry, "onSelect");
    out.push({
      label,
      onSelect:
        typeof onSelect === "function" ? () => Reflect.apply(onSelect, undefined, []) : undefined,
      icon: field(entry, "icon"),
    });
  }
  return out;
}

function CrumbSeparator() {
  return <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0 text-text-secondary" />;
}

function CrumbBody({ crumb }: { crumb: Crumb }) {
  return (
    <>
      {sizedIcon(crumb.icon, "h-3.5 w-3.5 shrink-0")}
      <span className="truncate">{crumb.label}</span>
    </>
  );
}

function KitBreadcrumbs({
  items,
  maxItems,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginBreadcrumbsProps) {
  const overlayZ = useKitOverlayZClass();
  const owner = useKitOwnerAttributes();
  const crumbs = readCrumbs(items);
  const max =
    typeof maxItems === "number" && Number.isFinite(maxItems)
      ? Math.max(2, Math.floor(maxItems))
      : 4;
  // The first crumb and the last `max - 1` stay; the ones between fold away.
  const folded = crumbs.length > max ? crumbs.slice(1, crumbs.length - (max - 1)) : [];
  const shown =
    folded.length > 0 ? [crumbs[0]!, ...crumbs.slice(crumbs.length - (max - 1))] : crumbs;
  const last = shown.length - 1;
  return (
    <nav
      {...pickRootProps(rest)}
      aria-label={nonEmpty(ariaLabel) ?? "Breadcrumb"}
      className={cn("min-w-0", str(className))}
    >
      <ol className="flex min-w-0 items-center gap-0.5 text-xs">
        {shown.map((crumb, index) => {
          const current = index === last;
          return (
            <li
              key={`${index}-${crumb.label}`}
              className={cn("flex items-center gap-0.5", current ? "min-w-0" : "shrink-0")}
            >
              {index > 0 ? <CrumbSeparator /> : null}
              {index === 1 && folded.length > 0 ? (
                <>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Show ${folded.length} more`}
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent {...owner} className={overlayZ} align="start">
                      {folded.map((hidden, at) => (
                        <DropdownMenuItem
                          key={`${at}-${hidden.label}`}
                          disabled={hidden.onSelect === undefined}
                          onSelect={() => hidden.onSelect?.()}
                        >
                          {hidden.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <CrumbSeparator />
                </>
              ) : null}
              {current ? (
                <span
                  aria-current="page"
                  className={cn(CRUMB_CLASS, "font-medium text-text-primary")}
                >
                  <CrumbBody crumb={crumb} />
                </span>
              ) : crumb.onSelect ? (
                <button type="button" onClick={crumb.onSelect} className={CRUMB_LINK_CLASS}>
                  <CrumbBody crumb={crumb} />
                </button>
              ) : (
                <span className={cn(CRUMB_CLASS, "max-w-48 text-text-secondary")}>
                  <CrumbBody crumb={crumb} />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

interface NavEntry {
  id: string;
  label: string;
  icon: unknown;
  count: number | undefined;
  badge: ReactNode;
  disabled: boolean;
  depth: 0 | 1;
}

interface NavSection {
  label: string | undefined;
  entries: NavEntry[];
}

function readNavItems(items: unknown, depth: 0 | 1, seen: Set<string>, out: NavEntry[]) {
  if (!Array.isArray(items)) return;
  for (const entry of items) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = nonEmpty(field(entry, "id"));
    const label = str(field(entry, "label"));
    if (id === undefined || label === undefined || seen.has(id)) continue;
    seen.add(id);
    const count = field(entry, "count");
    out.push({
      id,
      label,
      icon: field(entry, "icon"),
      count: typeof count === "number" && Number.isFinite(count) && count > 0 ? count : undefined,
      badge: node(field(entry, "badge")),
      disabled: field(entry, "disabled") === true,
      depth,
    });
    if (depth === 0) readNavItems(field(entry, "children"), 1, seen, out);
  }
}

/** Plugin sections (or a bare `items` list), narrowed to rows. Exported for tests. */
export function readNavSections(sections: unknown, items: unknown): NavSection[] {
  const seen = new Set<string>();
  const bands: unknown[] = Array.isArray(sections) ? sections : [{ items }];
  const out: NavSection[] = [];
  for (const band of bands) {
    if (typeof band !== "object" || band === null) continue;
    const entries: NavEntry[] = [];
    readNavItems(field(band, "items"), 0, seen, entries);
    if (entries.length > 0) out.push({ label: nonEmpty(field(band, "label")), entries });
  }
  return out;
}

// The list keeps DOM focus and the cursor row is its focus indicator, drawn
// only while the list itself has keyboard focus, as on an interactive DataTable.
const NAV_FOCUS_RING =
  "outline-hidden focus-visible:[&_[data-active=true]]:outline focus-visible:[&_[data-active=true]]:outline-2 focus-visible:[&_[data-active=true]]:-outline-offset-2 focus-visible:[&_[data-active=true]]:outline-accent-primary";

function KitNavList(props: PluginNavListProps) {
  const {
    sections,
    items,
    value,
    defaultValue,
    onValueChange,
    "aria-label": ariaLabel,
    className,
    ...rest
  } = props;
  const controlled = Object.hasOwn(props, "value");
  const [uncontrolled, setUncontrolled] = useState(() => str(defaultValue));
  const selectedId = controlled ? str(value) : uncontrolled;
  const handleChange = fn(onValueChange);
  const bands = readNavSections(sections, items);
  const flat = bands.flatMap((band) => band.entries);
  const selectedIndex = flat.findIndex((entry) => entry.id === selectedId);
  const nav = useListNavigation({
    count: flat.length,
    initialIndex: Math.max(0, selectedIndex),
    getLabel: (index) => flat[index]?.label ?? "",
    isDisabled: (index) => flat[index]?.disabled === true,
    onSelect: (index) => {
      const entry = flat[index];
      if (!entry || entry.disabled) return;
      if (!controlled) setUncontrolled(entry.id);
      handleChange?.(entry.id);
    },
  });
  const baseId = useId();
  const headed = bands.some((band) => band.label !== undefined);
  // Where each band's rows start in the list's one run of indices.
  const starts: number[] = [];
  let runningStart = 0;
  for (const band of bands) {
    starts.push(runningStart);
    runningStart += band.entries.length;
  }
  return (
    <div
      {...pickRootProps(rest)}
      {...nav.containerProps}
      aria-label={str(ariaLabel) ?? ""}
      className={cn("flex flex-col gap-3", NAV_FOCUS_RING, str(className))}
    >
      {bands.map((band, bandIndex) => {
        const headId = `${baseId}section-${bandIndex}`;
        return (
          <div key={headId} role="none" className="flex flex-col gap-0.5">
            {band.label ? (
              // An inert option rather than a group, for the same reason as
              // the palette's band heads.
              <div
                id={headId}
                role="option"
                aria-disabled="true"
                aria-selected="false"
                className="mb-0.5 block select-none px-3 text-xs font-medium text-text-secondary"
              >
                {band.label}
              </div>
            ) : null}
            {band.entries.map((entry, offset) => {
              const at = starts[bandIndex]! + offset;
              const selected = entry.id === selectedId;
              const glyph = sizedIcon(entry.icon, "h-4 w-4");
              return (
                <div
                  key={entry.id}
                  {...nav.getRowProps(at)}
                  // The list's own `aria-selected` is its cursor; a nav row's
                  // is the destination on screen, and the cursor is `data-active`.
                  aria-selected={selected}
                  // Band heads are inert options, so the count is stated over the rows only.
                  aria-posinset={headed ? at + 1 : undefined}
                  aria-setsize={headed ? flat.length : undefined}
                  data-active={at === nav.activeIndex ? "true" : undefined}
                  className={cn(
                    PALETTE_ROW_CLASS,
                    LIST_ROW_HOVER_CLASS,
                    "flex h-7 select-none items-center gap-2 rounded-[var(--radius-md)] px-3 text-sm",
                    entry.depth === 1 && "pl-9",
                    entry.disabled
                      ? "cursor-default text-text-secondary opacity-50"
                      : cn(
                          "cursor-pointer",
                          !selected && "text-text-secondary hover:text-text-primary"
                        )
                  )}
                >
                  {glyph ? (
                    <PluginStyleScope>
                      <span className="flex shrink-0">{glyph}</span>
                    </PluginStyleScope>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  {entry.count !== undefined ? (
                    <span className={COUNT_BADGE_CLASS}>{formatCompactCount(entry.count)}</span>
                  ) : null}
                  {entry.badge !== null && entry.badge !== undefined ? (
                    <PluginStyleScope>
                      <span className="flex shrink-0 items-center">{entry.badge}</span>
                    </PluginStyleScope>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

const STEP_STATES = ["complete", "current", "upcoming", "error"] as const;

interface StepView {
  id: string;
  label: string;
  description: string | undefined;
  state: PluginStepState;
}

/** Each step's state: its own `state`, else where it sits against `current`. Exported for tests. */
export function readSteps(steps: unknown, current: unknown): StepView[] {
  if (!Array.isArray(steps)) return [];
  const seen = new Set<string>();
  const read: Omit<StepView, "state">[] = [];
  const explicit: (PluginStepState | undefined)[] = [];
  for (const entry of steps) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = nonEmpty(field(entry, "id"));
    const label = str(field(entry, "label"));
    if (id === undefined || label === undefined || seen.has(id)) continue;
    seen.add(id);
    read.push({ id, label, description: nonEmpty(field(entry, "description")) });
    explicit.push(oneOf(field(entry, "state"), STEP_STATES));
  }
  const at = read.findIndex((step) => step.id === current);
  return read.map((step, index) => ({
    ...step,
    state:
      explicit[index] ??
      (at < 0 ? "upcoming" : index < at ? "complete" : index === at ? "current" : "upcoming"),
  }));
}

const STEP_SPOKEN: Partial<Record<PluginStepState, string>> = {
  complete: ", completed",
  error: ", needs attention",
};

function StepMarker({ state, number }: { state: PluginStepState; number: number }) {
  if (state === "error") {
    const Glyph = SEVERITY_GLYPH.error;
    return <Glyph aria-hidden="true" className="h-5 w-5 shrink-0 text-status-danger" />;
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-2xs font-medium tabular-nums",
        state === "current" && "bg-text-primary text-text-inverse",
        state === "complete" && "border border-border-strong text-text-primary",
        state === "upcoming" && "border border-border-default text-text-secondary"
      )}
    >
      {state === "complete" ? <Check className="h-3 w-3" /> : number}
    </span>
  );
}

function StepText({ step, vertical }: { step: StepView; vertical: boolean }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span
        className={cn(
          "truncate text-sm group-hover:underline group-hover:underline-offset-2",
          step.state === "current" && "font-medium",
          step.state === "upcoming" ? "text-text-secondary" : "text-text-primary"
        )}
      >
        {step.label}
        {STEP_SPOKEN[step.state] ? (
          <span className="sr-only">{STEP_SPOKEN[step.state]}</span>
        ) : null}
      </span>
      {step.description ? (
        <span className={cn("text-xs text-text-secondary", !vertical && "truncate")}>
          {step.description}
        </span>
      ) : null}
    </span>
  );
}

function KitStepper({
  steps,
  current,
  orientation,
  onStepSelect,
  "aria-label": ariaLabel,
  className,
  ...rest
}: PluginStepperProps) {
  const views = readSteps(steps, current);
  const vertical = orientation === "vertical";
  const selectStep = fn(onStepSelect);
  const last = views.length - 1;
  return (
    <ol
      {...pickRootProps(rest)}
      aria-label={nonEmpty(ariaLabel) ?? "Progress"}
      className={cn(vertical ? "flex flex-col" : "flex min-w-0 items-center gap-2", str(className))}
    >
      {views.map((step, index) => {
        const selectable =
          selectStep !== undefined && (step.state === "complete" || step.state === "error");
        const body = (
          <>
            <StepMarker state={step.state} number={index + 1} />
            <StepText step={step} vertical={vertical} />
          </>
        );
        const bodyClass = cn("flex min-w-0 gap-2", vertical ? "items-start" : "items-center");
        const content = selectable ? (
          <button
            type="button"
            onClick={() => selectStep(step.id)}
            className={cn(
              bodyClass,
              "group rounded-[var(--radius-sm)] text-left",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
            )}
          >
            {body}
          </button>
        ) : (
          <div className={bodyClass}>{body}</div>
        );
        if (vertical) {
          return (
            <li
              key={step.id}
              aria-current={step.state === "current" ? "step" : undefined}
              className="relative flex min-w-0 flex-col pb-4 last:pb-0"
            >
              {content}
              {index < last ? (
                // From under this marker to the next one, through the text's height.
                <span
                  aria-hidden="true"
                  className="absolute top-6 bottom-1 left-2.5 w-px -translate-x-1/2 bg-border-default"
                />
              ) : null}
            </li>
          );
        }
        return (
          <li
            key={step.id}
            aria-current={step.state === "current" ? "step" : undefined}
            className={cn("flex min-w-0 items-center gap-2", index < last && "flex-1")}
          >
            {content}
            {index < last ? (
              <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border-default" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export const pluginKitNavigation = {
  ContextMenu: KitContextMenu,
  Sheet: KitSheet,
  CommandPalette: KitCommandPalette,
  Breadcrumbs: KitBreadcrumbs,
  NavList: KitNavList,
  Stepper: KitStepper,
};
