import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import {
  resolveViteBin,
  findGuestConfig,
  findServerConfig,
  resolveVitePlan,
  runViteBuild,
  spawnViteWatch,
} from "../lib/viteBuild.js";

const watcher = vi.hoisted(() => ({ then: vi.fn(), kill: vi.fn() }));
vi.mock("execa", () => ({ execa: vi.fn(() => watcher) }));

describe("viteBuild", () => {
  it("resolveViteBin throws a fix-it message when Vite isn't installed", () => {
    expect(() => resolveViteBin("/nonexistent/plugin/dir")).toThrow(/Couldn't find Vite/);
  });

  describe("resolveViteBin lookup", () => {
    let root: string;
    const realPlatform = process.platform;

    const installVite = async (dir: string, binName = "vite") => {
      const bin = path.join(dir, "node_modules", ".bin", binName);
      await fs.mkdir(path.dirname(bin), { recursive: true });
      await fs.writeFile(bin, "");
      return bin;
    };
    const setPlatform = (value: NodeJS.Platform) =>
      Object.defineProperty(process, "platform", { value, configurable: true });

    beforeEach(async () => {
      // realpath: macOS tmpdir is a symlink, and resolveViteBin returns resolved paths.
      root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "daintree-vitebin-")));
    });

    afterEach(async () => {
      setPlatform(realPlatform);
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    });

    it("uses the plugin's own Vite for a standalone plugin", async () => {
      const plugin = path.join(root, "plugin");
      const bin = await installVite(plugin);
      expect(resolveViteBin(plugin)).toBe(bin);
    });

    it("finds a Vite hoisted to the workspace root", async () => {
      const bin = await installVite(root);
      const plugin = path.join(root, "packages", "my-plugin");
      await fs.mkdir(plugin, { recursive: true });
      expect(resolveViteBin(plugin)).toBe(bin);
    });

    it("prefers the plugin's own Vite over an ancestor's", async () => {
      await installVite(root);
      const plugin = path.join(root, "packages", "my-plugin");
      const own = await installVite(plugin);
      expect(resolveViteBin(plugin)).toBe(own);
    });

    it("takes the nearest ancestor when several have Vite", async () => {
      await installVite(root);
      const mid = path.join(root, "packages");
      const nearest = await installVite(mid);
      const plugin = path.join(mid, "my-plugin");
      await fs.mkdir(plugin, { recursive: true });
      expect(resolveViteBin(plugin)).toBe(nearest);
    });

    it("ignores a node_modules directory that has no Vite bin", async () => {
      const bin = await installVite(root);
      const plugin = path.join(root, "packages", "my-plugin");
      await fs.mkdir(path.join(plugin, "node_modules", ".bin"), { recursive: true });
      await fs.writeFile(path.join(plugin, "node_modules", ".bin", "tsc"), "");
      expect(resolveViteBin(plugin)).toBe(bin);
    });

    it("handles paths with spaces", async () => {
      const bin = await installVite(path.join(root, "my workspace"));
      const plugin = path.join(root, "my workspace", "packages", "my plugin");
      await fs.mkdir(plugin, { recursive: true });
      expect(resolveViteBin(plugin)).toBe(bin);
    });

    it("looks for the .cmd shim on Windows", async () => {
      setPlatform("win32");
      const bin = await installVite(root, "vite.cmd");
      await installVite(path.join(root, "packages", "my-plugin"), "vite");
      const plugin = path.join(root, "packages", "my-plugin");
      expect(resolveViteBin(plugin)).toBe(bin);
    });

    it("fails clearly, naming where it looked, when no ancestor has Vite", async () => {
      const plugin = path.join(root, "packages", "my-plugin");
      await fs.mkdir(plugin, { recursive: true });
      let message = "";
      try {
        resolveViteBin(plugin);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("Couldn't find Vite");
      expect(message).toContain(path.join(plugin, "node_modules", ".bin"));
      expect(message).toContain("any parent directory");
      expect(message).toContain("--skip-build");
    });

    it("runs the resolved bin with the plugin directory as cwd", async () => {
      const bin = await installVite(root);
      const plugin = path.join(root, "packages", "my plugin");
      await fs.mkdir(plugin, { recursive: true });
      vi.mocked(execa).mockReturnValueOnce(Promise.resolve({}) as never);
      await runViteBuild(plugin, ["build"]);
      expect(execa).toHaveBeenLastCalledWith(bin, ["build"], { cwd: plugin, stdio: "inherit" });
      spawnViteWatch(plugin);
      expect(execa).toHaveBeenLastCalledWith(bin, ["build", "--watch"], {
        cwd: plugin,
        stdio: "inherit",
      });
    });
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

  it("adds a guest pass after the default and server passes, none of them clearing another's output in watch", async () => {
    await fs.writeFile(path.join(dir, "vite.config.server.ts"), "export default {};");
    await fs.writeFile(path.join(dir, "vite.config.guest.ts"), "export default {};");
    expect(findGuestConfig(dir)).toBe("vite.config.guest.ts");
    const plan = resolveVitePlan(dir);
    expect(plan.dualConfig).toBe(true);
    expect(plan.oneShot).toEqual([
      ["build"],
      ["build", "--config", "vite.config.server.ts"],
      ["build", "--config", "vite.config.guest.ts"],
    ]);
    expect(plan.watch).toHaveLength(3);
    for (const args of plan.watch) expect(args).toContain("--no-emptyOutDir");
  });

  it("plans a guest pass for a plugin with no server config", async () => {
    await fs.writeFile(path.join(dir, "vite.config.guest.mjs"), "export default {};");
    expect(resolveVitePlan(dir).oneShot).toEqual([
      ["build"],
      ["build", "--config", "vite.config.guest.mjs"],
    ]);
  });
});
