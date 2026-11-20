import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { walkEagerGraph } from "../../../../../scripts/lib/static-import-graph.mjs";

// The entry is globbed eagerly into the host bundle for every user, and the
// plugin is on by default: the table and its parser must load only when a
// table is shown, never with the entry.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");

describe("csv-viewer renderer entry", () => {
  it("reaches neither the table view nor the parser eagerly", () => {
    const { files, unresolved } = walkEagerGraph(resolve(ROOT, "renderer/index.ts"), ROOT);
    expect(unresolved).toEqual([]);
    const names = files.map((file: string) => basename(file));
    expect(names).toContain("index.ts");
    expect(names.filter((name: string) => /^(CsvTableView|delimited)\./.test(name))).toEqual([]);
  });
});
