import { describe, expect, it } from "vitest";
import { CopyTreeOptionsSchema } from "../ipc.js";

/**
 * The IPC half of the selection guard (#11722).
 *
 * `filter` and `includePaths` are one selection set, unioned in
 * `CopyTreeService`. An empty selection cannot be expressed to the CopyTree SDK
 * — it reads a missing or empty filter as "no filter" and returns the whole
 * worktree — so an empty list or a blank entry has to be rejected at the
 * boundary rather than normalized downstream. Getting this wrong turns a
 * malformed narrow request into a full-repo bundle on the user's clipboard,
 * which is why it is pinned on both schemas independently: the renderer action
 * schema guards MCP/palette callers, this one guards everything that reaches
 * the main process.
 */
describe("CopyTreeOptionsSchema selection guards", () => {
  const parse = (options: unknown) => CopyTreeOptionsSchema.safeParse(options).success;

  it("rejects a selection that would resolve to nothing", () => {
    for (const options of [
      { includePaths: [] },
      { includePaths: [""] },
      { includePaths: ["src/a.ts", ""] },
      { filter: [] },
      { filter: [""] },
      { filter: "" },
    ]) {
      expect(parse(options)).toBe(false);
    }
  });

  it("accepts a real selection in either spelling, and both together", () => {
    expect(parse({ includePaths: ["src/a.ts"] })).toBe(true);
    expect(parse({ filter: "src/**" })).toBe(true);
    expect(parse({ filter: ["src/**"] })).toBe(true);
    expect(parse({ includePaths: ["src/a.ts"], filter: ["tests/**"] })).toBe(true);
  });

  it("still treats an omitted selection as the whole worktree", () => {
    // Absent is the one shape that legitimately means "everything" — the guard
    // above must not have made the field effectively required.
    expect(parse({})).toBe(true);
    expect(parse({ format: "xml" })).toBe(true);
  });
});
