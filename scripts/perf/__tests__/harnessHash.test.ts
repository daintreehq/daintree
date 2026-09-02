import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { harnessHashInputs, hashHarnessSources } from "../lib/harnessHash";

/**
 * Does the harness hash identify the measuring instrument, and only that?
 *
 * Two runs of one scenario on one machine at one iteration count are not
 * comparable if the harness changed between them, and nothing else in a summary
 * file reveals it — every field a reader would check matches. The hash is the
 * evidence. It is only useful if it moves when the harness moves and stays put
 * when the harness merely produced output, which is what these assert.
 */

const dirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-harness-hash-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("harness hash", () => {
  it("is stable across calls on an unchanged tree", () => {
    const dir = fixture({ "run.ts": "export const a = 1;\n" });
    expect(hashHarnessSources(dir)).toBe(hashHarnessSources(dir));
  });

  it("moves when a source file changes", () => {
    const dir = fixture({ "run.ts": "export const a = 1;\n" });
    const before = hashHarnessSources(dir);
    fs.writeFileSync(path.join(dir, "run.ts"), "export const a = 2;\n");
    expect(hashHarnessSources(dir)).not.toBe(before);
  });

  it("moves when a file is renamed but its content is not", () => {
    // Path is hashed alongside content: a rename changes which scenario an id
    // resolves to, and a content-only digest would call the two trees identical.
    const a = fixture({ "one.ts": "export const a = 1;\n" });
    const b = fixture({ "two.ts": "export const a = 1;\n" });
    expect(hashHarnessSources(a)).not.toBe(hashHarnessSources(b));
  });

  it("ignores the outputs the harness itself writes", () => {
    // Without these exclusions every canonical run would report a different
    // harness from the run before it, because a run rewrites history and can
    // rewrite a baseline — and a hash that always differs says nothing.
    const dir = fixture({ "run.ts": "export const a = 1;\n" });
    const before = hashHarnessSources(dir);

    fs.mkdirSync(path.join(dir, "history"), { recursive: true });
    fs.writeFileSync(path.join(dir, "history", "smoke.host.json"), "{}");
    fs.mkdirSync(path.join(dir, "config"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config", "baseline.smoke.json"), "{}");

    expect(hashHarnessSources(dir)).toBe(before);
  });

  it("does include the reference values a run is read against", () => {
    // `budgets.json` is an input, not an output. A changed ceiling changes what
    // the run reports, so two runs across an edit to it are not comparable.
    const dir = fixture({ "run.ts": "export const a = 1;\n", "config/budgets.json": "{}" });
    const before = hashHarnessSources(dir);
    fs.writeFileSync(path.join(dir, "config", "budgets.json"), '{"defaultBudget":{}}');
    expect(hashHarnessSources(dir)).not.toBe(before);
  });

  it("folds in an override budgets file that lives outside the tree", () => {
    // `--budgets /tmp/a.json` and `--budgets /tmp/b.json` decide different
    // reference verdicts. Without this the two runs carry identical provenance,
    // so a comparison between them looks like a comparison of two code states.
    const dir = fixture({ "run.ts": "export const a = 1;\n" });
    const budgetsA = path.join(dir, "..", `perf-budgets-a-${process.pid}.json`);
    const budgetsB = path.join(dir, "..", `perf-budgets-b-${process.pid}.json`);
    fs.writeFileSync(budgetsA, '{"defaultBudget":{},"scenarios":{}}');
    fs.writeFileSync(budgetsB, '{"defaultBudget":{"maxRegressionPct":5},"scenarios":{}}');
    try {
      const bare = hashHarnessSources(dir);
      const withA = hashHarnessSources(dir, [budgetsA]);
      const withB = hashHarnessSources(dir, [budgetsB]);

      expect(withA).not.toBe(bare);
      expect(withB).not.toBe(withA);
      // Content, not path: a temp file's random name must not move the hash.
      const budgetsACopy = path.join(dir, "..", `perf-budgets-a-copy-${process.pid}.json`);
      fs.writeFileSync(budgetsACopy, '{"defaultBudget":{},"scenarios":{}}');
      try {
        expect(hashHarnessSources(dir, [budgetsACopy])).toBe(withA);
      } finally {
        fs.rmSync(budgetsACopy, { force: true });
      }
    } finally {
      fs.rmSync(budgetsA, { force: true });
      fs.rmSync(budgetsB, { force: true });
    }
  });

  it("returns null rather than throwing when an extra input is missing", () => {
    const dir = fixture({ "run.ts": "export const a = 1;\n" });
    expect(hashHarnessSources(dir, [path.join(dir, "nope.json")])).toBeNull();
  });

  it("returns null rather than throwing on a path that is not there", () => {
    // Provenance must never be a reason to fail a run.
    expect(hashHarnessSources(path.join(os.tmpdir(), "perf-harness-hash-absent"))).toBeNull();
  });

  it("reads the real harness and finds its own source", () => {
    const inputs = harnessHashInputs();
    expect(inputs).toContain("run.ts");
    expect(inputs).toContain("lib/harnessHash.ts");
    expect(inputs.some((file) => file.startsWith("history/"))).toBe(false);
    expect(inputs.some((file) => /baseline\.[a-z]+\.json$/.test(file))).toBe(false);
    expect(hashHarnessSources()).toMatch(/^[0-9a-f]{16}$/);
  });
});
