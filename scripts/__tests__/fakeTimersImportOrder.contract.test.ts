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
//
// The allowlist is exact rather than permissive — an entry whose count no longer
// matches fails the test. A stale entry would otherwise silently re-permit a
// regression in a file that had already been fixed.

const HOOKS = new Set(["beforeEach", "beforeAll", "afterEach", "afterAll"]);
const TEST_ROOTS = ["electron", "src", "shared", "scripts", "plugins", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-electron", "build", "release"]);

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
 * The rest are untriaged: each one needs its own check for load-time timer
 * scheduling before the ordering can be flipped.
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

function containsDynamicImport(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    return true;
  let found = false;
  node.forEachChild((child) => {
    if (!found && containsDynamicImport(child)) found = true;
  });
  return found;
}

function isUseFakeTimersCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "useFakeTimers"
  );
}

function hookName(call: ts.CallExpression): string | undefined {
  const { expression } = call;
  if (ts.isIdentifier(expression) && HOOKS.has(expression.text)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && HOOKS.has(expression.name.text)) {
    return expression.name.text;
  }
  return undefined;
}

export function findViolations(relativePath: string, text: string): Violation[] {
  const source = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const lineOf = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const violations: Violation[] = [];

  const visitAll = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const hook = hookName(node);
      const callback = node.arguments[0];
      if (hook && callback && isFunctionLike(callback)) {
        let fakeTimers: ts.Node | undefined;
        let awaitedImport: ts.Node | undefined;
        walkOwnScope(callback, (inner) => {
          if (!fakeTimers && isUseFakeTimersCall(inner)) fakeTimers = inner;
          if (!awaitedImport && ts.isAwaitExpression(inner) && containsDynamicImport(inner)) {
            awaitedImport = inner;
          }
        });
        if (
          fakeTimers &&
          awaitedImport &&
          fakeTimers.getStart(source) < awaitedImport.getStart(source)
        ) {
          violations.push({
            file: relativePath,
            hook,
            fakeTimersLine: lineOf(fakeTimers),
            importLine: lineOf(awaitedImport),
          });
        }
      }
    }
    node.forEachChild(visitAll);
  };
  visitAll(source);

  return violations;
}

function scanRepo(): Violation[] {
  const files = TEST_ROOTS.flatMap((root) => collectTestFiles(path.join(REPO_ROOT, root)));
  return files.flatMap((absolute) =>
    findViolations(
      path.relative(REPO_ROOT, absolute).split(path.sep).join("/"),
      fs.readFileSync(absolute, "utf8")
    )
  );
}

function describeViolation(v: Violation): string {
  return `${v.file}:${v.fakeTimersLine} [${v.hook}] installs fake timers before the awaited dynamic import at :${v.importLine}`;
}

describe("fake timers must not precede an awaited dynamic import", () => {
  const violations = scanRepo();

  it("reports no new offending hooks", () => {
    const counts = new Map<string, number>();
    for (const v of violations) counts.set(v.file, (counts.get(v.file) ?? 0) + 1);

    const unexpected = violations
      .filter((v) => (counts.get(v.file) ?? 0) > (KNOWN_VIOLATIONS.get(v.file) ?? 0))
      .map(describeViolation);

    expect(unexpected).toEqual([]);
  });

  it("keeps the allowlist exact", () => {
    const counts = new Map<string, number>();
    for (const v of violations) counts.set(v.file, (counts.get(v.file) ?? 0) + 1);

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
