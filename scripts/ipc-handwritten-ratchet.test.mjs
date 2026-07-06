import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { countHandWrittenEntries, checkShrinkageGuard } from "./ipc-handwritten-ratchet.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const MAPS_FILE = join(REPO_ROOT, "shared", "types", "ipc", "maps.ts");
const BASELINE_FILE = join(REPO_ROOT, "scripts", "baselines", "ipc-handwritten-baseline.json");

const HEADER = "export interface IpcInvokeMap extends GeneratedIpcInvokeMap {";

function buildMaps(body) {
  return `import type { GeneratedIpcInvokeMap } from "./generated.js";\n\n${HEADER}\n${body}\n}\n\nexport interface IpcEventMap {\n  "other:event": { x: number };\n}\n`;
}

describe("countHandWrittenEntries", () => {
  it("returns 0 for an empty interface body", () => {
    expect(countHandWrittenEntries(buildMaps(""))).toBe(0);
  });

  it("counts a single entry", () => {
    const body = `  "worktree:get-all": {\n    args: [];\n    result: void;\n  };`;
    expect(countHandWrittenEntries(buildMaps(body))).toBe(1);
  });

  it("counts each multi-line entry exactly once", () => {
    const body = [
      `  "a:one": {`,
      `    args: [];`,
      `    result: void;`,
      `  };`,
      `  "b:two": {`,
      `    args: [payload: { rootPath: string }];`,
      `    result: string;`,
      `  };`,
      `  "c:three": {`,
      `    args: [];`,
      `    result: { value: number };`,
      `  };`,
    ].join("\n");
    expect(countHandWrittenEntries(buildMaps(body))).toBe(3);
  });

  it("ignores nested object braces inside entries", () => {
    const body = [
      `  "nested:one": {`,
      `    args: [payload: { a: string; b: number }];`,
      `    result: { ok: boolean; data: { id: string } };`,
      `  };`,
    ].join("\n");
    expect(countHandWrittenEntries(buildMaps(body))).toBe(1);
  });

  it("counts channels that contain colons in the name", () => {
    const body = [`  "a:b:c": {`, `    args: [];`, `    result: void;`, `  };`].join("\n");
    expect(countHandWrittenEntries(buildMaps(body))).toBe(1);
  });

  it("ignores entries from neighbouring interfaces", () => {
    const body = `  "real:entry": {\n    args: [];\n    result: void;\n  };`;
    const source = buildMaps(body) + `\nexport interface Other {\n  "fake:entry": { x: 1 };\n}\n`;
    expect(countHandWrittenEntries(source)).toBe(1);
  });

  it("ignores comment-only and blank lines", () => {
    const body = [
      `  // Worktree channels`,
      ``,
      `  "worktree:get-all": {`,
      `    args: [];`,
      `    result: void;`,
      `  };`,
    ].join("\n");
    expect(countHandWrittenEntries(buildMaps(body))).toBe(1);
  });

  it("requires the strict 2-space indent and quoted key shape", () => {
    const body = [
      `  "good:entry": {`,
      `    args: [];`,
      `    result: void;`,
      `  };`,
      `    "extra-indent": { args: []; result: void };`,
      `  badEntry: { args: []; result: void };`,
    ].join("\n");
    expect(countHandWrittenEntries(buildMaps(body))).toBe(1);
  });

  it("throws when the interface marker is missing", () => {
    expect(() => countHandWrittenEntries("// no interface here\n")).toThrow(
      /Could not find IpcInvokeMap interface marker/
    );
  });

  it("throws when the closing brace is missing", () => {
    const source = `${HEADER}\n  "a:one": {\n    args: [];\n    result: void;\n  };\n`;
    expect(() => countHandWrittenEntries(source)).toThrow(/Could not find closing/);
  });

  it("throws when the marker is split across multiple lines (strict single-line match)", () => {
    const source = `export interface IpcInvokeMap\n  extends GeneratedIpcInvokeMap {\n  "a:one": { args: []; result: void };\n}\n`;
    expect(() => countHandWrittenEntries(source)).toThrow(
      /Could not find IpcInvokeMap interface marker/
    );
  });

  it("matches the committed baseline against the real shared/types/ipc/maps.ts", () => {
    const source = readFileSync(MAPS_FILE, "utf-8");
    const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf-8"));
    expect(countHandWrittenEntries(source)).toBe(baseline.count);
  });
});

describe("checkShrinkageGuard", () => {
  it("passes when count stays the same", () => {
    expect(checkShrinkageGuard(100, 100, false).blocked).toBe(false);
  });

  it("passes when count increases", () => {
    expect(checkShrinkageGuard(100, 110, false).blocked).toBe(false);
  });

  it("passes when count decreases by exactly 10%", () => {
    expect(checkShrinkageGuard(100, 90, false).blocked).toBe(false);
  });

  it("passes when count decreases by less than 10%", () => {
    expect(checkShrinkageGuard(100, 91, false).blocked).toBe(false);
  });

  it("blocks when count decreases by more than 10%", () => {
    const result = checkShrinkageGuard(100, 89, false);
    expect(result.blocked).toBe(true);
    expect(result.message).toContain("11.0% shrinkage");
    expect(result.message).toContain("10% threshold");
    expect(result.message).toContain("hand-written IpcInvokeMap entries");
  });

  it("blocks large drops with the right percentage in the message", () => {
    const result = checkShrinkageGuard(200, 100, false);
    expect(result.blocked).toBe(true);
    expect(result.message).toContain("50.0% shrinkage");
  });

  it("bypasses the guard when --force is true", () => {
    expect(checkShrinkageGuard(100, 0, true).blocked).toBe(false);
  });

  it("skips the guard when priorCount is 0", () => {
    expect(checkShrinkageGuard(0, 5, false).blocked).toBe(false);
  });

  it("skips the guard when priorCount is NaN", () => {
    expect(checkShrinkageGuard(NaN, 50, false).blocked).toBe(false);
  });

  it("skips the guard when priorCount is Infinity", () => {
    expect(checkShrinkageGuard(Infinity, 50, false).blocked).toBe(false);
  });

  it("honors a custom threshold", () => {
    const result = checkShrinkageGuard(100, 70, false, 0.5);
    expect(result.blocked).toBe(false);
  });

  it("blocks at small absolute drops when the percentage exceeds the threshold", () => {
    const result = checkShrinkageGuard(10, 8, false);
    expect(result.blocked).toBe(true);
    expect(result.message).toContain("20.0% shrinkage");
  });
});
