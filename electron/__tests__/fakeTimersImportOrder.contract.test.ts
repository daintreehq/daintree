import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../..");

// Installing fake timers before an awaited dynamic `import()` in the same hook
// runs the module re-execution path against a frozen clock. Vitest 4 delegates
// `toFake` to @sinonjs/fake-timers, which fakes every timer-shaped global except
// `process.nextTick` — `setImmediate` included — so anything on the loader path
// that resolves through a timer stalls with nothing to advance it. On a cold or
// contended CI shard that burns the whole hook timeout; locally the module is
// warm and it passes, which is why #11661 only ever failed in CI.
//
// The fix is ordering: resolve every dynamic import first, then install the
// clock. This contract keeps the pattern from being copy-pasted back in.

const HOOKS = new Set(["beforeEach", "beforeAll", "afterEach", "afterAll"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-electron", "build", "release"]);

/** Mirrors the test-discovery roots in `vitest.config.ts`'s `include`. */
const TEST_ROOTS = [
  "electron",
  "src",
  "shared",
  "scripts",
  "plugins",
  "packages",
  "e2e/helpers/__tests__",
];

/**
 * Hooks that still install fake timers before an awaited dynamic import, keyed
 * by repo-relative path to the exact number of offending hooks in that file.
 *
 * `TerminalInstanceService.*` is NOT mechanical debt: that module builds an
 * eager top-level singleton whose `TerminalReflowController` arms a 3s
 * `setInterval` during construction, so the module must be imported with the
 * clock already faked or `advanceTimersByTime` cannot drive the heartbeat those
 * suites assert on. Reordering them needs a test-factory redesign, not a line
 * move.
 *
 * The rest are untriaged: each needs its own check for load-time timer
 * scheduling before the ordering can be flipped. Two carry extra traps:
 * `DiagnosticsCollector.adversarial` has no `afterEach` restoring real timers,
 * so a naive reorder leaves the next hook importing under the previous test's
 * frozen clock; `SoundService` also calls `resetModules()` + `import()` inside
 * test bodies, which this hook-scoped scan does not see.
 *
 * Counts, not identities: fixing one hook in a listed file while introducing
 * another in the same file keeps the count equal and would pass. Per-hook
 * identity needs a stable fingerprint (line numbers churn, titles repeat), so
 * this trades that residual gap for an allowlist that cannot silently rot.
 */
const KNOWN_VIOLATIONS = new Map<string, number>([
  // Load-time timer scheduling — ordering is load-bearing here.
  ["src/services/terminal/__tests__/TerminalInstanceService.adversarial.test.ts", 1],
  ["src/services/terminal/__tests__/TerminalInstanceService.attach.test.ts", 1],
  ["src/services/terminal/__tests__/TerminalInstanceService.batchResize.test.ts", 2],
  ["src/services/terminal/__tests__/TerminalInstanceService.installerCallSite.test.ts", 1],
  ["src/services/terminal/__tests__/TerminalInstanceService.postWake.test.ts", 1],
  ["src/services/terminal/__tests__/TerminalInstanceService.reflow.test.ts", 1],
  ["src/services/terminal/__tests__/TerminalInstanceService.resizePass.test.ts", 1],
  ["src/services/terminal/__tests__/TerminalInstanceService.resizeResult.test.ts", 1],
  ["src/services/terminal/__tests__/TerminalInstanceService.switchBackObligation.test.ts", 1],
  ["src/services/terminal/__tests__/TerminalInstanceService.tier.test.ts", 2],
  ["src/services/terminal/__tests__/TerminalInstanceService.webglVisibility.test.ts", 1],
  // Untriaged — mechanically movable pending a per-file load-time timer check.
  ["electron/services/__tests__/DevPreviewSessionService.adversarial.test.ts", 1],
  ["electron/services/__tests__/DevPreviewSessionService.crashLoopGuard.test.ts", 1],
  ["electron/services/__tests__/DiagnosticsCollector.adversarial.test.ts", 1],
  ["electron/services/__tests__/MainProcessWatchdogClient.test.ts", 1],
  ["electron/services/__tests__/SoundService.test.ts", 1],
  ["electron/window/__tests__/powerMonitor.test.ts", 1],
  ["electron/window/__tests__/windowFocusThrottle.test.ts", 1],
  ["electron/workspace-host/__tests__/WorkspaceService.forgeRemote.test.ts", 1],
  ["src/clients/__tests__/filesClient.test.ts", 1],
  ["src/clients/__tests__/projectClient.test.ts", 1],
  ["src/components/ui/__tests__/reentry-summary.test.tsx", 1],
  ["src/services/terminal/__tests__/TerminalRendererPolicy.test.ts", 2],
]);

interface Violation {
  file: string;
  hook: string;
  fakeTimersLine: number;
  importLine: number;
}

function collectTestFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectTestFiles(path.join(dir, entry.name), out);
    } else if (/\.(test|spec)\.(ts|tsx|js|jsx|mts|mjs)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

/** Walks `node`'s subtree without descending into nested function bodies. */
function walkOwnScope(node: ts.Node, visit: (node: ts.Node) => void): void {
  node.forEachChild((child) => {
    visit(child);
    if (isFunctionLike(child)) return;
    walkOwnScope(child, visit);
  });
}

/**
 * The LAST dynamic `import()` call inside `node`, by source position. Returning
 * the first would accept `await (import("./a"), vi.useFakeTimers(),
 * import("./b"))`, where the second import still runs frozen.
 */
function findLastDynamicImportCall(node: ts.Node, source: ts.SourceFile): ts.Node | undefined {
  let last: ts.Node | undefined;
  const visit = (inner: ts.Node): void => {
    if (ts.isCallExpression(inner) && inner.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (!last || inner.getStart(source) > last.getStart(source)) last = inner;
    }
    inner.forEachChild(visit);
  };
  visit(node);
  return last;
}

/** Matches `vi.useFakeTimers(...)` and `vi["useFakeTimers"](...)`. */
function isUseFakeTimersCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const { expression } = node;
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "useFakeTimers";
  }
  if (ts.isElementAccessExpression(expression)) {
    const arg = expression.argumentExpression;
    return ts.isStringLiteralLike(arg) && arg.text === "useFakeTimers";
  }
  return false;
}

