import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { ChevronRight } from "lucide-react";
import {
  GroupedVirtuoso,
  type GroupedVirtuosoHandle,
  type GroupProps,
  type ItemProps,
  type ListProps,
  type ScrollerProps,
  type TopItemListProps,
} from "react-virtuoso";
import type {
  PluginGroupedVirtualListProps,
  PluginListGroup,
} from "@shared/types/plugin-sdk-react";
import { useScrollShadowOverlays } from "@/components/ui/ScrollShadow";
import { LIST_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { cn } from "@/lib/utils";
import { readIds, wholeCount } from "./kitPaneShared";
import {
  field,
  fn,
  hasContent,
  node,
  nonEmpty,
  pickDomProps,
  pickRootProps,
  positive,
  str,
} from "./kitProps";

const GL_ROW_PX = 28;
const GL_OVERSCAN_ROWS = 8;
const SCROLLER_RING_INSET = "focus-visible:-outline-offset-2";

interface GroupEntry {
  id: string;
  label: string;
  items: readonly unknown[];
  count: number | null;
  source: PluginListGroup<unknown>;
}

function readGroups(groups: unknown): GroupEntry[] {
  if (!Array.isArray(groups)) return [];
  const seen = new Set<string>();
  const out: GroupEntry[] = [];
  for (const entry of groups) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = nonEmpty(field(entry, "id"));
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const items = field(entry, "items");
    const list: readonly unknown[] = Array.isArray(items) ? items : [];
    const count = field(entry, "count");
    out.push({
      id,
      label: str(field(entry, "label")) ?? "",
      items: list,
      count: count === false ? null : (wholeCount(count) ?? list.length),
      source: {
        id,
        label: str(field(entry, "label")) ?? "",
        items: list,
        count: count === false ? false : (wholeCount(count) ?? list.length),
      },
    });
  }
  return out;
}

interface GroupedContext {
  listProps: Record<string, unknown>;
  listFocusable: boolean;
  itemRole: "listitem" | "none";
  identity: Record<string, string | number | boolean>;
  footer: ReactNode;
}

function GroupedScroller({
  context,
  ref,
  ...props
}: ScrollerProps & { context: GroupedContext; ref?: Ref<HTMLDivElement> }) {
  if (!context.listFocusable) return <div {...props} ref={ref} tabIndex={0} />;
  return <div {...context.listProps} {...props} {...context.identity} ref={ref} />;
}

// Virtuoso draws this twice: the rows, and a copy holding the sticky header
// of the group at the top. Only the rows are the list.
function GroupedListElement({
  context,
  ref,
  style,
  children,
  ...props
}: ListProps & { context: GroupedContext; ref?: Ref<HTMLDivElement> }) {
  const top = Reflect.get(props, "data-testid") === "virtuoso-top-item-list";
  const listProps = context.listFocusable || top ? undefined : context.listProps;
  return (
    <div {...(top ? { role: "none" } : listProps)} ref={ref} style={style}>
      {children}
    </div>
  );
}

function GroupedItem({
  context,
  item: _item,
  ...props
}: ItemProps<unknown> & { context: GroupedContext }) {
  return <div {...props} role={context.itemRole} />;
}

// Virtuoso's group wrapper carries the sticky position; it is not a row.
function GroupedGroup({ context: _context, ...props }: GroupProps & { context: GroupedContext }) {
  return <div {...props} role="none" />;
}

// The sticky copy of the current group's header sits in its own layer above
// the rows; it is presentation, and the header in the flow is the one read.
function GroupedTopItemList({
  context: _context,
  ...props
}: TopItemListProps & { context: GroupedContext }) {
  return <div {...props} role="none" />;
}

function GroupedFooter({ context }: { context: GroupedContext }) {
  return hasContent(context.footer) ? <div role="none">{context.footer}</div> : null;
}

const GROUPED_COMPONENTS = {
  Scroller: GroupedScroller,
  List: GroupedListElement,
  Item: GroupedItem,
  Group: GroupedGroup,
  TopItemList: GroupedTopItemList,
  Footer: GroupedFooter,
};

/** Each group's first row index across the drawn list. Exported for tests. */
export function groupOffsets(counts: readonly number[]): number[] {
  const offsets: number[] = [];
  let running = 0;
  for (const count of counts) {
    offsets.push(running);
    running += count;
  }
  return offsets;
}

