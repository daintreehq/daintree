import { describe, expect, it } from "vitest";
import {
  canonicalizeCopyTreeOptions,
  deriveCopyTreeRunName,
  resolveCopyTreeRunName,
  sortCopyTreeHistory,
} from "../copyTreeHistory.js";
import { COPY_TREE_HISTORY_NAME_MAX_LENGTH } from "../../types/ipc/copyTreeHistory.js";
import type { CopyTreeHistoryRecord } from "../../types/ipc/copyTreeHistory.js";

describe("canonicalizeCopyTreeOptions", () => {
  it("collapses a string pattern and its one-element array form to the same shape", () => {
    expect(canonicalizeCopyTreeOptions({ filter: "src/**" })).toEqual(
      canonicalizeCopyTreeOptions({ filter: ["src/**"] })
    );
    expect(canonicalizeCopyTreeOptions({ exclude: "dist" })).toEqual(
      canonicalizeCopyTreeOptions({ exclude: ["dist"] })
    );
  });

  it("makes the unordered array fields order-insensitive", () => {
    const forwards = canonicalizeCopyTreeOptions({
      filter: ["b", "a"],
      exclude: ["z", "y"],
      always: ["q", "p"],
      includePaths: ["n", "m"],
      scopePaths: ["d", "c"],
    });
    const backwards = canonicalizeCopyTreeOptions({
      filter: ["a", "b"],
      exclude: ["y", "z"],
      always: ["p", "q"],
      includePaths: ["m", "n"],
      scopePaths: ["c", "d"],
    });
    expect(forwards).toEqual(backwards);
  });

  it("drops duplicates within an unordered field", () => {
    expect(canonicalizeCopyTreeOptions({ scopePaths: ["src", "src", "lib"] })).toEqual(
      canonicalizeCopyTreeOptions({ scopePaths: ["lib", "src"] })
    );
  });

  it("keeps an absent field distinct from an explicitly empty one", () => {
    // `undefined` lets project settings back-fill at merge time; `[]` blocks
    // that back-fill, so the two are different runs.
    expect(canonicalizeCopyTreeOptions({})).not.toEqual(
      canonicalizeCopyTreeOptions({ exclude: [] })
    );
  });

  it("omits undefined-valued keys so they cannot split an otherwise identical run", () => {
    expect(canonicalizeCopyTreeOptions({ modified: undefined, filter: "a" })).toEqual(
      canonicalizeCopyTreeOptions({ filter: "a" })
    );
  });

  it("preserves scalar differences that change what gets copied", () => {
    const base = canonicalizeCopyTreeOptions({ format: "xml", modified: true, charLimit: 10 });
    expect(base).not.toEqual(
      canonicalizeCopyTreeOptions({ format: "json", modified: true, charLimit: 10 })
    );
    expect(base).not.toEqual(
      canonicalizeCopyTreeOptions({ format: "xml", modified: false, charLimit: 10 })
    );
    expect(base).not.toEqual(
      canonicalizeCopyTreeOptions({ format: "xml", modified: true, charLimit: 11 })
    );
  });

  it("does not treat filter and includePaths as interchangeable", () => {
    // They union into one selection set downstream, but only `filter` suppresses
    // the project-setting filter — so the two runtime shapes are not the same run.
    expect(canonicalizeCopyTreeOptions({ filter: ["src/**"] })).not.toEqual(
      canonicalizeCopyTreeOptions({ includePaths: ["src/**"] })
    );
  });

  it("does not mutate the caller's options", () => {
    const options = { scopePaths: ["z", "a"] };
    canonicalizeCopyTreeOptions(options);
    expect(options.scopePaths).toEqual(["z", "a"]);
  });

  it("returns an empty object for absent options", () => {
    expect(canonicalizeCopyTreeOptions(undefined)).toEqual({});
  });
});

