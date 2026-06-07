import { describe, it, expect } from "vitest";
import {
  parseRipgrepMatches,
  findEnclosingObjectRange,
  extractDescription,
  extractQuarantineEntry,
  computeThreshold,
  scanStaleQuarantines,
} from "./quarantine-scan-lib.mjs";

// Helper: build source from lines and return the 0-based index of the line
// containing `type: "quarantine"`.
function quarantineLineIndex(source) {
  const lines = source.split("\n");
  return lines.findIndex((l) => /type:\s*"quarantine"/.test(l));
}

describe("parseRipgrepMatches", () => {
  it("returns [] for empty or whitespace input", () => {
    expect(parseRipgrepMatches("")).toEqual([]);
    expect(parseRipgrepMatches("   \n  ")).toEqual([]);
  });

  it("extracts file path and 1-based line number from match events", () => {
    const raw = [
      JSON.stringify({ type: "begin", data: { path: { text: "/a.ts" } } }),
      JSON.stringify({ type: "match", data: { path: { text: "/a.ts" }, line_number: 12 } }),
      JSON.stringify({ type: "end" }),
    ].join("\n");
    expect(parseRipgrepMatches(raw)).toEqual([{ filePath: "/a.ts", lineNum: 12 }]);
  });

  it("deduplicates identical file+line matches", () => {
    const line = JSON.stringify({
      type: "match",
      data: { path: { text: "/a.ts" }, line_number: 5 },
    });
    expect(parseRipgrepMatches(`${line}\n${line}`)).toEqual([{ filePath: "/a.ts", lineNum: 5 }]);
  });

  it("ignores non-JSON and non-match lines", () => {
    const raw = ["not json", JSON.stringify({ type: "summary" })].join("\n");
    expect(parseRipgrepMatches(raw)).toEqual([]);
  });
});

describe("findEnclosingObjectRange", () => {
  it("returns the innermost object enclosing the anchor", () => {
    const src = `outer({\n  inner: { a: 1 },\n});`;
    const anchor = src.indexOf("a: 1");
    const range = findEnclosingObjectRange(src, anchor);
    expect(src.slice(range.start, range.end)).toBe("{ a: 1 }");
  });

  it("ignores braces inside string literals", () => {
    const src = `{\n  description: "has a } brace",\n  type: "quarantine",\n}`;
    const anchor = src.indexOf("type:");
    const range = findEnclosingObjectRange(src, anchor);
    // Must capture the whole object, not stop at the brace inside the string.
    expect(src.slice(range.start, range.end)).toContain('type: "quarantine"');
    expect(src.slice(range.start, range.end).endsWith("}")).toBe(true);
  });

  it("ignores braces inside comments", () => {
    const src = `{\n  // a stray } in a comment\n  type: "quarantine",\n}`;
    const anchor = src.indexOf("type:");
    const range = findEnclosingObjectRange(src, anchor);
    expect(src.slice(range.start, range.end).endsWith("}")).toBe(true);
  });

  it("returns null when the anchor is not inside an object", () => {
    const src = `const x = 1;\nconst y = 2;`;
    expect(findEnclosingObjectRange(src, src.indexOf("y"))).toBeNull();
  });
});

describe("extractDescription", () => {
  it("extracts a single-line double-quoted description", () => {
    expect(extractDescription(`{ type: "quarantine", description: "2026-01-01 boom" }`)).toBe(
      "2026-01-01 boom"
    );
  });

  it("extracts a description whose value starts on the next line", () => {
    const slice = `{\n  type: "quarantine",\n  description:\n    "2026-01-01 wrapped reason",\n}`;
    expect(extractDescription(slice)).toBe("2026-01-01 wrapped reason");
  });

  it("returns null when there is no description property", () => {
    expect(extractDescription(`{ type: "quarantine" }`)).toBeNull();
  });

  it("collapses escaped quotes and whitespace in the reason", () => {
    expect(extractDescription(`{ description: "2026-01-01 said \\"hi\\"   there" }`)).toBe(
      '2026-01-01 said "hi" there'
    );
  });

  it("ignores a description that only appears in a comment", () => {
    const slice = [
      "{",
      '  // description: "2099-01-01 commented out",',
      '  description: "2026-04-01 real one",',
      "}",
    ].join("\n");
    expect(extractDescription(slice)).toBe("2026-04-01 real one");
  });
});

