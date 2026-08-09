import { describe, expect, it } from "vitest";
import fs from "fs/promises";
import path from "path";

const SRC_ROOT = path.resolve(__dirname, "../..");

async function collectSourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "__tests__") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Issue #11735 — `worktree.copyTree` fires a completion toast for every dispatch
 * source except `"context-menu"`, which it skips because `copyContextWithFeedback`
 * already opens an info toast and updates it in place. That makes the source
 * string a load-bearing contract rather than a label: a caller that passes
 * anything else gets two toasts for one copy, and nothing in the type system
 * says so — `source` is a plain `ActionSource`.
 */
describe("copyContextWithFeedback source contract", () => {
  it("is only ever called with the 'context-menu' source", async () => {
    const files = await collectSourceFiles(SRC_ROOT);
    const offenders: string[] = [];

    for (const file of files) {
      const source = await fs.readFile(file, "utf-8");
      if (!source.includes("copyContextWithFeedback(")) continue;

      // Skip the declaration itself; only call sites carry a source argument.
      for (const match of source.matchAll(/copyContextWithFeedback\(\s*([^)]*?)\)/gs)) {
        const args = match[1] ?? "";
        if (args.includes("worktreeId: string")) continue; // the definition
        if (!/["']context-menu["']/.test(args)) {
          offenders.push(`${path.relative(SRC_ROOT, file)}: ${match[0].slice(0, 80)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("finds the call sites it claims to be guarding", async () => {
    // Without this the assertion above passes vacuously if the helper is
    // renamed or the scan root drifts.
    const files = await collectSourceFiles(SRC_ROOT);
    let callSites = 0;
    for (const file of files) {
      const source = await fs.readFile(file, "utf-8");
      callSites += [...source.matchAll(/\bvoid copyContextWithFeedback\(/g)].length;
    }
    expect(callSites).toBeGreaterThan(0);
  });
});
