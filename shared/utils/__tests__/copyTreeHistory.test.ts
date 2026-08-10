import { describe, expect, it } from "vitest";
import {
  canonicalizeCopyTreeOptions,
  deriveCopyTreeRunName,
  resolveCopyTreeRunName,
  sortCopyTreeHistory,
} from "../copyTreeHistory.js";
import { COPY_TREE_HISTORY_NAME_MAX_LENGTH } from "../../types/ipc/copyTreeHistory.js";
import type { CopyTreeHistoryRecord } from "../../types/ipc/copyTreeHistory.js";
import type { CopyTreeOptions } from "../../types/ipc/copyTree.js";

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
    // ...and the ordering really was the only difference.
    expect(forwards).not.toEqual(canonicalizeCopyTreeOptions({ scopePaths: ["c", "d"] }));
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

  it("treats filter and includePaths as one selection set", () => {
    // CopyTreeService.mergeSelectionPatterns unions them into the SDK's single
    // `filter`, and mergeCopyTreeOptions back-fills neither from project
    // settings — so the two spellings request the identical run and must not
    // occupy two history rows.
    expect(canonicalizeCopyTreeOptions({ filter: ["src/**"] })).toEqual(
      canonicalizeCopyTreeOptions({ includePaths: ["src/**"] })
    );
    expect(canonicalizeCopyTreeOptions({ filter: "a", includePaths: ["b"] })).toEqual(
      canonicalizeCopyTreeOptions({ filter: ["b", "a"] })
    );
  });

  it("still separates a selection from no selection at all", () => {
    expect(canonicalizeCopyTreeOptions({ filter: ["src/**"] })).not.toEqual(
      canonicalizeCopyTreeOptions({})
    );
  });

  it("does not mutate the caller's options", () => {
    const options = { scopePaths: ["z", "a"] };
    canonicalizeCopyTreeOptions(options);
    expect(options.scopePaths).toEqual(["z", "a"]);
  });

  it("treats absent options the same as empty ones", () => {
    expect(canonicalizeCopyTreeOptions(undefined)).toEqual(canonicalizeCopyTreeOptions({}));
  });

  it("keeps the folded selection in its own namespace", () => {
    // A future real `CopyTreeOptions.selection` field must not land in the same
    // slot as today's folded filter/includePaths, or the two would collide.
    const folded = canonicalizeCopyTreeOptions({ filter: ["a"] });
    const strayField = canonicalizeCopyTreeOptions({
      selection: ["a"],
    } as unknown as CopyTreeOptions);
    expect(folded).not.toEqual(strayField);
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

  it("bounds the derived name and keeps its prefix", () => {
    const name = deriveCopyTreeRunName({ filter: `${"x".repeat(500)}yz` });
    expect(name.length).toBeLessThanOrEqual(COPY_TREE_HISTORY_NAME_MAX_LENGTH);
    expect(name.startsWith("xxx")).toBe(true);
    expect(name.endsWith("…")).toBe(true);
  });

  it("leaves a name exactly at the limit untouched", () => {
    const exact = "x".repeat(COPY_TREE_HISTORY_NAME_MAX_LENGTH);
    expect(deriveCopyTreeRunName({ filter: exact })).toBe(exact);
    expect(deriveCopyTreeRunName({ filter: `${exact}y` })).not.toBe(`${exact}y`);
  });

  it("never truncates through a surrogate pair", () => {
    // A lone high surrogate renders as a replacement glyph and breaks equality
    // against the same name derived elsewhere.
    for (let pad = 0; pad < 6; pad++) {
      const name = deriveCopyTreeRunName({
        filter: `${"x".repeat(COPY_TREE_HISTORY_NAME_MAX_LENGTH - 4 + pad)}${"🌳".repeat(6)}`,
      });
      expect(name.length).toBeLessThanOrEqual(COPY_TREE_HISTORY_NAME_MAX_LENGTH);
      for (const char of name) {
        const code = char.codePointAt(0) as number;
        expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
      }
    }
  });

  it("names a picker selection after the chosen file", () => {
    expect(deriveCopyTreeRunName({ includePaths: ["src/lib/utils.ts"] })).toBe("utils.ts");
    expect(deriveCopyTreeRunName({ includePaths: ["src/a.ts", "src/b.ts"] })).toBe("a.ts +1 more");
  });

  it("prefers a scoped folder over a picker selection", () => {
    expect(deriveCopyTreeRunName({ scopePaths: ["src/panels"], includePaths: ["a.ts"] })).toBe(
      "panels"
    );
  });

  it("falls through a whitespace-only filter rather than labelling a run with blanks", () => {
    expect(deriveCopyTreeRunName({ filter: "   ", modified: true })).toBe("Modified files");
    expect(deriveCopyTreeRunName({ filter: ["  ", "\t"] })).toBe("Full context");
  });

  it("trims a filter used as the label", () => {
    expect(deriveCopyTreeRunName({ filter: "  **/*.ts  " })).toBe("**/*.ts");
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

  // The derived branch already pins both boundaries above. The supplied branch
  // needs its own: the two only share `truncateName` by construction, so a
  // change to either could regress this one while the derived tests stay green
  // — and this is the branch every named MCP run takes (#11734).
  it("leaves a supplied name of exactly the limit untouched", () => {
    const exact = "y".repeat(COPY_TREE_HISTORY_NAME_MAX_LENGTH);
    const name = resolveCopyTreeRunName(exact, {});
    expect(name).toBe(exact);
    expect(name).not.toContain("…");
  });

  it("never splits a surrogate pair when bounding a supplied name", () => {
    // Slide the emoji across the boundary so one offset lands mid-pair; a plain
    // `slice` persists a lone surrogate, which renders as a replacement glyph
    // and stops comparing equal to the same name resolved elsewhere.
    //
    // Checked by code point rather than by round-tripping the string: spreading
    // yields a lone surrogate as its own element, so `[...name].join("")` equals
    // `name` for EVERY input and would assert nothing.
    for (let pad = 0; pad < 6; pad++) {
      const supplied = `${"y".repeat(COPY_TREE_HISTORY_NAME_MAX_LENGTH - 4 + pad)}${"🌳".repeat(6)}`;
      const name = resolveCopyTreeRunName(supplied, {});
      expect(name.length).toBeLessThanOrEqual(COPY_TREE_HISTORY_NAME_MAX_LENGTH);
      for (const char of name) {
        const code = char.codePointAt(0) as number;
        expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
      }
    }
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
