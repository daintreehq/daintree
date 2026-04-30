import { describe, it, expect, vi } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

vi.mock("../../../store.js", () => ({
  store: { get: vi.fn().mockReturnValue({}), set: vi.fn() },
}));

vi.mock("../../../services/SoundService.js", () => ({
  soundService: { play: vi.fn() },
}));

vi.mock("../../../services/PreAgentSnapshotService.js", () => ({
  preAgentSnapshotService: {
    getSnapshot: vi.fn(),
    listSnapshots: vi.fn(),
    revertToSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(),
  },
}));

import { parsePorcelainV2Conflicts } from "../git-write.js";

describe("parsePorcelainV2Conflicts", () => {
  it("returns an empty list for empty input", () => {
    expect(parsePorcelainV2Conflicts("")).toEqual([]);
  });

  it("ignores non-u lines (headers, 1/2 entries)", () => {
    const input = [
      "# branch.oid abc123",
      "# branch.head main",
      "1 .M N... 100644 100644 100644 aaa bbb src/other.ts",
      "2 R. N... 100644 100644 100644 aaa bbb src/new.ts\tsrc/old.ts",
    ].join("\n");
    expect(parsePorcelainV2Conflicts(input)).toEqual([]);
  });

  it("parses a single both-modified unmerged entry", () => {
    const line = "u UU N... 100644 100644 100644 100644 aaa bbb ccc src/file.ts";
    const result = parsePorcelainV2Conflicts(line);
    expect(result).toEqual([{ path: "src/file.ts", xy: "UU", label: "both modified" }]);
  });

  it("maps all known XY codes to human labels", () => {
    const codes: Array<[string, string]> = [
      ["UU", "both modified"],
      ["AA", "both added"],
      ["DD", "both deleted"],
      ["AU", "added by us"],
      ["UA", "added by them"],
      ["DU", "deleted by us"],
      ["UD", "deleted by them"],
    ];
    const input = codes
      .map(([xy], i) => `u ${xy} N... 100644 100644 100644 100644 a b c path${i}.ts`)
      .join("\n");
    const result = parsePorcelainV2Conflicts(input);
    expect(result.map((r) => [r.xy, r.label])).toEqual(codes);
  });

  it("preserves unknown XY codes as the label fallback", () => {
    const line = "u ZZ N... 100644 100644 100644 100644 a b c weird.ts";
    const result = parsePorcelainV2Conflicts(line);
    expect(result).toEqual([{ path: "weird.ts", xy: "ZZ", label: "ZZ" }]);
  });

  it("handles filenames containing spaces", () => {
    const line = "u UU N... 100644 100644 100644 100644 a b c src/file with spaces.ts";
    const result = parsePorcelainV2Conflicts(line);
    expect(result).toEqual([{ path: "src/file with spaces.ts", xy: "UU", label: "both modified" }]);
  });

  it("skips malformed u lines with too few fields", () => {
    const lines = ["u UU short", "u UU N... 100644 100644 100644 100644 a b c ok.ts"].join("\n");
    const result = parsePorcelainV2Conflicts(lines);
    expect(result).toEqual([{ path: "ok.ts", xy: "UU", label: "both modified" }]);
  });

  it("passes literal UTF-8 paths through unchanged (core.quotepath=false)", () => {
    // With core.quotepath=false the path is emitted literally (bytes as UTF-8),
    // not C-quoted. Regression guard for the quoted-path issue surfaced in
    // review: ensure the parser preserves non-ASCII bytes verbatim.
    const line = "u UU N... 100644 100644 100644 100644 a b c src/café.txt";
    const result = parsePorcelainV2Conflicts(line);
    expect(result).toEqual([{ path: "src/café.txt", xy: "UU", label: "both modified" }]);
  });

  it("parses multiple entries across many lines", () => {
    const input = [
      "# branch.oid abc",
      "1 .M N... 100644 100644 100644 aaa bbb src/a.ts",
      "u UU N... 100644 100644 100644 100644 a b c src/b.ts",
      "u AA N... 100644 100644 100644 100644 a b c src/c.ts",
      "",
    ].join("\n");
    const result = parsePorcelainV2Conflicts(input);
    expect(result.map((r) => r.path)).toEqual(["src/b.ts", "src/c.ts"]);
  });
});