describe("extractQuarantineEntry", () => {
  it("parses the runtime push form", () => {
    const src = [
      "test(() => {",
      "  test.info().annotations.push({",
      '    type: "quarantine",',
      '    description: "2026-05-27 webview instability causes crash",',
      "  });",
      "});",
    ].join("\n");
    expect(extractQuarantineEntry(src, quarantineLineIndex(src))).toEqual({
      date: "2026-05-27",
      reason: "webview instability causes crash",
    });
  });

  it("parses the static skip details form with a wrapped description", () => {
    const src = [
      "test(",
      '  "title",',
      "  {",
      "    annotation: {",
      '      type: "quarantine",',
      "      description:",
      '        "2026-05-27 Full test quarantined: OAuth redirect blocked",',
      "    },",
      "  },",
      "  async () => {},",
      ");",
    ].join("\n");
    expect(extractQuarantineEntry(src, quarantineLineIndex(src))).toEqual({
      date: "2026-05-27",
      reason: "Full test quarantined: OAuth redirect blocked",
    });
  });

  it("handles description appearing BEFORE type (order-independent)", () => {
    const src = [
      "test.info().annotations.push({",
      '  description: "2026-02-15 flaky under load",',
      '  type: "quarantine",',
      "});",
    ].join("\n");
    expect(extractQuarantineEntry(src, quarantineLineIndex(src))).toEqual({
      date: "2026-02-15",
      reason: "flaky under load",
    });
  });

  it("is not fooled by an unrelated ISO date on a nearby line", () => {
    const src = [
      'const launchedAt = "2099-12-31 not a quarantine date";',
      "test.info().annotations.push({",
      '  type: "quarantine",',
      '  description: "2026-03-03 real quarantine reason",',
      "});",
    ].join("\n");
    expect(extractQuarantineEntry(src, quarantineLineIndex(src))).toEqual({
      date: "2026-03-03",
      reason: "real quarantine reason",
    });
  });

  it("returns null when the description has no leading date", () => {
    const src = [
      "test.info().annotations.push({",
      '  type: "quarantine",',
      '  description: "no date here",',
      "});",
    ].join("\n");
    expect(extractQuarantineEntry(src, quarantineLineIndex(src))).toBeNull();
  });

  it("returns null when there is no description at all", () => {
    const src = ['test.info().annotations.push({ type: "quarantine" });'];
    expect(extractQuarantineEntry(src.join("\n"), 0)).toBeNull();
  });
});

describe("computeThreshold", () => {
  it("computes the date staleDays before now in UTC", () => {
    expect(computeThreshold(new Date("2026-06-06T13:37:00Z"), 30)).toBe("2026-05-07");
  });

  it("handles month boundaries", () => {
    expect(computeThreshold(new Date("2026-01-05T00:00:00Z"), 30)).toBe("2025-12-06");
  });

  it("returns today when staleDays is 0", () => {
    expect(computeThreshold(new Date("2026-06-06T13:37:00Z"), 0)).toBe("2026-06-06");
  });
});

