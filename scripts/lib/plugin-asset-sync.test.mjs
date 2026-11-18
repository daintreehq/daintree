import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PLUGIN_EXTRA_ASSET_SKIP_DIRS,
  syncPluginAssets,
  syncPluginTier,
  watchPluginAssets,
} from "./plugin-asset-sync.mjs";

let workDir;
let src;
let dest;

beforeEach(() => {
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-asset-sync-")));
  src = path.join(workDir, "src");
  dest = path.join(workDir, "dest");
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function writeFile(filePath, contents = "// stub\n") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writeManifest(dir, manifest = {}) {
  writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
}

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

describe("syncPluginAssets", () => {
  it("copies the manifest and bundled asset directories (bin, mcp, view) verbatim", () => {
    writeManifest(src);
    writeFile(path.join(src, "bin", "demo-agent.mjs"), "agent\n");
    writeFile(path.join(src, "mcp", "server.mjs"), "server\n");
    writeFile(path.join(src, "view", "nested", "panel.mjs"), "view\n");

    const { copied, removed } = syncPluginAssets(src, dest);

    expect(copied.sort()).toEqual([
      "bin/demo-agent.mjs",
      "mcp/server.mjs",
      "plugin.json",
      "view/nested/panel.mjs",
    ]);
    expect(removed).toEqual([]);
    expect(read(path.join(dest, "bin", "demo-agent.mjs"))).toBe("agent\n");
    expect(read(path.join(dest, "view", "nested", "panel.mjs"))).toBe("view\n");
    expect(read(path.join(dest, "plugin.json"))).toBe(read(path.join(src, "plugin.json")));
  });

  it("never copies compiled or dev-only directories, and leaves the output's copies alone", () => {
    writeManifest(src);
    for (const skipped of PLUGIN_EXTRA_ASSET_SKIP_DIRS) {
      writeFile(path.join(src, skipped, "index.ts"), "source\n");
      writeFile(path.join(dest, skipped, "index.js"), "compiled\n");
    }
    writeFile(path.join(dest, "Main", "cased.js"), "compiled\n");

    syncPluginAssets(src, dest);

    for (const skipped of PLUGIN_EXTRA_ASSET_SKIP_DIRS) {
      expect(exists(path.join(dest, skipped, "index.ts"))).toBe(false);
      expect(read(path.join(dest, skipped, "index.js"))).toBe("compiled\n");
    }
    expect(read(path.join(dest, "Main", "cased.js"))).toBe("compiled\n");
  });

  it("leaves top-level files the manifest does not name out of the output", () => {
    writeManifest(src);
    writeFile(path.join(src, "README.md"), "readme\n");

    syncPluginAssets(src, dest);

    expect(exists(path.join(dest, "plugin.json"))).toBe(true);
    expect(exists(path.join(dest, "README.md"))).toBe(false);
  });

  it("does nothing when the source directory does not exist", () => {
    expect(syncPluginAssets(path.join(workDir, "missing"), dest)).toEqual({
      copied: [],
      removed: [],
    });
    expect(exists(dest)).toBe(false);
  });

  it("re-copies only what changed", () => {
    writeManifest(src);
    writeFile(path.join(src, "bin", "agent.mjs"), "v1\n");
    writeFile(path.join(src, "bin", "other.mjs"), "same\n");
    syncPluginAssets(src, dest);

    writeFile(path.join(src, "bin", "agent.mjs"), "v2\n");
    const { copied } = syncPluginAssets(src, dest);

    expect(copied).toEqual(["bin/agent.mjs"]);
    expect(read(path.join(dest, "bin", "agent.mjs"))).toBe("v2\n");
  });

  it("drops a renamed script's old copy", () => {
    writeManifest(src);
    writeFile(path.join(src, "bin", "old-name.mjs"), "agent\n");
    syncPluginAssets(src, dest);

    fs.renameSync(path.join(src, "bin", "old-name.mjs"), path.join(src, "bin", "new-name.mjs"));
    const { copied, removed } = syncPluginAssets(src, dest);

    expect(removed).toEqual(["bin/old-name.mjs"]);
    expect(copied).toEqual(["bin/new-name.mjs"]);
    expect(exists(path.join(dest, "bin", "old-name.mjs"))).toBe(false);
    expect(read(path.join(dest, "bin", "new-name.mjs"))).toBe("agent\n");
  });

  it("drops an asset directory removed from the source", () => {
    writeManifest(src);
    writeFile(path.join(src, "mcp", "server.mjs"));
    syncPluginAssets(src, dest);

    fs.rmSync(path.join(src, "mcp"), { recursive: true });
    const { removed } = syncPluginAssets(src, dest);

    expect(removed).toEqual(["mcp"]);
    expect(exists(path.join(dest, "mcp"))).toBe(false);
  });

  it("replaces an entry whose kind changed", () => {
    writeManifest(src);
    writeFile(path.join(src, "bin", "tool"), "file\n");
    syncPluginAssets(src, dest);

    fs.rmSync(path.join(src, "bin", "tool"));
    writeFile(path.join(src, "bin", "tool", "run.mjs"), "dir\n");
    syncPluginAssets(src, dest);

    expect(read(path.join(dest, "bin", "tool", "run.mjs"))).toBe("dir\n");
  });

  it("copies a top-level file a ./relative command names, and re-copies it when edited", () => {
    writeManifest(src, { contributes: { agents: [{ command: "./agent.mjs" }] } });
    writeFile(path.join(src, "agent.mjs"), "v1\n");
    expect(syncPluginAssets(src, dest).copied).toContain("agent.mjs");

    writeFile(path.join(src, "agent.mjs"), "v2\n");
    syncPluginAssets(src, dest);

    expect(read(path.join(dest, "agent.mjs"))).toBe("v2\n");
  });

  it("drops a top-level file once the manifest stops naming it", () => {
    writeManifest(src, { contributes: { mcpServers: [{ command: "node", args: ["./srv.mjs"] }] } });
    writeFile(path.join(src, "srv.mjs"), "server\n");
    syncPluginAssets(src, dest);

    writeManifest(src, { contributes: {} });
    const { removed } = syncPluginAssets(src, dest);

    expect(removed).toEqual(["srv.mjs"]);
    expect(exists(path.join(dest, "srv.mjs"))).toBe(false);
  });

  it("keeps top-level files while the manifest can't be parsed", () => {
    writeManifest(src, { contributes: { agents: [{ command: "./agent.mjs" }] } });
    writeFile(path.join(src, "agent.mjs"), "agent\n");
    syncPluginAssets(src, dest);

    writeFile(path.join(src, "plugin.json"), '{ "contributes": ');
    const { copied, removed } = syncPluginAssets(src, dest);

    expect(copied).toEqual(["plugin.json"]);
    expect(removed).toEqual([]);
    expect(read(path.join(dest, "agent.mjs"))).toBe("agent\n");
  });

  it("does not copy a file that escapes the plugin directory or sits under a reserved one", () => {
    writeManifest(src, {
      contributes: {
        mcpServers: [{ command: "./../secret.mjs" }],
        agents: [{ command: "./main/helper.mjs" }],
      },
    });
    writeFile(path.join(workDir, "secret.mjs"), "secret\n");
    writeFile(path.join(src, "main", "helper.mjs"), "helper\n");

    syncPluginAssets(src, dest);

    expect(exists(path.join(dest, "secret.mjs"))).toBe(false);
    expect(exists(path.join(dest, "main", "helper.mjs"))).toBe(false);
    expect(exists(path.join(workDir, "secret.mjs"))).toBe(true);
  });

  it("drops the manifest and assets when the source manifest is removed, keeping compiled output", () => {
    writeManifest(src);
    writeFile(path.join(src, "view", "panel.mjs"));
    syncPluginAssets(src, dest);
    writeFile(path.join(dest, "main", "index.js"), "compiled\n");

    fs.rmSync(path.join(src, "plugin.json"));
    const { removed } = syncPluginAssets(src, dest);

    expect(removed.sort()).toEqual(["plugin.json", "view"]);
    expect(read(path.join(dest, "main", "index.js"))).toBe("compiled\n");
  });

  it.skipIf(process.platform === "win32")(
    "carries an executable bit flipped on an unchanged script",
    () => {
      writeManifest(src);
      writeFile(path.join(src, "bin", "agent.sh"), "#!/bin/sh\n");
      fs.chmodSync(path.join(src, "bin", "agent.sh"), 0o644);
      syncPluginAssets(src, dest);

      fs.chmodSync(path.join(src, "bin", "agent.sh"), 0o755);
      const { copied } = syncPluginAssets(src, dest);

      expect(copied).toEqual(["bin/agent.sh"]);
      expect(fs.statSync(path.join(dest, "bin", "agent.sh")).mode & 0o777).toBe(0o755);
    }
  );
});

describe("syncPluginTier", () => {
  it("drops a removed plugin's manifest and assets from the output, keeping its compiled main", () => {
    writeManifest(path.join(src, "kept"));
    writeManifest(path.join(dest, "gone"));
    writeFile(path.join(dest, "gone", "bin", "agent.mjs"));
    writeFile(path.join(dest, "gone", "main", "index.js"), "compiled\n");

    const changed = syncPluginTier(src, dest);

    expect(changed.map(({ name }) => name)).toEqual(["gone", "kept"]);
    expect(exists(path.join(dest, "kept", "plugin.json"))).toBe(true);
    expect(exists(path.join(dest, "gone", "plugin.json"))).toBe(false);
    expect(exists(path.join(dest, "gone", "bin"))).toBe(false);
    expect(read(path.join(dest, "gone", "main", "index.js"))).toBe("compiled\n");
  });

  it("reports nothing when the output is already current", () => {
    writeManifest(path.join(src, "kept"));
    syncPluginTier(src, dest);

    expect(syncPluginTier(src, dest)).toEqual([]);
  });
});

describe("watchPluginAssets", () => {
  const WAIT = { timeout: 5000, interval: 25 };
  let handle;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  function seedPlugin() {
    const pluginSrc = path.join(src, "builtin", "demo");
    const pluginDest = path.join(dest, "builtin", "demo");
    writeManifest(pluginSrc, { name: "v1", contributes: { agents: [{ command: "./run.mjs" }] } });
    writeFile(path.join(pluginSrc, "run.mjs"), "run\n");
    writeFile(path.join(pluginSrc, "bin", "old.mjs"), "script\n");
    writeFile(path.join(pluginSrc, "view", "panel.mjs"), "panel\n");
    syncPluginTier(path.join(src, "builtin"), path.join(dest, "builtin"));
    writeFile(path.join(pluginDest, "main", "index.js"), "compiled\n");
    writeFile(path.join(pluginDest, "main", "index.js.map"), "{}\n");
    return { pluginSrc, pluginDest };
  }

  it("mirrors manifest edits, a script rename and an asset deletion while it runs", async () => {
    const { pluginSrc, pluginDest } = seedPlugin();
    const onChange = vi.fn(async () => {});
    handle = watchPluginAssets({ srcRoot: src, destRoot: dest, debounceMs: 20, onChange });

    // An editor's atomic save, then an in-place edit of the replacement.
    const tmp = path.join(pluginSrc, ".plugin.json.tmp");
    writeFile(tmp, JSON.stringify({ name: "v2" }));
    fs.renameSync(tmp, path.join(pluginSrc, "plugin.json"));
    await vi.waitFor(
      () => expect(JSON.parse(read(path.join(pluginDest, "plugin.json"))).name).toBe("v2"),
      WAIT
    );
    writeFile(path.join(pluginSrc, "plugin.json"), JSON.stringify({ name: "v3" }));
    await vi.waitFor(
      () => expect(JSON.parse(read(path.join(pluginDest, "plugin.json"))).name).toBe("v3"),
      WAIT
    );

    fs.renameSync(path.join(pluginSrc, "bin", "old.mjs"), path.join(pluginSrc, "bin", "new.mjs"));
    fs.rmSync(path.join(pluginSrc, "view", "panel.mjs"));
    await vi.waitFor(() => {
      expect(exists(path.join(pluginDest, "bin", "new.mjs"))).toBe(true);
      expect(exists(path.join(pluginDest, "bin", "old.mjs"))).toBe(false);
      expect(exists(path.join(pluginDest, "view", "panel.mjs"))).toBe(false);
    }, WAIT);

    // v2 stopped naming ./run.mjs, so it went with the manifest edit.
    expect(exists(path.join(pluginDest, "run.mjs"))).toBe(false);
    expect(read(path.join(pluginDest, "main", "index.js"))).toBe("compiled\n");
    expect(read(path.join(pluginDest, "main", "index.js.map"))).toBe("{}\n");
    const manifestPasses = onChange.mock.calls.filter(([changed]) =>
      changed.some(({ copied }) => copied.includes("plugin.json"))
    );
    expect(manifestPasses.length).toBeGreaterThanOrEqual(1);
    expect(onChange.mock.calls[0][0][0]).toMatchObject({ tier: "builtin", name: "demo" });
  });

  it("syncs an edit made while a previous pass is still rechecking", async () => {
    const { pluginSrc, pluginDest } = seedPlugin();
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const onChange = vi.fn(() => (onChange.mock.calls.length === 1 ? blocked : undefined));
    handle = watchPluginAssets({ srcRoot: src, destRoot: dest, debounceMs: 20, onChange });

    writeFile(path.join(pluginSrc, "bin", "old.mjs"), "edit 1\n");
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), WAIT);
    writeFile(path.join(pluginSrc, "bin", "old.mjs"), "edit 2\n");
    // Long enough for the debounce to fire into the pass that is still running.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(read(path.join(pluginDest, "bin", "old.mjs"))).toBe("edit 1\n");

    release();
    await vi.waitFor(
      () => expect(read(path.join(pluginDest, "bin", "old.mjs"))).toBe("edit 2\n"),
      WAIT
    );
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("ignores edits to the sources esbuild compiles", async () => {
    const { pluginSrc } = seedPlugin();
    const onChange = vi.fn(async () => {});
    handle = watchPluginAssets({
      srcRoot: src,
      destRoot: dest,
      debounceMs: 20,
      rescanMs: 60_000,
      onChange,
    });

    writeFile(path.join(pluginSrc, "main", "index.ts"), "export {};\n");
    writeFile(path.join(pluginSrc, "renderer", "panel.tsx"), "export {};\n");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("picks up a tier created after it started through the periodic rescan", async () => {
    const onChange = vi.fn(async () => {});
    handle = watchPluginAssets({ srcRoot: src, destRoot: dest, rescanMs: 50, onChange });

    writeManifest(path.join(src, "sample", "late"));

    await vi.waitFor(
      () => expect(exists(path.join(dest, "sample", "late", "plugin.json"))).toBe(true),
      WAIT
    );
    expect(onChange).toHaveBeenCalledWith([
      { tier: "sample", name: "late", copied: ["plugin.json"], removed: [] },
    ]);
  });

  it("stops syncing once closed", async () => {
    const { pluginSrc, pluginDest } = seedPlugin();
    handle = watchPluginAssets({ srcRoot: src, destRoot: dest, debounceMs: 20, rescanMs: 50 });
    await handle.close();

    writeFile(path.join(pluginSrc, "bin", "old.mjs"), "after close\n");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(read(path.join(pluginDest, "bin", "old.mjs"))).toBe("script\n");
  });
});
