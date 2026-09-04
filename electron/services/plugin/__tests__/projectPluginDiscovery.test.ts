import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { discoverProjectPlugins } from "../projectPluginDiscovery.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  // Cleaned in afterEach, never in a process-exit hook: a vitest fork is torn
  // down with SIGTERM and `process.on("exit")` never runs there.
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-project-plugins-"));
  tmpDirs.push(dir);
  // Realpath: macOS tmpdir is a symlink (/var → /private/var), and the
  // containment check compares realpaths.
  return fs.realpath(dir);
}

function manifest(name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name,
    version: "1.0.0",
    scope: "project",
    ...extra,
  });
}

async function writePlugin(
  projectRoot: string,
  dirName: string,
  contents: string | null,
  extraFiles: Record<string, string> = {}
): Promise<string> {
  const dir = path.join(projectRoot, ".daintree", "plugins", dirName);
  await fs.mkdir(dir, { recursive: true });
  if (contents !== null) await fs.writeFile(path.join(dir, "plugin.json"), contents);
  for (const [rel, body] of Object.entries(extraFiles)) {
    const target = path.join(dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  }
  return dir;
}

describe("discoverProjectPlugins", () => {
  it("returns nothing for a project with no .daintree/plugins folder", async () => {
    const root = await makeProject();
    const result = await discoverProjectPlugins(root);
    expect(result.root).toBe(null);
    expect(result.plugins).toEqual([]);
  });

  it("returns nothing for a project root that does not exist", async () => {
    const result = await discoverProjectPlugins(path.join(os.tmpdir(), "daintree-nope-9999"));
    expect(result.root).toBe(null);
    expect(result.plugins).toEqual([]);
  });

  it("parses a valid project manifest", async () => {
    const root = await makeProject();
    await writePlugin(root, "dashboard", manifest("acme.dashboard", { displayName: "Board" }));

    const result = await discoverProjectPlugins(root);
    expect(result.root).toBe(path.join(root, ".daintree", "plugins"));
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]!.manifest?.name).toBe("acme.dashboard");
    expect(result.plugins[0]!.manifest?.displayName).toBe("Board");
    expect(result.plugins[0]!.dirName).toBe("dashboard");
  });

  it("does NOT require the directory name to equal the manifest name", async () => {
    const root = await makeProject();
    // The shipping builtin `plugins/builtin/github` declares `daintree.github`,
    // so the rule is not enforced anywhere today and must not appear here.
    await writePlugin(root, "some-folder", manifest("acme.dashboard"));

    const result = await discoverProjectPlugins(root);
    expect(result.plugins[0]!.manifest?.name).toBe("acme.dashboard");
    expect(result.plugins[0]!.error).toBeUndefined();
  });

  it("rejects a manifest without scope: project", async () => {
    const root = await makeProject();
    await writePlugin(
      root,
      "dashboard",
      JSON.stringify({ name: "acme.dashboard", version: "1.0.0" })
    );

    const result = await discoverProjectPlugins(root);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]!.manifest).toBeUndefined();
    expect(result.plugins[0]!.error).toBeTruthy();
  });

  it("rejects the reserved daintree.* namespace", async () => {
    const root = await makeProject();
    await writePlugin(root, "gh", manifest("daintree.github"));

    const result = await discoverProjectPlugins(root);
    expect(result.plugins[0]!.manifest).toBeUndefined();
    expect(result.plugins[0]!.error).toBeTruthy();
  });

  it("points a singular field name at the plural one the schema has (#12212)", async () => {
    const root = await makeProject();
    // The real manifest that cost a debugging session: `author`, not `authors`.
    await writePlugin(root, "dashboard", manifest("acme.dashboard", { author: "Acme" }));

    const result = await discoverProjectPlugins(root);
    expect(result.plugins[0]!.manifest).toBeUndefined();
    expect(result.plugins[0]!.error).toContain("author");
    expect(result.plugins[0]!.error).toContain('did you mean "authors"');
  });

  it("names the unrecognized key even when nothing is close enough to suggest", async () => {
    const root = await makeProject();
    await writePlugin(root, "dashboard", manifest("acme.dashboard", { wibble: 1 }));

    const result = await discoverProjectPlugins(root);
    expect(result.plugins[0]!.error).toContain("wibble");
    expect(result.plugins[0]!.error).not.toContain("did you mean");
  });

  it("still reports the ordinary first issue when every key is recognized", async () => {
    const root = await makeProject();
    await writePlugin(
      root,
      "dashboard",
      JSON.stringify({ name: "acme.dashboard", version: "not-semver", scope: "project" })
    );

    const result = await discoverProjectPlugins(root);
    expect(result.plugins[0]!.error).toMatch(/^version: /);
  });

  it("reports malformed JSON as an invalid row rather than throwing", async () => {
    const root = await makeProject();
    await writePlugin(root, "broken", "{ not json");

    const result = await discoverProjectPlugins(root);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]!.error).toMatch(/not valid JSON/);
  });

  it("skips directories with no plugin.json and dot-prefixed directories", async () => {
    const root = await makeProject();
    await writePlugin(root, "notes", null, { "README.md": "hi" });
    await writePlugin(root, ".scratch", manifest("acme.hidden"));
    await writePlugin(root, "real", manifest("acme.real"));

    const result = await discoverProjectPlugins(root);
    expect(result.plugins.map((p) => p.dirName)).toEqual(["real"]);
  });

  it("rejects a plugin directory that symlinks outside the project root", async () => {
    const root = await makeProject();
    const outside = await makeProject();
    const evil = path.join(outside, "evil");
    await fs.mkdir(evil, { recursive: true });
    await fs.writeFile(path.join(evil, "plugin.json"), manifest("acme.evil"));

    const pluginsRoot = path.join(root, ".daintree", "plugins");
    await fs.mkdir(pluginsRoot, { recursive: true });
    await fs.symlink(evil, path.join(pluginsRoot, "escape"), "dir");

    const result = await discoverProjectPlugins(root);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]!.manifest).toBeUndefined();
    expect(result.plugins[0]!.error).toMatch(/links outside the project/);
  });

  it("rejects a plugin.json that symlinks outside the project root", async () => {
    const root = await makeProject();
    const outside = await makeProject();
    const outsideManifest = path.join(outside, "plugin.json");
    await fs.writeFile(outsideManifest, manifest("acme.evil"));

    const dir = await writePlugin(root, "sneaky", null);
    await fs.symlink(outsideManifest, path.join(dir, "plugin.json"), "file");

    const result = await discoverProjectPlugins(root);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0]!.manifest).toBeUndefined();
    expect(result.plugins[0]!.error).toMatch(/links outside the project/);
  });

  it("rejects a plugins root that is itself a symlink out of the project", async () => {
    const root = await makeProject();
    const outside = await makeProject();
    await fs.mkdir(path.join(root, ".daintree"), { recursive: true });
    await fs.mkdir(path.join(outside, "plugins", "dashboard"), { recursive: true });
    await fs.writeFile(
      path.join(outside, "plugins", "dashboard", "plugin.json"),
      manifest("acme.dashboard")
    );
    await fs.symlink(path.join(outside, "plugins"), path.join(root, ".daintree", "plugins"), "dir");

    const result = await discoverProjectPlugins(root);
    expect(result.root).toBe(null);
    expect(result.plugins).toEqual([]);
  });

  it("rejects an oversized plugin.json without reading it into memory", async () => {
    const root = await makeProject();
    await writePlugin(root, "huge", "x".repeat(600 * 1024));

    const result = await discoverProjectPlugins(root);
    expect(result.plugins[0]!.error).toMatch(/larger than/);
  });

  /**
   * The hard property. Discovery runs before any trust decision, on a folder
   * anyone who can push to the repository can write. If this test can be made
   * to fail, an untrusted project can execute code just by being opened.
   */
  it("reads ONLY plugin.json — never dist/, never main, never a worker", async () => {
    const root = await makeProject();
    await writePlugin(root, "dashboard", manifest("acme.dashboard", { main: "dist/main.js" }), {
      "dist/main.js": "throw new Error('project plugin main must never be evaluated');",
      "dist/view.js": "throw new Error('project plugin view must never be evaluated');",
      "package.json": JSON.stringify({ scripts: { postinstall: "exit 1" } }),
    });

    const realFs = await import("fs");
    const readFileSpy = vi.spyOn(realFs.promises, "readFile");
    const openSpy = vi.spyOn(realFs.promises, "open");

    const result = await discoverProjectPlugins(root);
    expect(result.plugins[0]!.manifest?.name).toBe("acme.dashboard");

    const readPaths = readFileSpy.mock.calls.map((c) => String(c[0]));
    expect(readPaths).toHaveLength(1);
    expect(path.basename(readPaths[0]!)).toBe("plugin.json");
    expect(readPaths.some((p) => p.includes(`${path.sep}dist${path.sep}`))).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("lists every candidate deterministically, valid and invalid alike", async () => {
    const root = await makeProject();
    await writePlugin(root, "zeta", manifest("acme.zeta"));
    await writePlugin(root, "alpha", "{ bad");
    await writePlugin(root, "mid", manifest("acme.mid"));

    const result = await discoverProjectPlugins(root);
    expect(result.plugins.map((p) => p.dirName)).toEqual(["alpha", "mid", "zeta"]);
  });
});
