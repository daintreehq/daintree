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

import { parsePorcelainV2Conflicts } from "../../../services/git/porcelainConflicts.js";

describe("parsePorcelainV2Conflicts", () => {
  const z = (...records: string[]) => records.map((r) => `${r}\0`).join("");

  it("returns an empty list for empty input", () => {
    expect(parsePorcelainV2Conflicts("")).toEqual([]);
  });

  it("ignores non-u records (headers, 1/2/?/! entries)", () => {
    const input = z(
      "# branch.oid abc123",
      "# branch.head main",
      "1 .M N... 100644 100644 100644 aaa bbb src/other.ts",
      "2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts",
      "src/old.ts",
      "? untracked.ts",
      "! ignored.ts"
    );
    expect(parsePorcelainV2Conflicts(input)).toEqual([]);
  });

  it("does not read a rename's original path as a record of its own", () => {
    const input = z(
      "2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts",
      "u UU N... 100644 100644 100644 100644 a b c looks-like-a-record.ts",
      "u AA N... 100644 100644 100644 100644 a b c src/real.ts"
    );
    expect(parsePorcelainV2Conflicts(input)).toEqual([
      { path: "src/real.ts", xy: "AA", label: "both added" },
    ]);
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
    const input = z(
      ...codes.map(([xy], i) => `u ${xy} N... 100644 100644 100644 100644 a b c path${i}.ts`)
    );
    const result = parsePorcelainV2Conflicts(input);
    expect(result.map((r) => [r.xy, r.label])).toEqual(codes);
  });

  it("preserves unknown XY codes as the label fallback", () => {
    const input = z("u ZZ N... 100644 100644 100644 100644 a b c weird.ts");
    const result = parsePorcelainV2Conflicts(input);
    expect(result).toEqual([{ path: "weird.ts", xy: "ZZ", label: "ZZ" }]);
  });

  it("handles filenames containing spaces", () => {
    const input = z("u UU N... 100644 100644 100644 100644 a b c src/file with  spaces .ts");
    const result = parsePorcelainV2Conflicts(input);
    expect(result).toEqual([
      { path: "src/file with  spaces .ts", xy: "UU", label: "both modified" },
    ]);
  });

  it("returns tab, quote, backslash and newline filenames verbatim", () => {
    const names = ["tab\tfile.txt", 'quote"file.txt', "back\\slash.txt", "new\nline.txt"];
    const input = z(...names.map((name) => `u UU N... 100644 100644 100644 100644 a b c ${name}`));
    expect(parsePorcelainV2Conflicts(input).map((r) => r.path)).toEqual(names);
  });

  it("skips malformed u records with too few fields", () => {
    const input = z("u UU short", "u UU N... 100644 100644 100644 100644 a b c ok.ts");
    const result = parsePorcelainV2Conflicts(input);
    expect(result).toEqual([{ path: "ok.ts", xy: "UU", label: "both modified" }]);
  });

  it("passes literal UTF-8 paths through unchanged", () => {
    const input = z("u UU N... 100644 100644 100644 100644 a b c src/café.txt");
    const result = parsePorcelainV2Conflicts(input);
    expect(result).toEqual([{ path: "src/café.txt", xy: "UU", label: "both modified" }]);
  });

  it("parses multiple entries across many records", () => {
    const input = z(
      "# branch.oid abc",
      "1 .M N... 100644 100644 100644 aaa bbb src/a.ts",
      "u UU N... 100644 100644 100644 100644 a b c src/b.ts",
      "u AA N... 100644 100644 100644 100644 a b c src/c.ts"
    );
    const result = parsePorcelainV2Conflicts(input);
    expect(result.map((r) => r.path)).toEqual(["src/b.ts", "src/c.ts"]);
  });
});
