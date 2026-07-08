import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import {
  walkEagerGraph,
  scanSyncViolations,
  scanAllowlistMarkers,
  hasAllowlistMarker,
  compareToBaseline,
  formatBaseline,
  ALLOWLIST_MARKER_RE,
  SYNC_FS_RE,
  SYNC_STORE_RE,
  SYNC_SQLITE_RE,
} from "./import-budget-lib.mjs";

type Meta = {
  inputs: Record<
    string,
    {
      bytes?: number;
      imports: { path?: string; kind: string; external?: boolean }[];
    }
  >;
};

function meta(inputs: Meta["inputs"]): Meta {
  return { inputs };
}

describe("walkEagerGraph", () => {
  it("returns empty set when entry is not in metafile", () => {
    const result = walkEagerGraph(meta({}), "electron/main.ts");
    expect(result.size).toBe(0);
  });

  it("collects modules reachable via import-statement edges", () => {
    const result = walkEagerGraph(
      meta({
        "electron/main.ts": {
          imports: [
            { path: "electron/a.ts", kind: "import-statement" },
            { path: "electron/b.ts", kind: "import-statement" },
          ],
        },
        "electron/a.ts": {
          imports: [{ path: "electron/c.ts", kind: "import-statement" }],
        },
        "electron/b.ts": { imports: [] },
        "electron/c.ts": { imports: [] },
      }),
      "electron/main.ts"
    );
    expect([...result].sort()).toEqual([
      "electron/a.ts",
      "electron/b.ts",
      "electron/c.ts",
      "electron/main.ts",
    ]);
  });

  it("stops at dynamic-import boundaries", () => {
    const result = walkEagerGraph(
      meta({
        "electron/main.ts": {
          imports: [
            { path: "electron/eager.ts", kind: "import-statement" },
            { path: "electron/lazy.ts", kind: "dynamic-import" },
          ],
        },
        "electron/eager.ts": { imports: [] },
        "electron/lazy.ts": {
          imports: [{ path: "electron/deep-lazy.ts", kind: "import-statement" }],
        },
        "electron/deep-lazy.ts": { imports: [] },
      }),
      "electron/main.ts"
    );
    expect(result.has("electron/eager.ts")).toBe(true);
    expect(result.has("electron/lazy.ts")).toBe(false);
    expect(result.has("electron/deep-lazy.ts")).toBe(false);
  });

  it("skips external modules", () => {
    const result = walkEagerGraph(
      meta({
        "electron/main.ts": {
          imports: [
            { path: "electron", kind: "import-statement", external: true },
            { path: "better-sqlite3", kind: "import-statement", external: true },
            { path: "electron/local.ts", kind: "import-statement" },
          ],
        },
        "electron/local.ts": { imports: [] },
      }),
      "electron/main.ts"
    );
    expect(result.has("electron")).toBe(false);
    expect(result.has("better-sqlite3")).toBe(false);
    expect(result.has("electron/local.ts")).toBe(true);
  });

  it("handles cycles without infinite recursion", () => {
    const result = walkEagerGraph(
      meta({
        "electron/main.ts": {
          imports: [{ path: "electron/a.ts", kind: "import-statement" }],
        },
        "electron/a.ts": {
          imports: [{ path: "electron/b.ts", kind: "import-statement" }],
        },
        "electron/b.ts": {
          imports: [{ path: "electron/a.ts", kind: "import-statement" }],
        },
      }),
      "electron/main.ts"
    );
    expect(result.size).toBe(3);
  });

  it("follows require-call edges (for interop with cjs deps)", () => {
    const result = walkEagerGraph(
      meta({
        "electron/main.ts": {
          imports: [{ path: "electron/cjs-helper.cjs", kind: "require-call" }],
        },
        "electron/cjs-helper.cjs": { imports: [] },
      }),
      "electron/main.ts"
    );
    expect(result.has("electron/cjs-helper.cjs")).toBe(true);
  });
});

