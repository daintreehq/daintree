// The generic TreeView's model: the rows it draws, tri-state checks, and the
// moves a drag or Alt+arrow resolves to. Pure, so it is tested without a DOM.
// Rows carry the `path`/`name`/`isDirectory`/`isExpanded` fields the file
// tree's key and typeahead resolvers read, so both trees share them.

export type TreeId = string | number;

export type KnownChildren =
  | { kind: "leaf" }
  | { kind: "nodes"; nodes: readonly unknown[] }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  /** May have children nobody has asked for yet. */
  | { kind: "unknown" };

export interface TreeRow {
  kind: "node";
  /** The row key: the id spelled with its type, so `1` and `"1"` stay apart. */
  path: string;
  id: TreeId;
  node: unknown;
  name: string;
  depth: number;
  isDirectory: boolean;
  isExpanded: boolean;
  isLoading: boolean;
  parentId: TreeId | null;
  /** Its index among its parent's children. */
  index: number;
  posInSet: number;
  setSize: number;
}

export interface TreeStatusRow {
  kind: "status";
  path: string;
  name: string;
  depth: number;
  isDirectory: false;
  isExpanded: false;
  isLoading: boolean;
  parentId: TreeId;
  parentNode: unknown;
  status: "loading" | "error";
  message: string;
  posInSet: number;
  setSize: number;
}

export type TreeViewRow = TreeRow | TreeStatusRow;

export const MAX_TREE_DEPTH = 64;

export function treeKey(id: TreeId): string {
  return `${typeof id === "number" ? "n" : "s"}:${id}`;
}

