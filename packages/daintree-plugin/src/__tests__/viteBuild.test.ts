import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveViteBin,
  findServerConfig,
  resolveVitePlan,
  spawnViteWatch,
} from "../lib/viteBuild.js";

const watcher = vi.hoisted(() => ({ then: vi.fn(), kill: vi.fn() }));
vi.mock("execa", () => ({ execa: vi.fn(() => watcher) }));

describe("viteBuild", () => {
  it("resolveViteBin throws a fix-it message when Vite isn't installed", () => {
    expect(() => resolveViteBin("/nonexistent/plugin/dir")).toThrow(/Couldn't find Vite/);
  });

  it("returns a live watcher without awaiting the long-running process", () => {
    const child = spawnViteWatch(process.cwd());
    expect(child).toBe(watcher);
    expect(watcher.then).not.toHaveBeenCalled();
    child.kill();
    expect(watcher.kill).toHaveBeenCalledOnce();
  });
});

describe("resolveVitePlan", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-viteplan-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("plans a single pass when there is no server config", async () => {
    const plan = resolveVitePlan(dir);
    expect(plan.dualConfig).toBe(false);
    expect(plan.oneShot).toHaveLength(1);
    expect(plan.watch).toHaveLength(1);
  });

  it("leaves output-clearing alone for a single-config project", async () => {
    // Nothing else writes to dist/, so rebuilds should keep sweeping stale
    // chunks — --no-emptyOutDir would make them accumulate for the session.
    expect(resolveVitePlan(dir).watch.flat()).not.toContain("--no-emptyOutDir");
  });

  // Every extension Vite 8 accepts for a config file; missing one silently
  // downgrades that project to a single-target plan.
  it.each([
    "vite.config.server.js",
    "vite.config.server.mjs",
    "vite.config.server.ts",
    "vite.config.server.cjs",
    "vite.config.server.mts",
    "vite.config.server.cts",
  ])("detects %s", async (name) => {
    await fs.writeFile(path.join(dir, name), "export default {};");
    expect(findServerConfig(dir)).toBe(name);
    expect(resolveVitePlan(dir).dualConfig).toBe(true);
  });

  it("resolves a bare filename so Vite reads it relative to the plugin dir", async () => {
    await fs.writeFile(path.join(dir, "vite.config.server.ts"), "export default {};");
    const serverArgs = resolveVitePlan(dir).oneShot[1];
    // The watcher runs with cwd set to the plugin dir, so an absolute path here
    // would still work but a path relative to the CLI's own cwd would not.
    expect(serverArgs[serverArgs.indexOf("--config") + 1]).toBe("vite.config.server.ts");
  });

  it("builds the default config before the server config", async () => {
    await fs.writeFile(path.join(dir, "vite.config.server.ts"), "export default {};");
    const [first, second] = resolveVitePlan(dir).oneShot;
    // The default pass is the one that legitimately empties dist/; running it
    // second would delete the server bundle it had just produced.
    expect(first).not.toContain("--config");
    expect(second).toContain("--config");
  });

  it("disables output-clearing on both watchers when two share a dist", async () => {
    await fs.writeFile(path.join(dir, "vite.config.server.ts"), "export default {};");
    const plan = resolveVitePlan(dir);
    expect(plan.watch).toHaveLength(2);
    for (const args of plan.watch) {
      expect(args).toContain("--no-emptyOutDir");
    }
  });

  it("keeps one-shot builds clearing output even in dual-config mode", async () => {
    await fs.writeFile(path.join(dir, "vite.config.server.ts"), "export default {};");
    // Sequential passes don't race, so a one-shot build should still start from
    // a clean dist/ — carrying --no-emptyOutDir here would leak stale output
    // into every package.
    expect(resolveVitePlan(dir).oneShot.flat()).not.toContain("--no-emptyOutDir");
  });
});
