// The rows a rich DataTable draws, in order: group headers, data rows at their
// depth, and the loading or error row under a row whose children are still
// coming. Pure, so grouping and expansion are tested without a DOM.

export type RowKey = string | number;

export interface DrawnGroup {
  kind: "group";
  /** Unique among drawn items: `group:<key>`. */
  id: string;
  groupKey: string;
  rows: readonly unknown[];
  /** Each of `rows`' keys, in the same order, whether the group is folded or not. */
  keys: readonly RowKey[];
  collapsed: boolean;
  posInSet: number;
  setSize: number;
}

export interface DrawnRow {
  kind: "row";
  id: string;
  row: unknown;
  key: RowKey;
  /** The row's index among its siblings: in `rows` at the top, in its parent's children below. */
  index: number;
  /** 0 for a top-level row, whether grouped or not. */
  depth: number;
  /** The ARIA level: one deeper than `depth` under a group header. */
  level: number;
  expandable: boolean;
  expanded: boolean;
  parentKey: RowKey | null;
  groupKey: string | null;
  posInSet: number;
  setSize: number;
}

export interface DrawnStatus {
  kind: "status";
  id: string;
  parentKey: RowKey;
  parentRow: unknown;
  depth: number;
  level: number;
  status: "loading" | "error";
  message: string;
}

export type DrawnItem = DrawnGroup | DrawnRow | DrawnStatus;

export type SubRows =
  | { kind: "none" }
  | { kind: "rows"; rows: readonly unknown[] }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  /** Has children not asked for yet: drawn with a disclosure, loaded on expand. */
  | { kind: "unloaded" };

export interface TableModelInput {
  rows: readonly unknown[];
  keyOf: (row: unknown, index: number) => RowKey;
  /** Set when the table is grouped. */
  groupOf?: (row: unknown) => string;
  collapsedGroups: ReadonlySet<string>;
  expanded: ReadonlySet<RowKey>;
  /** A row's children: `expanded` says whether the caller should load them now. */
  subRowsOf?: (row: unknown, expanded: boolean) => SubRows;
  /** Changes when a lazy load settles, so a memoised build is redone. Not read. */
  revision?: number;
}

/** Deeper than any real hierarchy; a plugin's cyclic data stops here. */
export const MAX_ROW_DEPTH = 32;

/** A group's key as drawn: the empty key is its own group, labelled "None". */
export function groupKeyOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return "";
}

export function buildTableItems(input: TableModelInput): DrawnItem[] {
  const out: DrawnItem[] = [];
  const seen = new Set<RowKey>();
  const grouped = input.groupOf !== undefined;

  const visit = (
    list: readonly unknown[],
    depth: number,
    parentKey: RowKey | null,
    groupKey: string | null,
    indices?: readonly number[]
  ) => {
    list.forEach((row, position) => {
      // A grouped top-level row keeps the index it has in `rows`.
      const index = indices?.[position] ?? position;
      const key = input.keyOf(row, index);
      // A key met twice (a cycle, or a plugin's duplicate) is drawn once.
      if (seen.has(key)) return;
      seen.add(key);
      const isExpanded = input.expanded.has(key);
      const sub: SubRows =
        depth + 1 < MAX_ROW_DEPTH && input.subRowsOf
          ? input.subRowsOf(row, isExpanded)
          : { kind: "none" };
      const expandable = sub.kind === "rows" ? sub.rows.length > 0 : sub.kind !== "none";
      const expanded = expandable && isExpanded;
      const level = depth + (grouped ? 2 : 1);
      out.push({
        kind: "row",
        id: `row:${typeof key}:${key}`,
        row,
        key,
        index,
        depth,
        level,
        expandable,
        expanded,
        parentKey,
        groupKey,
        posInSet: position + 1,
        setSize: list.length,
      });
      if (!expanded) return;
      if (sub.kind === "rows") {
        visit(sub.rows, depth + 1, key, groupKey);
      } else if (sub.kind === "loading" || sub.kind === "error" || sub.kind === "unloaded") {
        out.push({
          kind: "status",
          id: `status:${typeof key}:${key}`,
          parentKey: key,
          parentRow: row,
          depth: depth + 1,
          level: level + 1,
          status: sub.kind === "error" ? "error" : "loading",
          message: sub.kind === "error" ? sub.message : "",
        });
      }
    });
  };

  const groupOf = input.groupOf;
  if (!groupOf) {
    visit(input.rows, 0, null, null);
    return out;
  }
  // Groups in the order their first row comes, each row keeping its index in `rows`.
  const groups = new Map<string, { rows: unknown[]; indices: number[] }>();
  input.rows.forEach((row, index) => {
    const key = groupKeyOf(groupOf(row));
    let group = groups.get(key);
    if (!group) {
      group = { rows: [], indices: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
    group.indices.push(index);
  });
  let position = 0;
  for (const [groupKey, group] of groups) {
    position += 1;
    const collapsed = input.collapsedGroups.has(groupKey);
    out.push({
      kind: "group",
      id: `group:${groupKey}`,
      groupKey,
      rows: group.rows,
      keys: group.rows.map((row, local) => input.keyOf(row, group.indices[local] ?? local)),
      collapsed,
      posInSet: position,
      setSize: groups.size,
    });
    if (collapsed) continue;
    visit(group.rows, 0, null, groupKey, group.indices);
  }
  return out;
}

/**
 * The selectable rows' keys in drawn order, a folded group's rows standing in
 * its place: folding a group hides its rows without dropping them from the
 * selection or from "select all".
 */
export function selectionOrder(
  items: readonly DrawnItem[],
  include: (row: unknown) => boolean
): RowKey[] {
  const keys: RowKey[] = [];
  for (const item of items) {
    if (item.kind === "row") {
      if (include(item.row)) keys.push(item.key);
    } else if (item.kind === "group" && item.collapsed) {
      item.rows.forEach((row, index) => {
        const key = item.keys[index];
        if (key !== undefined && include(row)) keys.push(key);
      });
    }
  }
  return keys;
}

/** Clamps a resized width to the column's limits, rounded to whole px. */
export function clampWidth(width: number, min: number, max: number): number {
  if (!Number.isFinite(width)) return min;
  return Math.round(Math.min(Math.max(width, min), max));
}

/** The px a column's declared width stands for, when it is one: `120` or `"120px"`. */
export function declaredPx(width: number | string | undefined): number | undefined {
  if (typeof width === "number") return width;
  if (typeof width !== "string") return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(width);
  return match ? Number(match[1]) : undefined;
}