describe("deriveCopyTreeRunName", () => {
  it("names an unnarrowed run for the whole context", () => {
    expect(deriveCopyTreeRunName(undefined)).toBe("Full context");
    expect(deriveCopyTreeRunName({})).toBe("Full context");
    expect(deriveCopyTreeRunName({ format: "json" })).toBe("Full context");
  });

  it("names a scoped run after the folder, not its path", () => {
    expect(deriveCopyTreeRunName({ scopePaths: ["src/panels/file-browser"] })).toBe("file-browser");
  });

  it("handles Windows separators in a scoped path", () => {
    expect(deriveCopyTreeRunName({ scopePaths: ["src\\panels\\terminal"] })).toBe("terminal");
  });

  it("counts the remainder when several paths are scoped", () => {
    expect(deriveCopyTreeRunName({ scopePaths: ["src/a", "src/b", "src/c"] })).toBe("a +2 more");
  });

  it("labels multiple paths identically regardless of the order they arrived in", () => {
    expect(deriveCopyTreeRunName({ scopePaths: ["src/b", "src/a"] })).toBe(
      deriveCopyTreeRunName({ scopePaths: ["src/a", "src/b"] })
    );
  });

  it("shows the filter string when only a pattern narrows the run", () => {
    expect(deriveCopyTreeRunName({ filter: "**/*.ts" })).toBe("**/*.ts");
  });

  it("names a git-filtered run for what it selects", () => {
    expect(deriveCopyTreeRunName({ modified: true })).toBe("Modified files");
    expect(deriveCopyTreeRunName({ changed: "develop" })).toBe("Changed since develop");
  });

  it("ignores modified:false, which narrows nothing", () => {
    expect(deriveCopyTreeRunName({ modified: false })).toBe("Full context");
  });

  it("prefers the concrete selection over the git filter when both are present", () => {
    expect(deriveCopyTreeRunName({ scopePaths: ["src/lib"], modified: true })).toBe("lib");
    expect(deriveCopyTreeRunName({ filter: "**/*.ts", modified: true })).toBe("**/*.ts");
  });

  it("falls through a scope path that has no basename", () => {
    expect(deriveCopyTreeRunName({ scopePaths: ["/"], modified: true })).toBe("Modified files");
  });

  it("bounds the derived name", () => {
    const name = deriveCopyTreeRunName({ filter: "x".repeat(500) });
    expect(name.length).toBeLessThanOrEqual(COPY_TREE_HISTORY_NAME_MAX_LENGTH);
  });
});

describe("resolveCopyTreeRunName", () => {
  it("prefers a supplied name over the derived one", () => {
    expect(resolveCopyTreeRunName("Release notes context", { modified: true })).toBe(
      "Release notes context"
    );
  });

  it("treats a blank supplied name as absent", () => {
    expect(resolveCopyTreeRunName("   ", { modified: true })).toBe("Modified files");
    expect(resolveCopyTreeRunName("", undefined)).toBe("Full context");
  });

  it("trims a supplied name", () => {
    expect(resolveCopyTreeRunName("  spaced  ", {})).toBe("spaced");
  });

  it("bounds a supplied name", () => {
    const name = resolveCopyTreeRunName("y".repeat(500), {});
    expect(name.length).toBeLessThanOrEqual(COPY_TREE_HISTORY_NAME_MAX_LENGTH);
  });
});

describe("sortCopyTreeHistory", () => {
  const record = (id: string, lastUsedAt: number): CopyTreeHistoryRecord => ({
    id,
    dedupeKey: id,
    name: id,
    options: {},
    source: "toolbar",
    worktreeId: "wt",
    stats: { fileCount: 1 },
    createdAt: 0,
    lastUsedAt,
    runCount: 1,
  });

  it("orders newest-first", () => {
    const sorted = sortCopyTreeHistory([record("a", 1), record("b", 3), record("c", 2)]);
    expect(sorted.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("keeps the incoming order of records that tie", () => {
    const sorted = sortCopyTreeHistory([record("a", 5), record("b", 5), record("c", 5)]);
    expect(sorted.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input", () => {
    const input = [record("a", 1), record("b", 2)];
    sortCopyTreeHistory(input);
    expect(input.map((r) => r.id)).toEqual(["a", "b"]);
  });
});
