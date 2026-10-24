import type { CSSProperties, HTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import type { ItemProps, ScrollerProps, TableBodyProps, TableProps } from "react-virtuoso";
import { ContextMenuTrigger } from "@/components/ui/context-menu-base";
import {
  LIST_ROW_HOVER_CLASS,
  PALETTE_ROW_CLASS,
  ROW_MENU_TARGET_CLASS,
} from "@/components/ui/paletteRowStyles";
import { cn } from "@/lib/utils";
import { DENSITY_TEXT_CLASS, GRID_FOCUS_RING, type TableDensity } from "./PluginKitLists";
import type { DrawnGroup, DrawnItem, DrawnRow } from "./kitDataTableModel";
import type { RichColumn } from "./kitDataTableColumns";

export interface RichContext {
  items: readonly DrawnItem[];
  columns: readonly RichColumn[];
  interactive: boolean;
  selectable: boolean;
  activeIndex: number;
  isSelected: (row: DrawnRow) => boolean;
  rowId: (index: number) => string;
  tableProps: Record<string, unknown>;
  tableStyle: CSSProperties;
  scrolledX: boolean;
  /** Rows carry levels and positions only in a treegrid. */
  treegrid: boolean;
  /** A group's selection, with a checkbox column; null without one. */
  groupSelected: (group: DrawnGroup) => boolean | null;
  onRowClick: (index: number, event: MouseEvent<HTMLTableRowElement>) => void;
  menuIndex: number;
  openRowMenu: ((event: MouseEvent<HTMLElement>) => void) | undefined;
  density: TableDensity;
  striped: boolean;
}

function RichScroller({
  context: _context,
  ref,
  ...props
}: ScrollerProps & { context: RichContext; ref?: Ref<HTMLDivElement> }) {
  return <div {...props} ref={ref} tabIndex={-1} />;
}

export function RichTableElement({
  context,
  style,
  children,
}: TableProps & { context: RichContext }) {
  return (
    <table
      {...context.tableProps}
      data-scrolled-x={context.scrolledX ? "" : undefined}
      style={{ ...style, ...context.tableStyle }}
      className={cn(DENSITY_TEXT_CLASS[context.density], context.interactive && GRID_FOCUS_RING)}
    >
      {children}
    </table>
  );
}

function RichTableBody({
  context,
  ref,
  ...props
}: TableBodyProps & { context: RichContext; ref?: Ref<HTMLTableSectionElement> }) {
  if (!context.openRowMenu) return <tbody {...props} ref={ref} />;
  return (
    <ContextMenuTrigger asChild onContextMenu={context.openRowMenu}>
      <tbody {...props} ref={ref} />
    </ContextMenuTrigger>
  );
}

type RowAttributes = HTMLAttributes<HTMLTableRowElement> & {
  [attribute: `data-${string}`]: string | undefined;
};

/** A drawn item's row attributes, whether the virtualiser or the plain table draws it. */
function richRowProps(context: RichContext, index: number): RowAttributes {
  const item = context.items[index];
  if (!item) return {};
  const active = context.interactive && index === context.activeIndex;
  const common: RowAttributes = {
    id: context.interactive ? context.rowId(index) : undefined,
    "aria-rowindex": index + 2,
    "data-active": active ? "true" : undefined,
    onClick: (event: MouseEvent<HTMLTableRowElement>) => context.onRowClick(index, event),
  };
  const tree = context.treegrid;
  if (item.kind === "group") {
    return {
      ...common,
      "aria-level": 1,
      "aria-expanded": !item.collapsed,
      "aria-selected": context.groupSelected(item) ?? undefined,
      "aria-posinset": item.posInSet,
      "aria-setsize": item.setSize,
      "data-group-row": item.groupKey,
      className: "cursor-pointer",
    };
  }
  if (item.kind === "status") {
    return {
      ...common,
      "aria-level": tree ? item.level : undefined,
      "aria-posinset": tree ? 1 : undefined,
      "aria-setsize": tree ? 1 : undefined,
      "data-status-row": item.status,
    };
  }
  const selected = context.isSelected(item);
  return {
    ...common,
    "aria-level": tree ? item.level : undefined,
    "aria-posinset": tree ? item.posInSet : undefined,
    "aria-setsize": tree ? item.setSize : undefined,
    "aria-expanded": tree && item.expandable ? item.expanded : undefined,
    "aria-selected": context.interactive ? selected : undefined,
    "data-selected": !context.interactive && selected ? "true" : undefined,
    "data-hoverable": context.interactive ? "" : undefined,
    // Pinned cells repeat the row's fills over their own; this tells them to stripe.
    "data-striped": context.striped && index % 2 === 1 ? "" : undefined,
    "data-state": index === context.menuIndex ? "open" : undefined,
    className: cn(
      PALETTE_ROW_CLASS,
      context.interactive && [LIST_ROW_HOVER_CLASS, "cursor-pointer"],
      context.openRowMenu && ROW_MENU_TARGET_CLASS
    ),
  };
}

function RichTableRow({
  context,
  item: _item,
  ...props
}: ItemProps<DrawnItem> & { context: RichContext }) {
  return <tr {...props} {...richRowProps(context, props["data-index"])} />;
}

export const RICH_COMPONENTS = {
  Scroller: RichScroller,
  Table: RichTableElement,
  TableBody: RichTableBody,
  TableRow: RichTableRow,
};

// Pinned as the virtualiser pins its own, so a plain table given a height
// keeps its header and totals in view while its rows scroll.
const PLAIN_HEAD_STYLE: CSSProperties = { position: "sticky", top: 0, zIndex: 2 };
const PLAIN_FOOT_STYLE: CSSProperties = { position: "sticky", bottom: 0, zIndex: 1 };

/** The plain table's sections: every drawn item at once, in the virtualiser's rows and cells. */
export function PlainTableSections({
  context,
  header,
  footer,
  renderItem,
}: {
  context: RichContext;
  header: () => ReactNode;
  footer: (() => ReactNode) | undefined;
  renderItem: (index: number) => ReactNode;
}) {
  const body = (
    <tbody>
      {context.items.map((item, index) => (
        <tr key={item.id} data-index={index} {...richRowProps(context, index)}>
          {renderItem(index)}
        </tr>
      ))}
    </tbody>
  );
  return (
    <>
      <thead style={PLAIN_HEAD_STYLE}>{header()}</thead>
      {context.openRowMenu ? (
        <ContextMenuTrigger asChild onContextMenu={context.openRowMenu}>
          {body}
        </ContextMenuTrigger>
      ) : (
        body
      )}
      {footer ? <tfoot style={PLAIN_FOOT_STYLE}>{footer()}</tfoot> : null}
    </>
  );
}
