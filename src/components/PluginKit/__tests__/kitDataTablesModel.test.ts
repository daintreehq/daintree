import { describe, expect, it } from "vitest";
import { buildTableItems, clampWidth, declaredPx, selectionOrder } from "../kitDataTableModel";
import {
  buildTreeRows,
  createCheckReader,
  dropPositionAt,
  resolveDrop,
  resolveKeyMove,
  toggleChecked,
  type KnownChildren,
  type TreeId,
} from "../kitTreeModel";
import { buildInspectorRows, copyTextOf, type InspectorOptions } from "../kitObjectInspectorModel";

interface Row {
  id: string;
  env?: string;
  children?: Row[];
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && "id" in value;
}

function rowOf(value: unknown): Row {
  if (!isRow(value)) throw new Error("not a row");
  return value;
}

const keyOf = (row: unknown, index: number) => (isRow(row) ? row.id : index);

describe("buildTableItems", () => {
  const rows: Row[] = [
    { id: "a", env: "prod" },
    { id: "b", env: "staging" },
    { id: "c", env: "prod", children: [{ id: "c1" }, { id: "c2" }] },
  ];

  it("groups in first-seen order and keeps each row's index in `rows`", () => {
    const items = buildTableItems({
      rows,
      keyOf,
      groupOf: (row) => rowOf(row).env ?? "",
      collapsedGroups: new Set(),
      expanded: new Set(),
    });
    expect(items.map((item) => item.id)).toEqual([
      "group:prod",
      "row:string:a",
      "row:string:c",
      "group:staging",
      "row:string:b",
    ]);
    const c = items[2];
    expect(c?.kind === "row" && [c.index, c.level, c.posInSet, c.setSize]).toEqual([2, 2, 2, 2]);
  });

  it("keeps a folded group's rows in the selection order", () => {
    const items = buildTableItems({
      rows,
      keyOf,
      groupOf: (row) => rowOf(row).env ?? "",
      collapsedGroups: new Set(["prod"]),
      expanded: new Set(),
    });
    expect(selectionOrder(items, () => true)).toEqual(["a", "c", "b"]);
    const prod = items[0];
    expect(prod?.kind === "group" && prod.keys).toEqual(["a", "c"]);
  });

  it("leaves a folded group's rows out and keys an index-keyed row by its index in `rows`", () => {
    const items = buildTableItems({
      rows,
      keyOf: (_row, index) => index,
      groupOf: (row) => rowOf(row).env ?? "",
      collapsedGroups: new Set(["prod"]),
      expanded: new Set(),
    });
    expect(items.map((item) => item.id)).toEqual(["group:prod", "group:staging", "row:number:1"]);
  });

  it("draws expanded sub-rows a level deeper, and a status row while children load", () => {
    const subRowsOf = (row: unknown) => {
      const children = rowOf(row).children;
      if (children) return { kind: "rows" as const, rows: children };
      return rowOf(row).id === "b" ? { kind: "loading" as const } : { kind: "none" as const };
    };
    const items = buildTableItems({
      rows,
      keyOf,
      collapsedGroups: new Set(),
      expanded: new Set(["c", "b"]),
      subRowsOf,
    });
    expect(items.map((item) => item.id)).toEqual([
      "row:string:a",
      "row:string:b",
      "status:string:b",
      "row:string:c",
      "row:string:c1",
      "row:string:c2",
    ]);
    const c1 = items[4];
    expect(c1?.kind === "row" && [c1.depth, c1.level, c1.parentKey]).toEqual([1, 2, "c"]);
    expect(selectionOrder(items, () => true)).toEqual(["a", "b", "c", "c1", "c2"]);
  });

  it("draws a row met twice once, so cyclic sub-rows end", () => {
    const loop: Row = { id: "x" };
    const items = buildTableItems({
      rows: [loop],
      keyOf,
      collapsedGroups: new Set(),
      expanded: new Set(["x"]),
      subRowsOf: () => ({ kind: "rows", rows: [loop] }),
    });
    expect(items).toHaveLength(1);
  });

  it("clamps and reads widths", () => {
    expect(clampWidth(30, 48, 400)).toBe(48);
    expect(clampWidth(401.6, 48, 400)).toBe(400);
    expect(clampWidth(Number.NaN, 48, 400)).toBe(48);
    expect(declaredPx(120)).toBe(120);
    expect(declaredPx(" 96px ")).toBe(96);
    expect(declaredPx("20%")).toBeUndefined();
  });
});

interface Node {
  id: TreeId;
  label: string;
  children?: Node[];
}

const tree: Node[] = [
  {
    id: "api",
    label: "api",
    children: [
      { id: "auth", label: "auth" },
      { id: "billing", label: "billing" },
    ],
  },
  { id: "web", label: "web", children: [{ id: "edge", label: "edge" }] },
  { id: "jobs", label: "jobs" },
];

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "label" in value;
}

