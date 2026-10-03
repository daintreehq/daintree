import {
  isValidElement,
  useContext,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
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
  ContextMenuContent,
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
import { CONTEXT_MENU_PARTS, isMenuKey, renderMenuEntries, stopReactPropagation } from "./kitMenu";
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

/**
 * Ranked matches with the disabled ones after the enabled, each side keeping
 * its rank: a better score does not put a row that cannot be chosen above
 * ones that can. Exported for tests.
 */
export function demoteDisabled(results: readonly PaletteResult[]): PaletteResult[] {
  return [
    ...results.filter((result) => !result.item.disabled),
    ...results.filter((result) => result.item.disabled),
  ];
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
        ? demoteDisabled(
            fuse.search(needle).map((hit) => ({ item: hit.item, matches: hit.matches }))
          )
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
      <span data-crumb-label="" className="truncate">
        {crumb.label}
      </span>
    </>
  );
}

// The trail's fixed parts, in px: the chevron, the gap-0.5 between a li's
// parts and between lis, and the fold menu's icon-xs button. An ancestor
// truncates to its floor before any folds; the current crumb has its own
// floor for when even a fully folded trail is too narrow.
const CRUMB_SEPARATOR_PX = 12;
const CRUMB_GAP_PX = 2;
const CRUMB_MENU_PX = 24;
const CRUMB_ANCESTOR_MIN_PX = 64;
const CRUMB_CURRENT_MIN_PX = 48;

/** The crumbs folded into the menu, as the half-open index range [start, end); empty when equal. */
export interface CrumbFold {
  start: number;
  end: number;
}

/**
 * The first `folded` ancestors in fold order: the middle ones from the root's
 * side first, the parent with them, and the root last. The current crumb never folds.
 */
function foldRange(count: number, folded: number): CrumbFold {
  if (folded <= 0) return { start: 0, end: 0 };
  if (folded >= count - 1) return { start: 0, end: count - 1 };
  return { start: 1, end: 1 + folded };
}

/** What sits before a visible crumb in its li: the separator, and the fold menu with its own. */
function crumbLeadPx(position: number, menuHere: boolean): number {
  return (
    (position > 0 ? CRUMB_SEPARATOR_PX + CRUMB_GAP_PX : 0) +
    (menuHere ? CRUMB_MENU_PX + CRUMB_SEPARATOR_PX + 2 * CRUMB_GAP_PX : 0)
  );
}

/** The visible crumbs of a trail under `fold`, each with what leads it and the fold menu's place. */
function visibleCrumbs(count: number, fold: CrumbFold) {
  const out: { index: number; lead: number; menuHere: boolean }[] = [];
  for (let index = 0; index < count; index++) {
    if (index >= fold.start && index < fold.end) continue;
    const menuHere = fold.end > fold.start && index === fold.end;
    out.push({ index, lead: crumbLeadPx(out.length, menuHere), menuHere });
  }
  return out;
}

export interface CrumbPlan {
  fold: CrumbFold;
  /** Whether the current crumb keeps its full width; false only when even the fullest fold is too narrow. */
  currentFits: boolean;
}

/**
 * How a trail of `widths.length` crumbs (each at its natural width) lays out
 * in `available` px: past `maxItems` the middle folds regardless; beyond that,
 * ancestors truncate to their floor, then fold one at a time until the row
 * holds with the current crumb whole. Unmeasured (0) keeps the `maxItems`
 * fold alone. Exported for tests.
 */
export function planCrumbs(
  available: number,
  widths: readonly (number | undefined)[],
  maxItems: number
): CrumbPlan {
  const count = widths.length;
  const least = count > maxItems ? count - maxItems : 0;
  if (!(available > 0) || count === 0) return { fold: foldRange(count, least), currentFits: true };
  const last = count - 1;
  for (let folded = least; folded <= Math.max(least, last); folded++) {
    const fold = foldRange(count, folded);
    const shown = visibleCrumbs(count, fold);
    let row = (shown.length - 1) * CRUMB_GAP_PX;
    for (const { index, lead } of shown) {
      const natural = widths[index] ?? CRUMB_ANCESTOR_MIN_PX;
      row += lead + (index === last ? natural : Math.min(natural, CRUMB_ANCESTOR_MIN_PX));
    }
    // A px of slack per crumb absorbs rounding in the measured widths, so a
    // trail sized to its own content never reads as too narrow for itself.
    if (row <= available + shown.length) return { fold, currentFits: true };
  }
  return { fold: foldRange(count, last), currentFits: false };
}

interface MeasuredTrail {
  key: string;
  widths: readonly (number | undefined)[];
  plan: CrumbPlan;
}