function hookName(call: ts.CallExpression): string | undefined {
  const { expression } = call;
  if (ts.isIdentifier(expression) && HOOKS.has(expression.text)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && HOOKS.has(expression.name.text)) {
    return expression.name.text;
  }
  return undefined;
}

/**
 * Function-like declarations by name, so `beforeEach(setup)` resolves to
 * `setup`'s body. Scope-blind: every declaration sharing a name is kept, and
 * an ambiguous name is only reported when EVERY candidate offends, which holds
 * whichever one actually binds. Picking one would let a clean `setup` shadow an
 * offending one; reporting on any match would blame a hook whose real body is
 * fine.
 */
function collectNamedFunctions(source: ts.SourceFile): Map<string, ts.Node[]> {
  const named = new Map<string, ts.Node[]>();
  const add = (name: string, fn: ts.Node): void => {
    const existing = named.get(name);
    if (existing) existing.push(fn);
    else named.set(name, [fn]);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      add(node.name.text, node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      add(node.name.text, node.initializer);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return named;
}

function parse(relativePath: string, text: string): ts.SourceFile {
  // ScriptKind is derived from the file name, never forced: parsing a `.ts` file
  // as TSX turns every generic arrow (`vi.fn(<T>(x: T) => x)`) into malformed
  // JSX, and the resulting parse errors made whole suites invisible to the scan.
  return ts.createSourceFile(relativePath, text, ts.ScriptTarget.Latest, true);
}

export function findViolations(relativePath: string, text: string): Violation[] {
  const source = parse(relativePath, text);
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const namedFunctions = collectNamedFunctions(source);
  const violations: Violation[] = [];

  /** The offending pair in one hook body, if any. */
  const inspect = (hook: string, callback: ts.Node): Violation | undefined => {
    // First clock install vs LAST awaited import: a hook that imports, installs
    // the clock, then imports again still runs that second import frozen, so
    // pairing against the first import would miss it.
    let fakeTimers: ts.Node | undefined;
    let lastImport: ts.Node | undefined;
    walkOwnScope(callback, (inner) => {
      if (!fakeTimers && isUseFakeTimersCall(inner)) fakeTimers = inner;
      // A returned import is awaited by the runner just like an inline `await`.
      if (ts.isAwaitExpression(inner) || ts.isReturnStatement(inner)) {
        // Compare the import call itself, not the enclosing `await`, so
        // `await (vi.useFakeTimers(), import(...))` still orders correctly.
        const importCall = findLastDynamicImportCall(inner, source);
        if (
          importCall &&
          (!lastImport || importCall.getStart(source) > lastImport.getStart(source))
        ) {
          lastImport = importCall;
        }
      }
    });
    if (fakeTimers && lastImport && fakeTimers.getStart(source) < lastImport.getStart(source)) {
      return {
        file: relativePath,
        hook,
        fakeTimersLine: lineOf(fakeTimers),
        importLine: lineOf(lastImport),
      };
    }
    return undefined;
  };

  const visitAll = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const hook = hookName(node);
      const arg = node.arguments[0];
      if (hook && arg) {
        // At most ONE violation per hook call site: the allowlist counts hooks,
        // so reporting every same-named candidate would inflate a file's count.
        let found: Violation | undefined;
        if (isFunctionLike(arg)) {
          found = inspect(hook, arg);
        } else if (ts.isIdentifier(arg)) {
          const candidates = namedFunctions.get(arg.text) ?? [];
          const results = candidates.map((candidate) => inspect(hook, candidate));
          // Only certain when every candidate offends — see collectNamedFunctions.
          if (results.length > 0 && results.every(Boolean)) found = results[0];
        }
        if (found) violations.push(found);
      }
    }
    node.forEachChild(visitAll);
  };
  visitAll(source);

  return violations;
}