describe("scanSyncViolations", () => {
  const reader = (files: Record<string, string>) => (absPath: string) => {
    for (const [rel, body] of Object.entries(files)) {
      if (absPath.endsWith(rel)) return body;
    }
    throw new Error("not found");
  };

  it("reports readFileSync calls with line numbers", () => {
    const files = {
      "electron/a.ts":
        "import fs from 'node:fs';\nconst x = fs.readFileSync('/tmp/foo');\nexport const y = 1;\n",
    };
    const result = scanSyncViolations(["electron/a.ts"], "/root", reader(files));
    expect(result).toEqual([{ file: "electron/a.ts", line: 2, pattern: "sync-fs" }]);
  });

  it("reports store.get calls", () => {
    const files = {
      "electron/b.ts": "const win = store.get('lastWindow');\n",
    };
    const result = scanSyncViolations(["electron/b.ts"], "/root", reader(files));
    expect(result).toEqual([{ file: "electron/b.ts", line: 1, pattern: "sync-store-get" }]);
  });

  it("reports new Database() calls", () => {
    const files = {
      "electron/c.ts": "const db = new Database('/tmp/db.sqlite');\n",
    };
    const result = scanSyncViolations(["electron/c.ts"], "/root", reader(files));
    expect(result).toEqual([{ file: "electron/c.ts", line: 1, pattern: "sync-sqlite" }]);
  });

  it("skips node_modules paths", () => {
    const files = {
      "node_modules/pkg/index.js": "fs.readFileSync('/tmp/x');\n",
    };
    const result = scanSyncViolations(["node_modules/pkg/index.js"], "/root", reader(files));
    expect(result).toEqual([]);
  });

  it("skips non-source extensions", () => {
    const files = {
      "electron/data.json": "fs.readFileSync('/tmp/x');\n",
    };
    const result = scanSyncViolations(["electron/data.json"], "/root", reader(files));
    expect(result).toEqual([]);
  });

  it("returns results sorted by file then line", () => {
    const files = {
      "electron/b.ts": "const a = fs.readFileSync('/a');\nconst b = fs.statSync('/b');\n",
      "electron/a.ts": "const c = fs.existsSync('/c');\n",
    };
    const result = scanSyncViolations(["electron/b.ts", "electron/a.ts"], "/root", reader(files));
    expect(result.map((v) => `${v.file}:${v.line}`)).toEqual([
      "electron/a.ts:1",
      "electron/b.ts:1",
      "electron/b.ts:2",
    ]);
  });

  it("returns empty array when file can't be read", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = scanSyncViolations(["electron/missing.ts"], "/root", () => {
      throw new Error("ENOENT");
    });
    expect(result).toEqual([]);
    warnSpy.mockRestore();
  });

  it("returns violations for readable files even when sibling is unreadable", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const files = {
      "electron/readable.ts": "const a = fs.readFileSync('/x');\n",
    };
    const result = scanSyncViolations(
      ["electron/readable.ts", "electron/missing.ts"],
      "/root",
      (absPath: string) => {
        for (const [rel, body] of Object.entries(files)) {
          if (absPath.endsWith(rel)) return body;
        }
        throw new Error("ENOENT");
      }
    );
    expect(result).toEqual([{ file: "electron/readable.ts", line: 1, pattern: "sync-fs" }]);
    warnSpy.mockRestore();
  });
});

describe("sync regexes", () => {
  it("matches a range of sync fs calls", () => {
    const cases = [
      "fs.readFileSync(x)",
      "fs.writeFileSync(x, y)",
      "fs.openSync(x)",
      "fs.mkdirSync(x)",
      "fs.readdirSync(x)",
      "fs.statSync(x)",
      "fs.lstatSync(x)",
      "fs.existsSync(x)",
      "fs.unlinkSync(x)",
      "fs.renameSync(x, y)",
      "fs.rmSync(x)",
    ];
    for (const c of cases) {
      SYNC_FS_RE.lastIndex = 0;
      expect(SYNC_FS_RE.test(c), c).toBe(true);
    }
  });

  it("does not match non-sync fs calls", () => {
    SYNC_FS_RE.lastIndex = 0;
    expect(SYNC_FS_RE.test("fs.readFile(x)")).toBe(false);
    SYNC_FS_RE.lastIndex = 0;
    expect(SYNC_FS_RE.test("fs.promises.readFile(x)")).toBe(false);
  });

  it("matches store.get but not other accessors", () => {
    SYNC_STORE_RE.lastIndex = 0;
    expect(SYNC_STORE_RE.test("store.get('x')")).toBe(true);
    SYNC_STORE_RE.lastIndex = 0;
    expect(SYNC_STORE_RE.test("store.set('x', 1)")).toBe(false);
  });

  it("matches new Database() but not Database references", () => {
    SYNC_SQLITE_RE.lastIndex = 0;
    expect(SYNC_SQLITE_RE.test("const db = new Database('/tmp/db')")).toBe(true);
    SYNC_SQLITE_RE.lastIndex = 0;
    expect(SYNC_SQLITE_RE.test("type T = Database<unknown>")).toBe(false);
  });
});