export function KitGroupedVirtualList(props: PluginGroupedVirtualListProps) {
  const {
    groups,
    renderItem,
    itemKey,
    collapsible,
    collapsedGroups,
    defaultCollapsedGroups,
    onCollapsedGroupsChange,
    footer,
    empty,
    estimatedItemSize,
    overscan,
    onEndReached,
    activeIndex,
    shadows,
    className,
    ...rest
  } = props;
  const entries = readGroups(groups);
  const render = fn(renderItem);
  const keyOf = fn(itemKey);
  const endReached = fn(onEndReached);
  const canFold = collapsible === true;
  const [ownCollapsed, setOwnCollapsed] = useState<string[]>(
    () => readIds(defaultCollapsedGroups) ?? []
  );
  const folded = canFold ? (readIds(collapsedGroups) ?? ownCollapsed) : [];
  const change = fn(onCollapsedGroupsChange);
  const counts = entries.map((group) => (folded.includes(group.id) ? 0 : group.items.length));
  const offsets = groupOffsets(counts);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const rowPx = positive(estimatedItemSize, 10_000) ?? GL_ROW_PX;
  const overscanRows =
    typeof overscan === "number" && Number.isFinite(overscan)
      ? Math.max(0, Math.floor(overscan))
      : GL_OVERSCAN_ROWS;
  const { style: _style, ref: _ref, ...dom } = pickDomProps(rest);
  const role = str(dom.role);
  const handle = useRef<GroupedVirtuosoHandle>(null);
  const target =
    typeof activeIndex === "number" &&
    Number.isInteger(activeIndex) &&
    activeIndex >= 0 &&
    activeIndex < total
      ? activeIndex
      : -1;
  useEffect(() => {
    if (target >= 0) handle.current?.scrollIntoView({ index: target });
  }, [target]);

  const toggle = (id: string) => {
    const next = folded.includes(id) ? folded.filter((entry) => entry !== id) : [...folded, id];
    setOwnCollapsed(next);
    change?.(next);
  };

  // Called either way (hooks), but only wired to the scroller when asked for.
  const { ref: shadowRef, topShadow, bottomShadow } = useScrollShadowOverlays();
  const withShadows = shadows === true;

  const allEmpty = entries.every((group) => group.items.length === 0);
  if (allEmpty && hasContent(empty)) {
    return (
      <div {...pickRootProps(dom)} className={cn("flex h-full min-h-0 flex-col", str(className))}>
        {node(empty)}
      </div>
    );
  }

  const context: GroupedContext = {
    listProps: { ...dom, role: role ?? "list" },
    listFocusable: typeof dom.tabIndex === "number" && dom.tabIndex >= 0,
    itemRole: role ? "none" : "listitem",
    identity: pickRootProps(dom),
    footer: node(footer),
  };

  const header = (groupIndex: number) => {
    const group = entries[groupIndex];
    if (!group) return null;
    const isFolded = folded.includes(group.id);
    const count =
      group.count === null ? null : (
        <span className="text-3xs font-medium text-text-secondary tabular-nums">{group.count}</span>
      );
    const label = <span className={cn(LIST_LABEL_CLASS, "min-w-0 truncate")}>{group.label}</span>;
    return (
      <div
        role="heading"
        aria-level={3}
        data-group-header={group.id}
        className="flex h-7 items-center border-b border-divider bg-surface px-3"
      >
        {canFold ? (
          <button
            type="button"
            aria-expanded={!isFolded}
            // A list's own Enter/Space (a keyboard listbox's select) must not
            // take the header's activation.
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            }}
            onClick={() => toggle(group.id)}
            className={cn(
              "-ml-1.5 flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-sm)] pl-1.5 text-left",
              "transition-[background-color] duration-150 ease-out hover:bg-overlay-subtle",
              "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
            )}
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "h-3 w-3 shrink-0 text-text-secondary transition-transform duration-150 ease-out motion-reduce:transition-none",
                !isFolded && "rotate-90"
              )}
            />
            {label}
            {count}
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            {label}
            {count}
          </span>
        )}
      </div>
    );
  };

  // Virtuoso keys headers and rows in one index space, a header before each
  // group's rows: find which one `position` is.
  const keyAt = (position: number): string | number => {
    let start = 0;
    for (let i = 0; i < entries.length; i += 1) {
      const group = entries[i];
      const rows = counts[i] ?? 0;
      if (!group) break;
      // Headers and rows in separate namespaces, so no row key can equal a header's.
      if (position === start) return `header:${group.id}`;
      if (position <= start + rows) {
        const local = position - start - 1;
        const own = keyOf?.(group.items[local], group.source);
        return typeof own === "string" || (typeof own === "number" && Number.isFinite(own))
          ? `row:${own}`
          : `row:${group.id}:${local}`;
      }
      start += rows + 1;
    }
    return position;
  };

  const list = (
    <GroupedVirtuoso
      ref={handle}
      scrollerRef={
        withShadows ? (el) => shadowRef(el instanceof HTMLElement ? el : null) : undefined
      }
      className={cn(SCROLLER_RING_INSET, str(className))}
      style={{ height: "100%" }}
      context={context}
      components={GROUPED_COMPONENTS}
      groupCounts={counts}
      groupContent={header}
      defaultItemHeight={rowPx}
      increaseViewportBy={overscanRows * rowPx}
      computeItemKey={(position) => keyAt(position)}
      itemContent={(index, groupIndex) => {
        const group = entries[groupIndex];
        if (!group) return null;
        const item = group.items[index - (offsets[groupIndex] ?? 0)];
        return node(render?.(item, index, group.source));
      }}
      // Virtuoso counts the headers; the public index is the last drawn row's.
      endReached={endReached && total > 0 ? () => endReached(total - 1) : undefined}
    />
  );
  if (!withShadows) return list;
  return (
    <div className="relative h-full min-h-0">
      {topShadow}
      {bottomShadow}
      {list}
    </div>
  );
}
