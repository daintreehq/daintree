import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IFuseOptions } from "fuse.js";

const fuseCalls = vi.hoisted(() => ({ built: 0, searched: 0 }));

vi.mock("fuse.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fuse.js")>();
  const Real = actual.default as unknown as new (...args: unknown[]) => {
    search: (...args: unknown[]) => unknown;
  };
  function CountingFuse(...args: unknown[]) {
    fuseCalls.built += 1;
    const fuse = new Real(...args);
    const search = fuse.search.bind(fuse);
    fuse.search = (...searchArgs: unknown[]) => {
      fuseCalls.searched += 1;
      return search(...searchArgs);
    };
    return fuse;
  }
  return { ...actual, default: CountingFuse };
});

const { searchFuseIndex } = await import("../fuseIndex");

interface Row {
  id: string;
  name: string;
}

const OPTIONS: IFuseOptions<Row> = { keys: ["name"], threshold: 0.4 };
const rows = (): Row[] => [
  { id: "a", name: "alpha" },
  { id: "b", name: "beta" },
  { id: "c", name: "alpine" },
];

describe("searchFuseIndex", () => {
  beforeEach(() => {
    fuseCalls.built = 0;
    fuseCalls.searched = 0;
  });

  it("builds one index per list and answers a repeated query from the last hits", () => {
    const items = rows();
    const first = searchFuseIndex(items, OPTIONS, "alp");
    expect(first.map((r) => r.item.id).sort()).toEqual(["a", "c"]);

    expect(searchFuseIndex(items, OPTIONS, "alp")).toBe(first);
    expect(fuseCalls).toEqual({ built: 1, searched: 1 });

    const next = searchFuseIndex(items, OPTIONS, "bet");
    expect(next.map((r) => r.item.id)).toEqual(["b"]);
    expect(fuseCalls).toEqual({ built: 1, searched: 2 });
  });

  it("indexes a new list, and rebuilds when the same list is searched with other options", () => {
    const items = rows();
    searchFuseIndex(items, OPTIONS, "alp");
    searchFuseIndex(rows(), OPTIONS, "alp");
    expect(fuseCalls.built).toBe(2);

    const byId: IFuseOptions<Row> = { keys: ["id"], threshold: 0.4 };
    expect(searchFuseIndex(items, byId, "alp")).toEqual([]);
    expect(fuseCalls.built).toBe(3);
  });
});