function nodeOf(value: unknown): Node {
  if (!isNode(value)) throw new Error("not a node");
  return value;
}

const idOf = (node: unknown) => nodeOf(node).id;
const childrenOf = (node: unknown): KnownChildren => {
  const children = nodeOf(node).children;
  return children ? { kind: "nodes", nodes: children } : { kind: "leaf" };
};
const loadedChildren = (node: unknown) => nodeOf(node).children ?? null;

function rowsFor(expanded: TreeId[]) {
  return buildTreeRows({
    nodes: tree,
    idOf,
    labelOf: (node) => nodeOf(node).label,
    childrenOf,
    expanded: new Set(expanded),
  });
}

describe("tree model", () => {
  it("flattens expanded nodes with their positions", () => {
    const rows = rowsFor(["api"]);
    expect(rows.map((row) => row.path)).toEqual([
      "s:api",
      "s:auth",
      "s:billing",
      "s:web",
      "s:jobs",
    ]);
    const billing = rows[2];
    expect(
      billing?.kind === "node" && [billing.depth, billing.parentId, billing.index, billing.setSize]
    ).toEqual([1, "api", 1, 2]);
  });

  it("derives tri-state checks from known children", () => {
    const read = createCheckReader({ idOf, loadedChildren }, new Set(["auth"]));
    expect(read(tree[0])).toBe("mixed");
    expect(read(tree[1])).toBe(false);
    const all = createCheckReader({ idOf, loadedChildren }, new Set(["auth", "billing"]));
    expect(all(tree[0])).toBe(true);
  });

  it("checks a parent's subtree and settles its ancestors", () => {
    const input = { idOf, loadedChildren };
    const on = toggleChecked(input, new Set(), tree[0], []);
    expect(new Set(on)).toEqual(new Set(["api", "auth", "billing"]));
    // Turning one child off takes the parent off with it.
    const off = toggleChecked(input, new Set(on), tree[0]!.children![0], [tree[0]]);
    expect(new Set(off)).toEqual(new Set(["billing"]));
    // A mixed parent toggles on.
    const fill = toggleChecked(input, new Set(off), tree[0], []);
    expect(new Set(fill)).toEqual(new Set(["api", "auth", "billing"]));
  });

  it("ends on cyclic children when reading and toggling checks", () => {
    const loop: Node = { id: "loop", label: "loop" };
    loop.children = [loop, loop];
    const input = { idOf, loadedChildren };
    expect(createCheckReader(input, new Set(["loop"]))(loop)).toBe(true);
    expect(toggleChecked(input, new Set(), loop, [])).toEqual(["loop"]);
  });

  it("resolves drops counted with the node removed, and refuses its own subtree", () => {
    const rows = rowsFor(["api", "web"]);
    // auth after billing, same parent: index 1 once auth is out.
    expect(resolveDrop(rows, "auth", "billing", "after", 0)).toEqual({
      id: "auth",
      parentId: "api",
      index: 1,
      fromParentId: "api",
      fromIndex: 0,
    });
    // Into web, appended after its one child.
    expect(resolveDrop(rows, "jobs", "web", "inside", 1)).toMatchObject({
      parentId: "web",
      index: 1,
    });
    expect(resolveDrop(rows, "api", "auth", "inside", 0)).toBeNull();
    expect(resolveDrop(rows, "auth", "billing", "before", 0)).toBeNull();
    expect(dropPositionAt(2, 24, true)).toBe("before");
    expect(dropPositionAt(12, 24, true)).toBe("inside");
    expect(dropPositionAt(20, 24, true)).toBe("after");
    expect(dropPositionAt(10, 24, false)).toBe("before");
  });

  it("resolves Alt+arrow moves", () => {
    const rows = rowsFor(["api"]);
    const count = (id: TreeId) => (id === "web" ? 1 : 0);
    expect(resolveKeyMove(rows, "billing", "ArrowUp", count)).toMatchObject({ index: 0 });
    expect(resolveKeyMove(rows, "billing", "ArrowDown", count)).toBeNull();
    expect(resolveKeyMove(rows, "billing", "ArrowLeft", count)).toMatchObject({
      parentId: null,
      index: 1,
    });
    expect(resolveKeyMove(rows, "jobs", "ArrowRight", count)).toMatchObject({
      parentId: "web",
      index: 1,
    });
    expect(resolveKeyMove(rows, "api", "ArrowLeft", count)).toBeNull();
  });
});

const options = (overrides: Partial<InspectorOptions> = {}): InspectorOptions => ({
  name: null,
  expandDepth: 1,
  overrides: new Map(),
  filter: "",
  maxStringLength: 200,
  chunkSize: 100,
  sortKeys: false,
  expandedStrings: new Set(),
  maxRows: 100_000,
  ...overrides,
});