interface ScanResult {
  violations: Violation[];
  unparsed: string[];
}

/**
 * Syntax errors in a parsed file. `parseDiagnostics` is internal to the
 * compiler API, but the public route needs a full `Program`, which is far too
 * slow for a couple of thousand files when all this asks is "did it parse".
 */
export function parseErrorCount(relativePath: string, text: string): number {
  const internal = parse(relativePath, text) as unknown as {
    parseDiagnostics?: readonly unknown[];
  };
  return internal.parseDiagnostics?.length ?? 0;
}

function scanRepo(): ScanResult {
  const files = TEST_ROOTS.flatMap((root) => collectTestFiles(path.join(REPO_ROOT, root))).sort();
  const violations: Violation[] = [];
  const unparsed: string[] = [];

  for (const absolute of files) {
    const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
    const text = fs.readFileSync(absolute, "utf8");
    // A file this scan cannot parse is a file it cannot police.
    if (parseErrorCount(relative, text) > 0) {
      unparsed.push(relative);
      continue;
    }
    violations.push(...findViolations(relative, text));
  }

  return { violations, unparsed };
}

function describeViolation(v: Violation): string {
  return `${v.file}:${v.fakeTimersLine} [${v.hook}] installs fake timers before the awaited dynamic import at line ${v.importLine}`;
}

function countByFile(violations: Violation[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of violations) counts.set(v.file, (counts.get(v.file) ?? 0) + 1);
  return counts;
}

describe("fake timers must not precede an awaited dynamic import", () => {
  const { violations, unparsed } = scanRepo();

  it("parses every test file it scans", () => {
    expect(unparsed).toEqual([]);
  });

  it("reports no new offending hooks", () => {
    const counts = countByFile(violations);
    const unexpected = violations
      .filter((v) => (counts.get(v.file) ?? 0) > (KNOWN_VIOLATIONS.get(v.file) ?? 0))
      .map(describeViolation);

    expect(unexpected).toEqual([]);
  });

  it("keeps allowlist counts exact", () => {
    const counts = countByFile(violations);
    const stale: string[] = [];
    for (const [file, expected] of KNOWN_VIOLATIONS) {
      const actual = counts.get(file) ?? 0;
      if (actual !== expected) {
        stale.push(
          actual === 0
            ? `${file} is fixed — remove it from KNOWN_VIOLATIONS`
            : `${file} has ${actual} offending hook(s), allowlist says ${expected}`
        );
      }
    }

    expect(stale).toEqual([]);
  });

  it("keeps every PtyClient suite ordered correctly", () => {
    const offenders = violations.filter((v) => v.file.includes("PtyClient")).map(describeViolation);
    expect(offenders).toEqual([]);
  });
});

