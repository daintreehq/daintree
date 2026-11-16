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

const { createFuseSearch } = await import("../fuseIndex");

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

describe("createFuseSearch", () => {
  beforeEach(() => {
    fuseCalls.built = 0;
    fuseCalls.searched = 0;
  });

  it("builds nothing until the first search, then one index per list", () => {
    const search = createFuseSearch(OPTIONS);
    expect(fuseCalls).toEqual({ built: 0, searched: 0 });

    const items = rows();
    const first = search(items, "alp");
    expect(first.map((r) => r.item.id).sort()).toEqual(["a", "c"]);
    expect(fuseCalls).toEqual({ built: 1, searched: 1 });

    expect(search(items, "alp")).toBe(first);
    expect(fuseCalls).toEqual({ built: 1, searched: 1 });

    expect(search(items, "bet").map((r) => r.item.id)).toEqual(["b"]);
    expect(fuseCalls).toEqual({ built: 1, searched: 2 });
  });

  it("indexes a replacement list afresh rather than reusing the old one", () => {
    const search = createFuseSearch(OPTIONS);
    search(rows(), "alp");
    const replaced = rows().filter((row) => row.id !== "a");
    expect(search(replaced, "alp").map((r) => r.item.id)).toEqual(["c"]);
    expect(fuseCalls).toEqual({ built: 2, searched: 2 });
  });

  it("keeps each set of options to its own indexes", () => {
    const items = rows();
    const byName = createFuseSearch(OPTIONS);
    const byId = createFuseSearch<Row>({ keys: ["id"], threshold: 0.4 });
    expect(byName(items, "alp")).toHaveLength(2);
    expect(byId(items, "alp")).toEqual([]);
    expect(fuseCalls.built).toBe(2);
  });
});