describe("buildInspectorRows", () => {
  const value = {
    id: "dep_42",
    status: "ready",
    meta: { region: "iad1", replicas: 3, canary: false, owner: null },
    tags: ["web", "edge"],
  };

  it("opens to depth and summarises closed containers", () => {
    const { rows } = buildInspectorRows(value, options());
    expect(rows.map((row) => [row.name, row.preview])).toEqual([
      ["", "{4 keys}"],
      ["id", '"dep_42"'],
      ["status", '"ready"'],
      ["meta", "{4 keys}"],
      ["tags", "Array(2)"],
    ]);
    expect(rows[3]?.copyPath).toBe("meta");
    const deep = buildInspectorRows(value, options({ name: "deployment", expandDepth: Infinity }));
    expect(deep.rows.find((row) => row.name === "replicas")?.copyPath).toBe(
      "deployment.meta.replicas"
    );
    expect(deep.rows.find((row) => row.name === "1")?.copyPath).toBe("deployment.tags[1]");
  });

  it("keeps the way down to filter matches and drops the rest", () => {
    const { rows } = buildInspectorRows(value, options({ filter: "IAD" }));
    expect(rows.map((row) => row.name)).toEqual(["", "meta", "region"]);
    expect(rows.find((row) => row.name === "region")?.match).toBe(true);
  });

  it("cuts long strings until shown in full", () => {
    const long = { text: "x".repeat(300) };
    const cut = buildInspectorRows(long, options({ maxStringLength: 10 })).rows[1];
    expect(cut?.truncated).toBe(true);
    expect(cut?.preview).toBe(JSON.stringify("x".repeat(10)));
    const full = buildInspectorRows(
      long,
      options({ maxStringLength: 10, expandedStrings: new Set(["/text"]) })
    ).rows[1];
    expect(full?.truncated).toBe(false);
  });

  it("splits a big array into ranges, nesting when one level is not enough", () => {
    const items = Array.from({ length: 250 }, (_, index) => index);
    const { rows } = buildInspectorRows(items, options({ chunkSize: 100 }));
    expect(rows.map((row) => row.name)).toEqual(["", "[0 … 99]", "[100 … 199]", "[200 … 249]"]);
    const huge = Array.from({ length: 25 }, (_, index) => index);
    const nested = buildInspectorRows(huge, options({ chunkSize: 4 })).rows;
    expect(nested.slice(1).map((row) => row.name)).toEqual(["[0 … 15]", "[16 … 24]"]);
  });

  it("keeps the root apart from an empty key, and paths Map keys in their own type", () => {
    const { rows } = buildInspectorRows({ "": 1 }, options());
    expect(rows.map((row) => row.path)).toEqual(["", "/"]);
    const map = new Map<unknown, number>([
      [1, 10],
      ["a", 20],
      [{ k: 1 }, 30],
    ]);
    const mapRows = buildInspectorRows(map, options({ name: "m" })).rows;
    expect(mapRows.slice(1).map((row) => row.copyPath)).toEqual([
      "m.get(1)",
      'm.get("a")',
      "[...m.values()][2]",
    ]);
  });

  it("labels nested ranges by their items' indices and opens them on Expand all", () => {
    const items = Array.from({ length: 25 }, (_, index) => index);
    const open = buildInspectorRows(items, options({ chunkSize: 4, expandDepth: Infinity })).rows;
    expect(open.filter((row) => row.keyKind === "range").map((row) => row.name)).toContain(
      "[20 … 23]"
    );
    expect(open.some((row) => row.keyKind === "index" && row.name === "24")).toBe(true);
  });

  it("reports a match a collapsed branch hides", () => {
    const build = buildInspectorRows(
      { meta: { region: "iad1" } },
      options({ filter: "iad", overrides: new Map([["/meta", false]]) })
    );
    expect(build.matched).toBe(true);
    expect(build.rows.map((row) => row.name)).toEqual(["", "meta", "region"]);
    expect(buildInspectorRows({ a: 1 }, options({ filter: "zzz" })).matched).toBe(false);
  });

  it("copies a __proto__ key as data", () => {
    const value: unknown = JSON.parse('{"__proto__":{"x":1}}');
    expect(JSON.parse(copyTextOf(value, "object"))).toEqual(JSON.parse('{"__proto__":{"x":1}}'));
    expect(copyTextOf(value, "object")).toContain('"__proto__"');
  });

  it("shows a value inside itself as circular and copies shared values twice", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    const { rows } = buildInspectorRows(loop, options({ expandDepth: 3 }));
    expect(rows.find((row) => row.name === "self")?.kind).toBe("circular");
    const shared = { a: 1 };
    expect(JSON.parse(copyTextOf({ x: shared, y: shared }, "object"))).toEqual({
      x: { a: 1 },
      y: { a: 1 },
    });
    expect(JSON.parse(copyTextOf(loop, "object"))).toEqual({ name: "loop", self: "[Circular]" });
    expect(copyTextOf("plain", "string")).toBe("plain");
  });
});