describe("scanStaleQuarantines", () => {
  const root = "/repo";
  const now = new Date("2026-06-06T13:37:00Z"); // threshold = 2026-05-07

  function run(files, matches, opts = {}) {
    return scanStaleQuarantines({
      rootDir: root,
      matches,
      now,
      readFile: (p) => {
        if (!(p in files)) throw new Error(`ENOENT ${p}`);
        return files[p];
      },
      ...opts,
    });
  }

  it("groups stale annotations by repo-relative path", () => {
    const files = {
      "/repo/e2e/a.spec.ts": [
        "test.info().annotations.push({",
        '  type: "quarantine",',
        '  description: "2026-04-01 old and stale",',
        "});",
      ].join("\n"),
    };
    const { staleBySpec, thresholdStr } = run(files, [
      { filePath: "/repo/e2e/a.spec.ts", lineNum: 2 },
    ]);
    expect(thresholdStr).toBe("2026-05-07");
    expect(staleBySpec.get("e2e/a.spec.ts")).toEqual([
      { line: 2, date: "2026-04-01", reason: "old and stale" },
    ]);
  });

  it("excludes annotations newer than the threshold", () => {
    const files = {
      "/repo/e2e/fresh.spec.ts": [
        "test.info().annotations.push({",
        '  type: "quarantine",',
        '  description: "2026-05-27 recent, not stale",',
        "});",
      ].join("\n"),
    };
    const { staleBySpec } = run(files, [{ filePath: "/repo/e2e/fresh.spec.ts", lineNum: 2 }]);
    expect(staleBySpec.size).toBe(0);
  });

  it("treats a date exactly at the threshold as not stale", () => {
    const files = {
      "/repo/e2e/edge.spec.ts": [
        "test.info().annotations.push({",
        '  type: "quarantine",',
        '  description: "2026-05-07 exactly thirty days",',
        "});",
      ].join("\n"),
    };
    const { staleBySpec } = run(files, [{ filePath: "/repo/e2e/edge.spec.ts", lineNum: 2 }]);
    expect(staleBySpec.size).toBe(0);
  });

  it("records a warning and skips when a file cannot be read", () => {
    const { staleBySpec, warnings } = run({}, [{ filePath: "/repo/e2e/missing.ts", lineNum: 2 }]);
    expect(staleBySpec.size).toBe(0);
    expect(warnings.some((w) => w.includes("missing.ts"))).toBe(true);
  });

  it("records a warning when no dated description is found", () => {
    const files = {
      "/repo/e2e/bad.spec.ts": [
        "test.info().annotations.push({",
        '  type: "quarantine",',
        '  description: "no date",',
        "});",
      ].join("\n"),
    };
    const { staleBySpec, warnings } = run(files, [
      { filePath: "/repo/e2e/bad.spec.ts", lineNum: 2 },
    ]);
    expect(staleBySpec.size).toBe(0);
    expect(warnings.some((w) => w.includes("bad.spec.ts"))).toBe(true);
  });

  it("collects multiple stale annotations from the same file", () => {
    const files = {
      "/repo/e2e/multi.spec.ts": [
        "test.info().annotations.push({",
        '  type: "quarantine",',
        '  description: "2026-04-01 first",',
        "});",
        "test.info().annotations.push({",
        '  type: "quarantine",',
        '  description: "2026-04-02 second",',
        "});",
      ].join("\n"),
    };
    const { staleBySpec } = run(files, [
      { filePath: "/repo/e2e/multi.spec.ts", lineNum: 2 },
      { filePath: "/repo/e2e/multi.spec.ts", lineNum: 6 },
    ]);
    expect(staleBySpec.get("e2e/multi.spec.ts")).toEqual([
      { line: 2, date: "2026-04-01", reason: "first" },
      { line: 6, date: "2026-04-02", reason: "second" },
    ]);
  });

  it("keeps only the stale annotation when a file mixes stale and fresh", () => {
    const files = {
      "/repo/e2e/mixed.spec.ts": [
        "test.info().annotations.push({",
        '  type: "quarantine",',
        '  description: "2026-04-01 stale one",',
        "});",
        "test.info().annotations.push({",
        '  type: "quarantine",',
        '  description: "2026-05-27 fresh one",',
        "});",
      ].join("\n"),
    };
    const { staleBySpec } = run(files, [
      { filePath: "/repo/e2e/mixed.spec.ts", lineNum: 2 },
      { filePath: "/repo/e2e/mixed.spec.ts", lineNum: 6 },
    ]);
    expect(staleBySpec.get("e2e/mixed.spec.ts")).toEqual([
      { line: 2, date: "2026-04-01", reason: "stale one" },
    ]);
  });

  it("uses the absolute path as key when the file is outside rootDir", () => {
    const files = {
      "/other/e2e/x.spec.ts": [
        "test.info().annotations.push({",
        '  type: "quarantine",',
        '  description: "2026-04-01 elsewhere",',
        "});",
      ].join("\n"),
    };
    const { staleBySpec } = run(files, [{ filePath: "/other/e2e/x.spec.ts", lineNum: 2 }]);
    expect(staleBySpec.has("/other/e2e/x.spec.ts")).toBe(true);
  });

  it("falls back to a placeholder reason when only a date is present", () => {
    const files = {
      "/repo/e2e/dateonly.spec.ts": [
        "test.info().annotations.push({",
        '  type: "quarantine",',
        '  description: "2026-04-01",',
        "});",
      ].join("\n"),
    };
    const { staleBySpec } = run(files, [{ filePath: "/repo/e2e/dateonly.spec.ts", lineNum: 2 }]);
    expect(staleBySpec.get("e2e/dateonly.spec.ts")).toEqual([
      { line: 2, date: "2026-04-01", reason: "(no reason provided)" },
    ]);
  });
});