describe("compareToBaseline", () => {
  const emptyBaseline = { count: 10, allowlist: [] as string[], syncViolations: [] as any[] };

  it("passes when count matches and no violations", () => {
    const r = compareToBaseline({ count: 10, moduleCount: 10, violations: [] }, emptyBaseline);
    expect(r.ok).toBe(true);
  });

  it("fails when count grows past baseline", () => {
    const r = compareToBaseline({ count: 11, moduleCount: 11, violations: [] }, emptyBaseline);
    expect(r.ok).toBe(false);
    expect(r.errors[0].kind).toBe("count-regression");
  });

  it("adds a notice when count shrinks", () => {
    const r = compareToBaseline({ count: 9, moduleCount: 9, violations: [] }, emptyBaseline);
    expect(r.ok).toBe(true);
    expect(r.notices.some((n) => n.kind === "count-improvement")).toBe(true);
  });

  it("fails when a new file has sync violations", () => {
    const r = compareToBaseline(
      {
        count: 10,
        moduleCount: 10,
        violations: [{ file: "electron/new.ts", line: 4, pattern: "sync-fs" }],
      },
      emptyBaseline
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0].kind).toBe("new-sync-violation");
    expect(r.errors[0].file).toBe("electron/new.ts");
  });

  it("passes when sync violations are on an allowlisted file", () => {
    const r = compareToBaseline(
      {
        count: 10,
        moduleCount: 10,
        violations: [
          {
            file: "electron/services/persistence/readLastProjectId.ts",
            line: 23,
            pattern: "sync-sqlite",
          },
        ],
      },
      {
        count: 10,
        allowlist: ["electron/services/persistence/readLastProjectId.ts"],
        syncViolations: [],
      }
    );
    expect(r.ok).toBe(true);
  });

  it("groups multiple violations in the same file into one error", () => {
    const r = compareToBaseline(
      {
        count: 10,
        moduleCount: 10,
        violations: [
          { file: "electron/new.ts", line: 4, pattern: "sync-fs" },
          { file: "electron/new.ts", line: 9, pattern: "sync-fs" },
          { file: "electron/new.ts", line: 14, pattern: "sync-store-get" },
        ],
      },
      emptyBaseline
    );
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].file).toBe("electron/new.ts");
    expect(r.errors[0].message).toMatch(/line 4/);
  });

  it("flags unused allowlist entries as an error", () => {
    const r = compareToBaseline(
      { count: 10, moduleCount: 10, violations: [] },
      { count: 10, allowlist: ["electron/old.ts"], syncViolations: [] }
    );
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e) => e.kind === "unused-allowlist" && e.file === "electron/old.ts")
    ).toBe(true);
    expect(r.notices.some((n) => n.kind === "unused-allowlist")).toBe(false);
  });

  it("skips the marker check when markedFiles is not provided", () => {
    const r = compareToBaseline(
      {
        count: 10,
        moduleCount: 10,
        violations: [{ file: "electron/a.ts", line: 1, pattern: "sync-fs" }],
      },
      { count: 10, allowlist: ["electron/a.ts"], syncViolations: [] }
    );
    expect(r.ok).toBe(true);
    expect(r.errors.some((e) => e.kind === "missing-allow-comment")).toBe(false);
  });

  it("passes when a used allowlisted file carries the allow comment", () => {
    const r = compareToBaseline(
      {
        count: 10,
        moduleCount: 10,
        violations: [{ file: "electron/a.ts", line: 1, pattern: "sync-fs" }],
      },
      { count: 10, allowlist: ["electron/a.ts"], syncViolations: [] },
      { markedFiles: new Set(["electron/a.ts"]) }
    );
    expect(r.ok).toBe(true);
    expect(r.errors.some((e) => e.kind === "missing-allow-comment")).toBe(false);
  });

  it("fails when a used allowlisted file lacks the allow comment", () => {
    const r = compareToBaseline(
      {
        count: 10,
        moduleCount: 10,
        violations: [{ file: "electron/a.ts", line: 1, pattern: "sync-fs" }],
      },
      { count: 10, allowlist: ["electron/a.ts"], syncViolations: [] },
      { markedFiles: new Set() }
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ kind: "missing-allow-comment", file: "electron/a.ts" });
  });

  it("stale allowlist entry emits only unused-allowlist, not missing-allow-comment", () => {
    const r = compareToBaseline(
      { count: 10, moduleCount: 10, violations: [] },
      { count: 10, allowlist: ["electron/stale.ts"], syncViolations: [] },
      { markedFiles: new Set() }
    );
    expect(r.errors.some((e) => e.kind === "unused-allowlist")).toBe(true);
    expect(r.errors.some((e) => e.kind === "missing-allow-comment")).toBe(false);
  });

  it("reports every allowlist-hygiene problem in one pass", () => {
    const r = compareToBaseline(
      {
        count: 10,
        moduleCount: 10,
        violations: [
          { file: "electron/marked.ts", line: 1, pattern: "sync-fs" },
          { file: "electron/unmarked.ts", line: 1, pattern: "sync-fs" },
          { file: "electron/new.ts", line: 2, pattern: "sync-fs" },
        ],
      },
      {
        count: 10,
        allowlist: ["electron/marked.ts", "electron/unmarked.ts", "electron/stale.ts"],
        syncViolations: [],
      },
      { markedFiles: new Set(["electron/marked.ts"]) }
    );
    expect(r.ok).toBe(false);
    expect(r.errors.filter((e) => e.kind === "new-sync-violation").map((e) => e.file)).toEqual([
      "electron/new.ts",
    ]);
    expect(r.errors.filter((e) => e.kind === "missing-allow-comment").map((e) => e.file)).toEqual([
      "electron/unmarked.ts",
    ]);
    expect(r.errors.filter((e) => e.kind === "unused-allowlist").map((e) => e.file)).toEqual([
      "electron/stale.ts",
    ]);
    // The marked, still-used entry produces no error.
    expect(r.errors.some((e) => e.file === "electron/marked.ts")).toBe(false);
  });

  it("ignores baseline.syncViolations — allowlist is the sole gate", () => {
    // A file that's in syncViolations but NOT in allowlist must still fail.
    // This pins the policy: the snapshot is informational, enforcement is
    // allowlist-only.
    const r = compareToBaseline(
      {
        count: 10,
        moduleCount: 10,
        violations: [{ file: "electron/sneaky.ts", line: 5, pattern: "sync-fs" }],
      },
      {
        count: 10,
        allowlist: [],
        syncViolations: [{ file: "electron/sneaky.ts", line: 5, pattern: "sync-fs" }],
      }
    );
    expect(r.ok).toBe(false);
    expect(r.errors[0].kind).toBe("new-sync-violation");
  });
});