/** The trail after a resize: widths read now, else the last ones known for this trail. */
function nextMeasuredTrail(
  previous: MeasuredTrail | null,
  key: string,
  available: number,
  read: readonly (number | undefined)[],
  maxItems: number
): MeasuredTrail {
  const kept = previous !== null && previous.key === key ? previous.widths : [];
  const widths = read.map((width, index) => width ?? kept[index]);
  const plan = planCrumbs(available, widths, maxItems);
  const same =
    previous !== null &&
    previous.key === key &&
    previous.plan.fold.start === plan.fold.start &&
    previous.plan.fold.end === plan.fold.end &&
    previous.plan.currentFits === plan.currentFits &&
    widths.every((width, index) => width === previous.widths[index]);
  return same ? previous : { key, widths, plan };
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
  const count = crumbs.length;
  const last = count - 1;

  // Each crumb's natural width, read in place whenever the trail is resized:
  // a crumb folded by width was on screen before it folded, so its width is
  // still known when there is room to bring it back. A new trail starts
  // unfolded and is measured again. Folding never changes the nav's own
  // width, so a resize settles in one update.
  const trailKey = `${max}\u0000${crumbs.map((crumb) => crumb.label).join("\u0000")}`;
  const [nav, setNav] = useState<HTMLElement | null>(null);
  const [measured, setMeasured] = useState<MeasuredTrail | null>(null);
  useLayoutEffect(() => {
    if (nav === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const available = entries[0]?.contentRect.width ?? 0;
      const read: (number | undefined)[] = new Array<undefined>(count);
      for (const crumb of nav.querySelectorAll<HTMLElement>("[data-crumb]")) {
        const index = Number(crumb.dataset.crumb);
        const label = crumb.querySelector<HTMLElement>("[data-crumb-label]");
        if (!Number.isInteger(index) || index >= count || label === null) continue;
        read[index] = crumb.getBoundingClientRect().width - label.clientWidth + label.scrollWidth;
      }
      setMeasured((previous) => nextMeasuredTrail(previous, trailKey, available, read, max));
    });
    observer.observe(nav);
    return () => observer.disconnect();
  }, [nav, trailKey, count, max]);
  const known = measured !== null && measured.key === trailKey ? measured : null;
  const { fold, currentFits } = known?.plan ?? planCrumbs(0, new Array<undefined>(count), max);
  const folded = crumbs.slice(fold.start, fold.end);

  return (
    <nav
      {...pickRootProps(rest)}
      ref={setNav}
      aria-label={nonEmpty(ariaLabel) ?? "Breadcrumb"}
      className={cn("min-w-0", str(className))}
    >
      <ol className="flex min-w-0 items-center gap-0.5 text-xs">
        {visibleCrumbs(count, fold).map(({ index, lead, menuHere }, position) => {
          const crumb = crumbs[index]!;
          const current = index === last;
          const natural = known?.widths[index];
          // Ancestors give way first, down to their floor; the current crumb
          // keeps its whole width unless even the fullest fold cannot hold it.
          const floor =
            natural === undefined
              ? undefined
              : current
                ? currentFits
                  ? undefined
                  : lead + Math.min(natural, CRUMB_CURRENT_MIN_PX)
                : lead + Math.min(natural, CRUMB_ANCESTOR_MIN_PX);
          return (
            <li
              key={`${index}-${crumb.label}`}
              style={floor === undefined ? undefined : { minWidth: floor }}
              className={cn(
                "flex items-center gap-0.5",
                current && currentFits ? "shrink-0" : "min-w-0"
              )}
            >
              {position > 0 ? <CrumbSeparator /> : null}
              {menuHere ? (
                <>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="shrink-0"
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
                  data-crumb={index}
                  aria-current="page"
                  className={cn(CRUMB_CLASS, "font-medium text-text-primary")}
                >
                  <CrumbBody crumb={crumb} />
                </span>
              ) : crumb.onSelect ? (
                <button
                  type="button"
                  data-crumb={index}
                  onClick={crumb.onSelect}
                  className={CRUMB_LINK_CLASS}
                >
                  <CrumbBody crumb={crumb} />
                </button>
              ) : (
                <span
                  data-crumb={index}
                  className={cn(CRUMB_CLASS, "max-w-48 text-text-secondary")}
                >
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
        state === "complete" && "border border-border-interactive text-text-primary",
        state === "upcoming" && "border border-border-strong text-text-secondary"
      )}
    >
      {state === "complete" ? <Check className="h-3 w-3" /> : number}
    </span>
  );
}

// The horizontal row's fixed parts, in px: each step's marker and the gap
// after it, and between steps a gap, the connector at its narrowest and the
// gap before the next li.
const STEP_MARKER_PX = 20;
const STEP_GAP_PX = 8;
const STEP_CONNECTOR_MIN_PX = 16;

/**
 * Whether a horizontal stepper `available` px wide holds every step's label at
 * its full width. Unmeasured (0) counts as fitting. Exported for tests.
 */
export function stepperLabelsFit(available: number, labelWidths: readonly number[]): boolean {
  if (!(available > 0)) return true;
  const steps = labelWidths.length;
  const labels = labelWidths.reduce((sum, width) => sum + width, 0);
  const needed =
    labels +
    steps * (STEP_MARKER_PX + STEP_GAP_PX) +
    Math.max(0, steps - 1) * (STEP_CONNECTOR_MIN_PX + 2 * STEP_GAP_PX);
  return needed <= available;
}

/** The step a compact stepper names: the current one, else the one that needs attention, else the next to do. */
export function focalStepIndex(views: readonly { state: PluginStepState }[]): number {
  for (const state of ["current", "error", "upcoming"] as const) {
    const at = views.findIndex((step) => step.state === state);
    if (at >= 0) return at;
  }
  return views.length - 1;
}

type StepLabelMode = "full" | "focal" | "hidden";

function StepText({
  step,
  vertical,
  mode,
  position,
}: {
  step: StepView;
  vertical: boolean;
  mode: StepLabelMode;
  position: string;
}) {
  const label = (
    <span
      data-step-label=""
      className={cn(
        mode === "hidden" ? "sr-only" : "truncate",
        "text-sm group-hover:underline group-hover:underline-offset-2",
        step.state === "current" && "font-medium",
        step.state === "upcoming" ? "text-text-secondary" : "text-text-primary"
      )}
    >
      {step.label}
      {STEP_SPOKEN[step.state] ? <span className="sr-only">{STEP_SPOKEN[step.state]}</span> : null}
    </span>
  );
  // A marker-only step keeps its name for assistive tech and for measuring.
  if (mode === "hidden") return label;
  return (
    <span className={cn("flex flex-col", mode === "focal" ? "min-w-12" : "min-w-0")}>
      {label}
      {mode === "focal" ? (
        // The list already tells assistive tech where the step sits.
        <span aria-hidden="true" className="truncate text-xs text-text-secondary">
          {position}
        </span>
      ) : step.description ? (
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

  // A horizontal row too narrow for every label keeps every marker and
  // connector and names only the focal step, with its place in the run. The
  // labels stay in the DOM either way, so their full widths can be read on
  // each resize without a second render; switching form never changes the
  // row's width, so it settles in one update.
  const [list, setList] = useState<HTMLOListElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  const labelKey = views.map((step) => step.label).join("\u0000");
  useLayoutEffect(() => {
    if (vertical || list === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      const labels = [...list.querySelectorAll<HTMLElement>("[data-step-label]")].map(
        (label) => label.scrollWidth
      );
      const next = !stepperLabelsFit(width, labels);
      setNarrow((previous) => (previous === next ? previous : next));
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [list, vertical, labelKey]);
  const compact = !vertical && narrow;
  const focal = compact ? focalStepIndex(views) : -1;

  return (
    <ol
      {...pickRootProps(rest)}
      ref={setList}
      aria-label={nonEmpty(ariaLabel) ?? "Progress"}
      data-compact={compact ? "" : undefined}
      className={cn(vertical ? "flex flex-col" : "flex min-w-0 items-center gap-2", str(className))}
    >
      {views.map((step, index) => {
        const selectable =
          selectStep !== undefined && (step.state === "complete" || step.state === "error");
        const mode: StepLabelMode = !compact ? "full" : index === focal ? "focal" : "hidden";
        const body = (
          <>
            <StepMarker state={step.state} number={index + 1} />
            <StepText
              step={step}
              vertical={vertical}
              mode={mode}
              position={`Step ${index + 1} of ${views.length}`}
            />
          </>
        );
        // Compact, nothing shrinks below its content: the focal label keeps its
        // floor and truncates inside it, and marker-only steps keep their size.
        const bodyClass = cn(
          "flex",
          !compact && "min-w-0",
          mode !== "hidden" && "gap-2",
          vertical ? "items-start" : "items-center"
        );
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
                  className="absolute top-6 bottom-1 left-2.5 w-px -translate-x-1/2 bg-border-strong"
                />
              ) : null}
            </li>
          );
        }
        return (
          <li
            key={step.id}
            aria-current={step.state === "current" ? "step" : undefined}
            className={cn(
              "flex items-center gap-2",
              !compact && "min-w-0",
              index < last && "flex-1"
            )}
          >
            {content}
            {index < last ? (
              <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border-strong" />
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