export function isTreeId(value: unknown): value is TreeId {
  return (
    (typeof value === "string" && value !== "") ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

export interface TreeModelInput {
  nodes: readonly unknown[];
  idOf: (node: unknown) => TreeId | undefined;
  labelOf: (node: unknown) => string;
  /** What is known of a node's children; `expanded` says whether it is open now. */
  childrenOf: (node: unknown, expanded: boolean) => KnownChildren;
  expanded: ReadonlySet<TreeId>;
  /** Changes when a lazy load settles, so a memoised build is redone. Not read. */
  revision?: number;
}

export function buildTreeRows(input: TreeModelInput): TreeViewRow[] {
  const rows: TreeViewRow[] = [];
  const seen = new Set<TreeId>();
  const visit = (list: readonly unknown[], depth: number, parentId: TreeId | null) => {
    const entries: { node: unknown; id: TreeId }[] = [];
    for (const node of list) {
      const id = input.idOf(node);
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      entries.push({ node, id });
    }
    entries.forEach(({ node, id }, index) => {
      const open = input.expanded.has(id);
      const known: KnownChildren =
        depth + 1 < MAX_TREE_DEPTH ? input.childrenOf(node, open) : { kind: "leaf" };
      const isDirectory = known.kind === "nodes" ? known.nodes.length > 0 : known.kind !== "leaf";
      const isExpanded = isDirectory && open;
      rows.push({
        kind: "node",
        path: treeKey(id),
        id,
        node,
        name: input.labelOf(node),
        depth,
        isDirectory,
        isExpanded,
        isLoading: isExpanded && (known.kind === "loading" || known.kind === "unknown"),
        parentId,
        index,
        posInSet: index + 1,
        setSize: entries.length,
      });
      if (!isExpanded) return;
      if (known.kind === "nodes") {
        visit(known.nodes, depth + 1, id);
      } else if (known.kind !== "leaf") {
        rows.push({
          kind: "status",
          path: `status:${treeKey(id)}`,
          name: "",
          depth: depth + 1,
          isDirectory: false,
          isExpanded: false,
          isLoading: known.kind !== "error",
          parentId: id,
          parentNode: node,
          status: known.kind === "error" ? "error" : "loading",
          message: known.kind === "error" ? known.message : "",
          posInSet: 1,
          setSize: 1,
        });
      }
    });
  };
  visit(input.nodes, 0, null);
  return rows;
}

// Checks.

export interface CheckInput {
  idOf: (node: unknown) => TreeId | undefined;
  /** A node's children when they are known without loading: sync, or already loaded. */
  loadedChildren: (node: unknown) => readonly unknown[] | null;
}

export type CheckState = boolean | "mixed";

/**
 * Each node's check state, derived: a node with known children is on when
 * all of them are, mixed when some are; a node without is on when its id is
 * in `checked`. Computed lazily and remembered for one render's reads.
 */
export function createCheckReader(input: CheckInput, checked: ReadonlySet<TreeId>) {
  const memo = new Map<unknown, CheckState>();
  // A node met again inside its own subtree (cyclic data) reads as its own id.
  const reading = new Set<unknown>();
  const read = (node: unknown, depth: number): CheckState => {
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    const id = input.idOf(node);
    if (reading.has(node)) return id !== undefined && checked.has(id);
    reading.add(node);
    const children = depth < MAX_TREE_DEPTH ? input.loadedChildren(node) : null;
    let state: CheckState;
    if (!children || children.length === 0) {
      state = id !== undefined && checked.has(id);
    } else {
      let on = 0;
      let mixed = false;
      for (const child of children) {
        const childState = read(child, depth + 1);
        if (childState === true) on += 1;
        else if (childState === "mixed") mixed = true;
      }
      state = on === children.length ? true : on > 0 || mixed ? "mixed" : false;
    }
    reading.delete(node);
    memo.set(node, state);
    return state;
  };
  return (node: unknown): CheckState => read(node, 0);
}

/**
 * The checked ids after toggling `target`: it and every known descendant take
 * the new state, and each ancestor is then on exactly when all its known
 * children are. `ancestors` runs from the root down to the target's parent.
 */
export function toggleChecked(
  input: CheckInput,
  checked: ReadonlySet<TreeId>,
  target: unknown,
  ancestors: readonly unknown[]
): TreeId[] {
  const read = createCheckReader(input, checked);
  const turnOn = read(target) !== true;
  const next = new Set(checked);
  const applied = new Set<unknown>();
  const apply = (node: unknown, depth: number) => {
    if (applied.has(node)) return;
    applied.add(node);
    const id = input.idOf(node);
    if (id !== undefined) {
      if (turnOn) next.add(id);
      else next.delete(id);
    }
    if (depth >= MAX_TREE_DEPTH) return;
    for (const child of input.loadedChildren(node) ?? []) apply(child, depth + 1);
  };
  apply(target, 0);
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const ancestor = ancestors[i];
    const id = input.idOf(ancestor);
    if (id === undefined) continue;
    const after = createCheckReader(input, next)(ancestor);
    if (after === true) next.add(id);
    else next.delete(id);
  }
  return [...next];
}

// Moves.

export interface TreeMoveResult {
  id: TreeId;
  parentId: TreeId | null;
  index: number;
  fromParentId: TreeId | null;
  fromIndex: number;
}

export type DropPosition = "before" | "after" | "inside";

/** Where on a row a pointer at `offsetY` drops: its upper quarter, lower quarter, or middle. */
export function dropPositionAt(offsetY: number, height: number, canNest: boolean): DropPosition {
  const band = canNest ? height / 4 : height / 2;
  if (offsetY < band) return "before";
  if (offsetY >= height - band) return "after";
  return "inside";
}

function rowById(rows: readonly TreeViewRow[]): Map<TreeId, TreeRow> {
  const map = new Map<TreeId, TreeRow>();
  for (const row of rows) if (row.kind === "node") map.set(row.id, row);
  return map;
}

/** Whether `id` is `ancestor` or sits anywhere below it. */
export function isWithin(rows: readonly TreeViewRow[], id: TreeId, ancestor: TreeId): boolean {
  const byId = rowById(rows);
  let current: TreeId | null = id;
  for (let guard = 0; current !== null && guard <= MAX_TREE_DEPTH; guard += 1) {
    if (current === ancestor) return true;
    current = byId.get(current)?.parentId ?? null;
  }
  return false;
}

/**
 * The move a drop resolves to, or null for none (onto itself, into its own
 * subtree, or back where it was). `childCount` is how many children the
 * target has now, for a drop inside it, which appends.
 */
export function resolveDrop(
  rows: readonly TreeViewRow[],
  dragId: TreeId,
  targetId: TreeId,
  position: DropPosition,
  childCount: number
): TreeMoveResult | null {
  const byId = rowById(rows);
  const dragged = byId.get(dragId);
  const target = byId.get(targetId);
  if (!dragged || !target) return null;
  if (isWithin(rows, targetId, dragId)) return null;
  const from = { fromParentId: dragged.parentId, fromIndex: dragged.index };
  let parentId: TreeId | null;
  let index: number;
  if (position === "inside") {
    parentId = target.id;
    index = childCount;
    if (dragged.parentId === parentId) index -= 1;
  } else {
    parentId = target.parentId;
    index = target.index + (position === "after" ? 1 : 0);
    // Counted with the dragged node removed, as the plugin applies it.
    if (dragged.parentId === parentId && dragged.index < index) index -= 1;
  }
  index = Math.max(0, index);
  if (parentId === from.fromParentId && index === from.fromIndex) return null;
  return { id: dragId, parentId, index, ...from };
}

/** The move an Alt+arrow asks of the node at `id`, or null where it cannot go. */
export function resolveKeyMove(
  rows: readonly TreeViewRow[],
  id: TreeId,
  key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight",
  childCount: (id: TreeId) => number
): TreeMoveResult | null {
  const byId = rowById(rows);
  const row = byId.get(id);
  if (!row) return null;
  const from = { fromParentId: row.parentId, fromIndex: row.index };
  const siblings = rows.filter(
    (candidate): candidate is TreeRow =>
      candidate.kind === "node" && candidate.parentId === row.parentId
  );
  switch (key) {
    case "ArrowUp":
      return row.index > 0 ? { id, parentId: row.parentId, index: row.index - 1, ...from } : null;
    case "ArrowDown":
      return row.index < row.setSize - 1
        ? { id, parentId: row.parentId, index: row.index + 1, ...from }
        : null;
    case "ArrowLeft": {
      if (row.parentId === null) return null;
      const parent = byId.get(row.parentId);
      if (!parent) return null;
      return { id, parentId: parent.parentId, index: parent.index + 1, ...from };
    }
    case "ArrowRight": {
      const above = siblings.find((candidate) => candidate.index === row.index - 1);
      if (!above) return null;
      return { id, parentId: above.id, index: childCount(above.id), ...from };
    }
  }
}

/** The rows from the root down to `id`'s parent. */
export function ancestorsOf(rows: readonly TreeViewRow[], id: TreeId): TreeRow[] {
  const byId = rowById(rows);
  const chain: TreeRow[] = [];
  let current = byId.get(id)?.parentId ?? null;
  for (let guard = 0; current !== null && guard <= MAX_TREE_DEPTH; guard += 1) {
    const row = byId.get(current);
    if (!row) break;
    chain.unshift(row);
    current = row.parentId;
  }
  return chain;
}