describe("formatBaseline", () => {
  it("sorts allowlist and syncViolations deterministically", () => {
    const result = formatBaseline({
      count: 5,
      moduleCount: 5,
      allowlist: ["z.ts", "a.ts", "m.ts"],
      syncViolations: [
        { file: "z.ts", line: 10, pattern: "sync-fs" },
        { file: "a.ts", line: 3, pattern: "sync-store-get" },
        { file: "a.ts", line: 1, pattern: "sync-fs" },
      ],
    });
    expect(result.allowlist).toEqual(["a.ts", "m.ts", "z.ts"]);
    expect(result.syncViolations.map((v) => `${v.file}:${v.line}`)).toEqual([
      "a.ts:1",
      "a.ts:3",
      "z.ts:10",
    ]);
  });

  it("dedupes allowlist", () => {
    const result = formatBaseline({
      count: 1,
      moduleCount: 1,
      allowlist: ["a.ts", "a.ts", "b.ts"],
      syncViolations: [],
    });
    expect(result.allowlist).toEqual(["a.ts", "b.ts"]);
  });

  it("sorts violations by pattern when file and line match", () => {
    const result = formatBaseline({
      count: 1,
      moduleCount: 1,
      allowlist: [],
      syncViolations: [
        { file: "a.ts", line: 5, pattern: "sync-store-get" },
        { file: "a.ts", line: 5, pattern: "sync-fs" },
      ],
    });
    expect(result.syncViolations.map((v) => v.pattern)).toEqual(["sync-fs", "sync-store-get"]);
  });
});