describe("detector", () => {
  const wrap = (body: string) => `import { beforeEach, vi } from "vitest";\n${body}\n`;

  // `parseErrorCount` reads an internal compiler field. If a TypeScript upgrade
  // renames it the optional chain would return 0 forever, silently turning the
  // "parses every test file" assertion into a no-op.
  it("still detects syntax errors through the internal parse diagnostics", () => {
    expect(parseErrorCount("broken.test.ts", "function ( {")).toBeGreaterThan(0);
    expect(parseErrorCount("fine.test.ts", "export const x = 1;\n")).toBe(0);
  });

  // A `.ts` file parsed as TSX reports errors on a generic arrow; the derived
  // ScriptKind must not.
  it("parses a generic arrow in .ts but flags it as JSX in .tsx", () => {
    const generic = "const id = <T>(value: T): T => value;\n";
    expect(parseErrorCount("fixture.test.ts", generic)).toBe(0);
    expect(parseErrorCount("fixture.test.tsx", generic)).toBeGreaterThan(0);
  });

  it("flags fake timers installed before an awaited dynamic import", () => {
    const found = findViolations(
      "fixture.test.ts",
      wrap(`beforeEach(async () => {
        vi.useFakeTimers();
        await import("./mod.js");
      });`)
    );
    expect(found).toHaveLength(1);
    expect(found[0].hook).toBe("beforeEach");
  });

  it("accepts fake timers installed after the awaited dynamic import", () => {
    const found = findViolations(
      "fixture.test.ts",
      wrap(`beforeEach(async () => {
        await import("./mod.js");
        vi.useFakeTimers();
      });`)
    );
    expect(found).toEqual([]);
  });

  it("flags a second awaited import that follows the clock install", () => {
    const found = findViolations(
      "fixture.test.ts",
      wrap(`beforeEach(async () => {
        await import("./first.js");
        vi.useFakeTimers();
        await import("./second.js");
      });`)
    );
    expect(found).toHaveLength(1);
    expect(found[0].importLine).toBeGreaterThan(found[0].fakeTimersLine);
  });

  // A `.ts` file parsed as TSX turns this generic arrow into malformed JSX and
  // the whole suite silently stops being scanned.
  it("scans a .ts file containing a generic arrow function", () => {
    const found = findViolations(
      "fixture.test.ts",
      wrap(`const send = vi.fn(<T>(value: T): T => value);
      beforeEach(async () => {
        vi.useFakeTimers();
        await import("./mod.js");
      });`)
    );
    expect(found).toHaveLength(1);
  });

  it("resolves a hook callback passed by identifier", () => {
    const found = findViolations(
      "fixture.test.ts",
      wrap(`async function setup() {
        vi.useFakeTimers();
        await import("./mod.js");
      }
      beforeEach(setup);`)
    );
    expect(found).toHaveLength(1);
  });

  // Ambiguous name, only one candidate offending: which one binds is unknown, so
  // blaming the hook would be a false positive.
  it("stays silent when only one same-named candidate offends", () => {
    const found = findViolations(
      "fixture.test.ts",
      wrap(`async function setup() {
        vi.useFakeTimers();
        await import("./mod.js");
      }
      describe("other", () => {
        async function setup() {
          await import("./mod.js");
          vi.useFakeTimers();
        }
        beforeEach(setup);
      });`)
    );
    expect(found).toEqual([]);
  });

  it("flags a dynamic import returned from a hook", () => {
    const found = findViolations(
      "fixture.test.ts",
      wrap(`beforeEach(() => {
        vi.useFakeTimers();
        return import("./mod.js");
      });`)
    );
    expect(found).toHaveLength(1);
  });

  // Two offending declarations resolve to one hook site; counting both would
  // inflate the per-file total the allowlist tracks.
  it("reports one violation per hook site when candidates both offend", () => {
    const found = findViolations(
      "fixture.test.ts",
      wrap(`async function setup() {
        vi.useFakeTimers();
        await import("./a.js");
      }
      describe("other", () => {
        async function setup() {
          vi.useFakeTimers();
          await import("./b.js");
        }
        beforeEach(setup);
      });`)
    );
    expect(found).toHaveLength(1);
  });

  it("flags a later import inside the same awaited expression", () => {
    const found = findViolations(
      "fixture.test.ts",
      wrap(`beforeEach(async () => {
        await (import("./a.js"), vi.useFakeTimers(), import("./b.js"));
      });`)
    );
    expect(found).toHaveLength(1);
  });

  it("sees through an import nested in a property access", () => {
    const found = findViolations(
      "fixture.test.ts",
      wrap(`beforeEach(async () => {
        vi.useFakeTimers();
        const fork = (await import("electron")).utilityProcess.fork;
      });`)
    );
    expect(found).toHaveLength(1);
  });

  it("matches an element-access fake-timers call", () => {
    const found = findViolations(
      "fixture.test.ts",
      wrap(`beforeEach(async () => {
        vi["useFakeTimers"]();
        await import("./mod.js");
      });`)
    );
    expect(found).toHaveLength(1);
  });

  // A text scanner would treat the `//` as starting a comment and miss the call
  // that follows on the next line.
  it("is not fooled by a comment marker inside a template literal", () => {
    const found = findViolations(
      "fixture.test.ts",
      wrap(`const snippet = \`https://example.com
        not code
      \`;
      beforeEach(async () => {
        vi.useFakeTimers();
        await import("./mod.js");
      });`)
    );
    expect(found).toHaveLength(1);
  });

  it("ignores calls that only look like a violation inside a template literal", () => {
    const found = findViolations(
      "fixture.test.ts",
      `const sample = \`beforeEach(async () => {
        vi.useFakeTimers();
        await import("./mod.js");
      });\`;\n`
    );
    expect(found).toEqual([]);
  });

  it("ignores fake timers installed inside a nested function", () => {
    const found = findViolations(
      "fixture.test.ts",
      wrap(`beforeEach(async () => {
        vi.doMock("electron", () => {
          vi.useFakeTimers();
          return {};
        });
        await import("./mod.js");
      });`)
    );
    expect(found).toEqual([]);
  });

  it("ignores a dynamic import that is not awaited", () => {
    const found = findViolations(
      "fixture.test.ts",
      wrap(`beforeEach(() => {
        vi.useFakeTimers();
        void import("./mod.js");
      });`)
    );
    expect(found).toEqual([]);
  });
});
