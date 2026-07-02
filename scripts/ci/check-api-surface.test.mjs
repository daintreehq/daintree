import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compactDiff,
  compareEntry,
  ensureSingleTrailingNewline,
  main,
  normalizeLineEndings,
  renderSnapshot,
  runCheck,
  runUpdate,
  writeEntry,
} from "./check-api-surface.mjs";

function makeLogger() {
  const out = [];
  const err = [];
  return {
    log: (m) => out.push(String(m)),
    error: (m) => err.push(String(m)),
    out,
    err,
    get all() {
      return [...out, ...err].join("\n");
    },
  };
}

// A pair of entries rooted in a temp dir. `dist` files are the "built"
// declarations; `snapshot` files are the committed reports.
function makeEntries(dir) {
  return [
    {
      name: ".",
      dist: path.join(dir, "dist/index.d.ts"),
      snapshot: path.join(dir, "api-report/index.d.ts"),
    },
    {
      name: "./react",
      dist: path.join(dir, "dist/react.d.ts"),
      snapshot: path.join(dir, "api-report/react.d.ts"),
    },
  ];
}

describe("normalizeLineEndings", () => {
  it("collapses CRLF and lone CR to LF", () => {
    expect(normalizeLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});

describe("ensureSingleTrailingNewline", () => {
  it("adds a trailing newline when missing", () => {
    expect(ensureSingleTrailingNewline("x")).toBe("x\n");
  });
  it("collapses multiple trailing newlines to one", () => {
    expect(ensureSingleTrailingNewline("x\n\n\n")).toBe("x\n");
  });
});

describe("renderSnapshot", () => {
  it("prepends the header and normalizes body line endings + trailing newline", () => {
    const rendered = renderSnapshot("export {};\r\n\r\n");
    expect(rendered.startsWith("// API surface snapshot for @daintreehq/plugin-sdk.\n")).toBe(true);
    expect(rendered).toContain("api-surface:update");
    expect(rendered).not.toContain("\r");
    expect(rendered.endsWith("export {};\n")).toBe(true);
  });

  it("renders identical output regardless of the input's line endings (no OS churn)", () => {
    const lf = renderSnapshot("interface A {}\nexport { A };\n");
    const crlf = renderSnapshot("interface A {}\r\nexport { A };\r\n");
    expect(crlf).toBe(lf);
  });
});

describe("compactDiff", () => {
  it("returns an empty string for identical snapshots", () => {
    expect(compactDiff("a\nb\nc", "a\nb\nc")).toBe("");
  });

  it("reports the first divergent line number and shows both sides", () => {
    const diff = compactDiff("a\nb\nc\n", "a\nB\nc\n");
    expect(diff).toContain("first divergence at line 2");
    expect(diff).toContain("- b");
    expect(diff).toContain("+ B");
  });
});

describe("compareEntry / writeEntry / runCheck / runUpdate", () => {
  let dir;
  let entries;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "api-surface-"));
    entries = makeEntries(dir);
    mkdirSync(path.join(dir, "dist"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("compareEntry reports missing-dist when the built declaration is absent", () => {
    expect(compareEntry(entries[0]).status).toBe("missing-dist");
  });

  it("compareEntry reports missing when the snapshot has never been generated", () => {
    writeFileSync(entries[0].dist, "interface A {}\n");
    expect(compareEntry(entries[0]).status).toBe("missing");
  });

  it("writeEntry creates the snapshot, and reports changed only when the surface moves", () => {
    writeFileSync(entries[0].dist, "interface A {}\n");
    const logger = makeLogger();
    expect(writeEntry(entries[0], { logger })).toBe(true); // first write
    expect(writeEntry(entries[0], { logger })).toBe(false); // idempotent second write

    // Move the surface → next write reports a change again.
    writeFileSync(entries[0].dist, "interface A { x: number }\n");
    expect(writeEntry(entries[0], { logger })).toBe(true);
  });

  it("compareEntry reports ok after a matching snapshot is written", () => {
    writeFileSync(entries[0].dist, "interface A {}\n");
    writeEntry(entries[0], { logger: makeLogger() });
    expect(compareEntry(entries[0]).status).toBe("ok");
  });

  it("compareEntry reports stale with a diff when the built surface diverges", () => {
    writeFileSync(entries[0].dist, "interface A {}\n");
    writeEntry(entries[0], { logger: makeLogger() });
    writeFileSync(entries[0].dist, "interface A { added: string }\n");
    const result = compareEntry(entries[0]);
    expect(result.status).toBe("stale");
    expect(result.diff).toContain("added");
  });

  it("a snapshot that differs only by line endings is still ok (no OS churn)", () => {
    writeFileSync(entries[0].dist, "interface A {}\n");
    writeEntry(entries[0], { logger: makeLogger() });
    // Rewrite the committed snapshot with CRLF endings — should still match.
    const crlf = readFileSync(entries[0].snapshot, "utf8").replace(/\n/g, "\r\n");
    writeFileSync(entries[0].snapshot, crlf);
    expect(compareEntry(entries[0]).status).toBe("ok");
  });

  it("runCheck passes (exit 0) when every entry matches", () => {
    for (const e of entries) {
      writeFileSync(e.dist, `interface ${e.name === "." ? "Main" : "React"} {}\n`);
      writeEntry(e, { logger: makeLogger() });
    }
    const logger = makeLogger();
    expect(runCheck(entries, { logger })).toBe(0);
    expect(logger.all).toContain("OK");
  });

  it("runCheck fails (exit 1) with a ::error annotation and the update command on drift", () => {
    writeFileSync(entries[0].dist, "interface A {}\n");
    writeEntry(entries[0], { logger: makeLogger() });
    writeFileSync(entries[0].dist, "interface A { drifted: true }\n");
    writeFileSync(entries[1].dist, "interface R {}\n");
    writeEntry(entries[1], { logger: makeLogger() });
    const logger = makeLogger();
    expect(runCheck(entries, { logger })).toBe(1);
    expect(logger.err.join("\n")).toContain("::error file=");
    expect(logger.err.join("\n")).toContain("npm run api-surface:update");
  });

  it("runCheck surfaces every failing entry, so one failure never masks another", () => {
    // Entry 0 is stale, entry 1 is missing entirely.
    writeFileSync(entries[0].dist, "interface A {}\n");
    writeEntry(entries[0], { logger: makeLogger() });
    writeFileSync(entries[0].dist, "interface A { drifted: true }\n");
    writeFileSync(entries[1].dist, "interface R {}\n"); // dist exists, snapshot never written
    const logger = makeLogger();
    expect(runCheck(entries, { logger })).toBe(1);
    const errText = logger.err.join("\n");
    expect(errText).toContain("index.d.ts"); // stale entry 0
    expect(errText).toContain("react.d.ts"); // missing entry 1
    expect(errText).toContain("2 issue(s)");
  });

  it("runUpdate writes all snapshots and returns 0", () => {
    for (const e of entries) writeFileSync(e.dist, `interface X_${e.name.length} {}\n`);
    const logger = makeLogger();
    expect(runUpdate(entries, { logger })).toBe(0);
    for (const e of entries) expect(compareEntry(e).status).toBe("ok");
  });
});

describe("main argument routing", () => {
  it("returns exit code 2 for an unknown argument", () => {
    const logger = makeLogger();
    expect(main(["--bogus"], { logger })).toBe(2);
    expect(logger.err.join("\n")).toContain("unknown argument");
  });
});