describe("allowlist markers", () => {
  it("matches a valid marker with a reason", () => {
    expect(ALLOWLIST_MARKER_RE.test("// eager-import-allow: boot-critical sync")).toBe(true);
    expect(ALLOWLIST_MARKER_RE.test("  // eager-import-allow: indented reason")).toBe(true);
    expect(ALLOWLIST_MARKER_RE.test("//eager-import-allow:tight")).toBe(true);
  });

  it("rejects a marker with an empty reason", () => {
    expect(ALLOWLIST_MARKER_RE.test("// eager-import-allow:")).toBe(false);
    expect(ALLOWLIST_MARKER_RE.test("// eager-import-allow: ")).toBe(false);
  });

  it("rejects block-comment markers", () => {
    expect(ALLOWLIST_MARKER_RE.test("/* eager-import-allow: reason */")).toBe(false);
  });

  it("hasAllowlistMarker finds a marker among other header lines", () => {
    const source = "#!/usr/bin/env node\n// eager-import-allow: boot sync\nimport x from 'x';\n";
    expect(hasAllowlistMarker(source)).toBe(true);
  });

  it("scanAllowlistMarkers returns the set of files carrying a marker", () => {
    const reader = (absPath: string) =>
      absPath.endsWith("a.ts") ? "// eager-import-allow: reason\n" : "no marker here\n";
    const result = scanAllowlistMarkers(["electron/a.ts", "electron/b.ts"], "/root", reader);
    expect(result.has("electron/a.ts")).toBe(true);
    expect(result.has("electron/b.ts")).toBe(false);
  });

  it("scanAllowlistMarkers accepts a marker exactly on the last header line (20)", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `// line ${i + 1}`);
    lines[19] = "// eager-import-allow: just in time"; // 20th line (0-indexed 19)
    const result = scanAllowlistMarkers(["electron/a.ts"], "/root", () => lines.join("\n"));
    expect(result.has("electron/a.ts")).toBe(true);
  });

  it("scanAllowlistMarkers ignores a marker past the header window (line 21)", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `// line ${i + 1}`);
    lines[20] = "// eager-import-allow: too far down"; // 21st line (0-indexed 20)
    const result = scanAllowlistMarkers(["electron/a.ts"], "/root", () => lines.join("\n"));
    expect(result.has("electron/a.ts")).toBe(false);
  });

  it("scanAllowlistMarkers handles CRLF line endings", () => {
    const result = scanAllowlistMarkers(
      ["electron/a.ts"],
      "/root",
      () => "// eager-import-allow: reason\r\nimport x from 'x';\r\n"
    );
    expect(result.has("electron/a.ts")).toBe(true);
  });

  it("scanAllowlistMarkers warns and skips unreadable files", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = scanAllowlistMarkers(["electron/missing.ts"], "/root", () => {
      throw new Error("ENOENT");
    });
    expect(result.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("missing.ts"));
    warnSpy.mockRestore();
  });
});

describe("eager-import-baseline.json hygiene (live canary)", () => {
  // Catches baseline drift: any allowlisted file that loses its
  // `// eager-import-allow:` header (rename, file move, accidental deletion,
  // or a fresh `--update` that adds an unmarked entry) fails here.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const baseline = JSON.parse(
    readFileSync(path.join(root, "scripts", "baselines", "eager-import-baseline.json"), "utf8")
  );

  it("every allowlisted file carries the eager-import-allow header", () => {
    const marked = scanAllowlistMarkers(baseline.allowlist, root);
    const unmarked = baseline.allowlist.filter((file: string) => !marked.has(file));
    expect(unmarked).toEqual([]);
  });
});
