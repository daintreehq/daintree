import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { syncPluginAssets, syncPluginTier, watchPluginAssets } from "./plugin-asset-sync.mjs";

const RESERVED = ["main", "renderer", "shared", "__tests__", "__fixtures__", "review"];
const posixOnly = it.skipIf(process.platform === "win32");

let workDir;
let src;
let dest;

beforeEach(() => {
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-asset-sync-")));
  src = path.join(workDir, "src");
  dest = path.join(workDir, "dest");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    expect(read(path.join(dest, "mcp", "server.mjs"))).toBe("server\n");
    expect(read(path.join(dest, "view", "nested", "panel.mjs"))).toBe("view\n");
    expect(read(path.join(dest, "plugin.json"))).toBe(read(path.join(src, "plugin.json")));
  });

  it("never copies compiled or dev-only directories, and leaves the output's copies alone", () => {
    writeManifest(src);
    for (const reserved of RESERVED) {
      writeFile(path.join(src, reserved, "index.ts"), "source\n");
      writeFile(path.join(dest, reserved, "index.js"), "compiled\n");
    }

    syncPluginAssets(src, dest);

    for (const reserved of RESERVED) {
      expect(exists(path.join(dest, reserved, "index.ts"))).toBe(false);
      expect(read(path.join(dest, reserved, "index.js"))).toBe("compiled\n");
    }
  });

  it("treats reserved names case-insensitively on both sides", () => {
    writeManifest(src);
    writeFile(path.join(src, "Renderer", "panel.tsx"), "source\n");
    writeFile(path.join(dest, "Main", "index.js"), "compiled\n");

    syncPluginAssets(src, dest);

    expect(read(path.join(dest, "Main", "index.js"))).toBe("compiled\n");
    expect(exists(path.join(dest, "Renderer"))).toBe(false);
  });

  it("removes a top-level output file the manifest does not name", () => {
    writeManifest(src);
    writeFile(path.join(src, "README.md"), "readme\n");
    writeFile(path.join(dest, "README.md"), "stale\n");

    const { removed } = syncPluginAssets(src, dest);

    expect(removed).toEqual(["README.md"]);
    expect(exists(path.join(dest, "plugin.json"))).toBe(true);
    expect(exists(path.join(dest, "README.md"))).toBe(false);
  });

  it("does nothing when neither side exists", () => {
    expect(syncPluginAssets(path.join(workDir, "missing"), dest)).toEqual({
      copied: [],
      removed: [],
    });
    expect(exists(dest)).toBe(false);
  });

  it("leaves unchanged files unwritten", () => {
    writeManifest(src);
    writeFile(path.join(src, "bin", "agent.mjs"), "v1\n");
    writeFile(path.join(src, "bin", "other.mjs"), "same\n");
    syncPluginAssets(src, dest);
    const sentinel = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(path.join(dest, "bin", "other.mjs"), sentinel, sentinel);

    writeFile(path.join(src, "bin", "agent.mjs"), "v2\n");
    const { copied } = syncPluginAssets(src, dest);

    expect(copied).toEqual(["bin/agent.mjs"]);
    expect(read(path.join(dest, "bin", "agent.mjs"))).toBe("v2\n");
    expect(fs.statSync(path.join(dest, "bin", "other.mjs")).mtimeMs).toBe(sentinel.getTime());
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

  it("replaces an entry whose kind changed, in both directions", () => {
    writeManifest(src);
    writeFile(path.join(src, "bin", "tool"), "file\n");
    syncPluginAssets(src, dest);

    fs.rmSync(path.join(src, "bin", "tool"));
    writeFile(path.join(src, "bin", "tool", "run.mjs"), "dir\n");
    syncPluginAssets(src, dest);
    expect(read(path.join(dest, "bin", "tool", "run.mjs"))).toBe("dir\n");

    fs.rmSync(path.join(src, "bin", "tool"), { recursive: true });
    writeFile(path.join(src, "bin", "tool"), "file again\n");
    syncPluginAssets(src, dest);
    expect(read(path.join(dest, "bin", "tool"))).toBe("file again\n");
  });

  it("copies a top-level file a ./relative command names, and re-copies it when edited", () => {
    writeManifest(src, { contributes: { agents: [{ command: "./agent.mjs" }] } });
    writeFile(path.join(src, "agent.mjs"), "v1\n");
    expect(syncPluginAssets(src, dest).copied).toContain("agent.mjs");
    expect(read(path.join(dest, "agent.mjs"))).toBe("v1\n");

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

  it("keeps top-level files while the manifest can't be parsed, and mirrors it as saved", () => {
    writeManifest(src, { contributes: { agents: [{ command: "./agent.mjs" }] } });
    writeFile(path.join(src, "agent.mjs"), "agent\n");
    syncPluginAssets(src, dest);

    writeFile(path.join(src, "plugin.json"), '{ "contributes": ');
    const { copied, removed } = syncPluginAssets(src, dest);

    expect(copied).toEqual(["plugin.json"]);
    expect(removed).toEqual([]);
    expect(read(path.join(dest, "plugin.json"))).toBe('{ "contributes": ');
    expect(read(path.join(dest, "agent.mjs"))).toBe("agent\n");
  });

  it("does not copy a file that escapes the plugin directory or sits under a reserved one", () => {
    const pluginSrc = path.join(workDir, "in", "plugin");
    const pluginDest = path.join(workDir, "out", "plugin");
    writeManifest(pluginSrc, {
      contributes: {
        mcpServers: [{ command: "./../secret.mjs" }],
        agents: [{ command: "./main/helper.mjs" }],
      },
    });
    writeFile(path.join(workDir, "in", "secret.mjs"), "secret\n");
    writeFile(path.join(pluginSrc, "main", "helper.mjs"), "helper\n");
    writeFile(path.join(pluginSrc, "helper.mjs"), "unlisted\n");

    syncPluginAssets(pluginSrc, pluginDest);

    expect(exists(path.join(workDir, "out", "secret.mjs"))).toBe(false);
    expect(exists(path.join(pluginDest, "secret.mjs"))).toBe(false);
    expect(exists(path.join(pluginDest, "main", "helper.mjs"))).toBe(false);
    expect(exists(path.join(pluginDest, "helper.mjs"))).toBe(false);
    expect(read(path.join(workDir, "in", "secret.mjs"))).toBe("secret\n");
  });

  it("drops the manifest and assets when the source manifest is removed, keeping compiled output", () => {
    writeManifest(src);
    writeFile(path.join(src, "view", "panel.mjs"));
    syncPluginAssets(src, dest);
    writeFile(path.join(dest, "main", "index.js"), "compiled\n");

    fs.rmSync(path.join(src, "plugin.json"));
    const { removed } = syncPluginAssets(src, dest);

    expect(removed.sort()).toEqual(["plugin.json", "view"]);
    expect(exists(path.join(dest, "plugin.json"))).toBe(false);
    expect(exists(path.join(dest, "view"))).toBe(false);
    expect(read(path.join(dest, "main", "index.js"))).toBe("compiled\n");
  });

  it("keeps what it changed before a failure in the changes it was given", () => {
    writeManifest(src, { name: "v1" });
    writeFile(path.join(src, "bin", "agent.mjs"), "agent\n");
    const realCopy = fs.copyFileSync;
    vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, mode) => {
      if (from === path.join(src, "bin", "agent.mjs")) throw new Error("vanished mid-save");
      return realCopy.call(fs, from, to, mode);
    });
    const changes = { copied: [], removed: [] };

    expect(() => syncPluginAssets(src, dest, changes)).toThrow("vanished mid-save");

    expect(changes.copied).toEqual(["plugin.json"]);
    expect(fs.readdirSync(path.join(dest, "bin"))).toEqual([]);
  });

  posixOnly("carries an executable bit flipped either way on an unchanged script", () => {
    writeManifest(src);
    const script = path.join(src, "bin", "agent.sh");
    writeFile(script, "#!/bin/sh\n");
    fs.chmodSync(script, 0o644);
    syncPluginAssets(src, dest);

    fs.chmodSync(script, 0o755);
    expect(syncPluginAssets(src, dest).copied).toEqual(["bin/agent.sh"]);
    expect(fs.statSync(path.join(dest, "bin", "agent.sh")).mode & 0o777).toBe(0o755);

    fs.chmodSync(script, 0o644);
    expect(syncPluginAssets(src, dest).copied).toEqual(["bin/agent.sh"]);
    expect(fs.statSync(path.join(dest, "bin", "agent.sh")).mode & 0o777).toBe(0o644);
  });

  posixOnly("replaces a read-only copy when its source changes", () => {
    writeManifest(src);
    const asset = path.join(src, "view", "panel.mjs");
    writeFile(asset, "v1\n");
    fs.chmodSync(asset, 0o444);
    syncPluginAssets(src, dest);

    fs.chmodSync(asset, 0o644);
    writeFile(asset, "v2\n");
    fs.chmodSync(asset, 0o444);
    syncPluginAssets(src, dest);

    expect(read(path.join(dest, "view", "panel.mjs"))).toBe("v2\n");
    expect(fs.readdirSync(path.join(dest, "view"))).toEqual(["panel.mjs"]);
  });

  posixOnly("replaces a symlink in the output instead of writing through it", () => {
    writeManifest(src);
    writeFile(path.join(src, "view", "panel.mjs"), "panel\n");
    writeFile(path.join(dest, "main", "index.js"), "compiled\n");
    fs.mkdirSync(path.join(dest, "view"));
    fs.symlinkSync(path.join(dest, "main", "index.js"), path.join(dest, "view", "panel.mjs"));

    syncPluginAssets(src, dest);

    expect(read(path.join(dest, "main", "index.js"))).toBe("compiled\n");
    expect(fs.lstatSync(path.join(dest, "view", "panel.mjs")).isSymbolicLink()).toBe(false);
    expect(read(path.join(dest, "view", "panel.mjs"))).toBe("panel\n");
  });

  posixOnly("never syncs through an output plugin directory that is a link", () => {
    writeManifest(src);
    const elsewhere = path.join(workDir, "elsewhere");
    writeFile(path.join(elsewhere, "README.md"), "keep\n");
    fs.symlinkSync(elsewhere, dest);

    const { removed } = syncPluginAssets(src, dest);

    expect(removed).toEqual(["."]);
    expect(read(path.join(elsewhere, "README.md"))).toBe("keep\n");
    expect(fs.lstatSync(dest).isDirectory()).toBe(true);
    expect(exists(path.join(dest, "plugin.json"))).toBe(true);
  });

  posixOnly("ships a source link to a file inside the plugin as a copy, and nothing else", () => {
    writeManifest(src);
    writeFile(path.join(src, "bin", "real.mjs"), "real\n");
    writeFile(path.join(workDir, "outside.mjs"), "outside\n");
    fs.symlinkSync(path.join(src, "bin", "real.mjs"), path.join(src, "bin", "alias.mjs"));
    fs.symlinkSync(path.join(workDir, "outside.mjs"), path.join(src, "bin", "escape.mjs"));
    fs.symlinkSync(path.join(src, "bin"), path.join(src, "bin", "loop"));

    syncPluginAssets(src, dest);

    expect(fs.readdirSync(path.join(dest, "bin")).sort()).toEqual(["alias.mjs", "real.mjs"]);
    expect(fs.lstatSync(path.join(dest, "bin", "alias.mjs")).isFile()).toBe(true);
    expect(read(path.join(dest, "bin", "alias.mjs"))).toBe("real\n");
  });
});

describe("syncPluginTier", () => {
  it("drops a removed plugin's manifest and assets from the output, keeping its compiled main", () => {
    writeManifest(path.join(src, "kept"));
    writeManifest(path.join(dest, "gone"));
    writeFile(path.join(dest, "gone", "bin", "agent.mjs"));
    writeFile(path.join(dest, "gone", "main", "index.js"), "compiled\n");

    const changed = syncPluginTier(src, dest).map(({ name, copied, removed }) => ({
      name,
      copied: copied.sort(),
      removed: removed.sort(),
    }));

    expect(changed).toEqual([
      { name: "gone", copied: [], removed: ["bin", "plugin.json"] },
      { name: "kept", copied: ["plugin.json"], removed: [] },
    ]);
    expect(exists(path.join(dest, "kept", "plugin.json"))).toBe(true);
    expect(exists(path.join(dest, "gone", "plugin.json"))).toBe(false);
    expect(exists(path.join(dest, "gone", "bin"))).toBe(false);
    expect(read(path.join(dest, "gone", "main", "index.js"))).toBe("compiled\n");
  });

  it("reports nothing once the output is current", () => {
    writeManifest(path.join(src, "kept"));
    expect(syncPluginTier(src, dest)).toHaveLength(1);

    expect(syncPluginTier(src, dest)).toEqual([]);
  });
});

describe("watchPluginAssets", () => {
  const NO_RESCAN = 60 * 60 * 1000;
  let handle;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
  });

  function seedPlugin(name = "demo") {
    const pluginSrc = path.join(src, "builtin", name);
    const pluginDest = path.join(dest, "builtin", name);
    writeManifest(pluginSrc, { name: "v1", contributes: { agents: [{ command: "./run.mjs" }] } });
    writeFile(path.join(pluginSrc, "run.mjs"), "run\n");
    writeFile(path.join(pluginSrc, "bin", "old.mjs"), "script\n");
    writeFile(path.join(pluginSrc, "view", "panel.mjs"), "panel\n");
    syncPluginTier(path.join(src, "builtin"), path.join(dest, "builtin"));
    writeFile(path.join(pluginDest, "main", "index.js"), "compiled\n");
    writeFile(path.join(pluginDest, "main", "index.js.map"), "{}\n");
    return { pluginSrc, pluginDest };
  }

  /** A stand-in for `fs.watch` whose events the test fires by hand. */
  function fakeWatch() {
    const listeners = new Map();
    const watchers = [];
    const watch = vi.fn((dir, _options, listener) => {
      listeners.set(path.basename(dir), listener);
      const watcher = new EventEmitter();
      watcher.close = vi.fn();
      watchers.push(watcher);
      return watcher;
    });
    const emit = (tier, filename) => listeners.get(tier)("change", filename);
    return { watch, emit, watchers };
  }

  it("mirrors manifest edits, a script rename and an asset deletion through fs.watch", async () => {
    const wait = { timeout: 10_000, interval: 25 };
    const { pluginSrc, pluginDest } = seedPlugin();
    const onChange = vi.fn(async () => {});
    handle = watchPluginAssets({
      srcRoot: src,
      destRoot: dest,
      debounceMs: 20,
      rescanMs: NO_RESCAN,
      onChange,
    });
    const manifestName = () => JSON.parse(read(path.join(pluginDest, "plugin.json"))).name;

    // An editor's atomic save, then an in-place edit of the replacement.
    const tmp = path.join(pluginSrc, ".plugin.json.tmp");
    writeFile(tmp, JSON.stringify({ name: "v2" }));
    fs.renameSync(tmp, path.join(pluginSrc, "plugin.json"));
    await vi.waitFor(() => expect(manifestName()).toBe("v2"), wait);
    writeFile(path.join(pluginSrc, "plugin.json"), JSON.stringify({ name: "v3" }));
    await vi.waitFor(() => expect(manifestName()).toBe("v3"), wait);

    fs.renameSync(path.join(pluginSrc, "bin", "old.mjs"), path.join(pluginSrc, "bin", "new.mjs"));
    fs.rmSync(path.join(pluginSrc, "view", "panel.mjs"));
    await vi.waitFor(() => {
      expect(exists(path.join(pluginDest, "bin", "new.mjs"))).toBe(true);
      expect(exists(path.join(pluginDest, "bin", "old.mjs"))).toBe(false);
      expect(exists(path.join(pluginDest, "view", "panel.mjs"))).toBe(false);
    }, wait);

    // v2 stopped naming ./run.mjs, so it went with the manifest edit.
    expect(exists(path.join(pluginDest, "run.mjs"))).toBe(false);
    expect(read(path.join(pluginDest, "main", "index.js"))).toBe("compiled\n");
    expect(read(path.join(pluginDest, "main", "index.js.map"))).toBe("{}\n");
    expect(onChange.mock.calls[0][0][0]).toMatchObject({
      tier: "builtin",
      name: "demo",
      copied: expect.arrayContaining(["plugin.json"]),
    });
  });

  it("syncs a marked plugin only once the debounce settles", async () => {
    vi.useFakeTimers();
    const { pluginSrc, pluginDest } = seedPlugin();
    const fake = fakeWatch();
    handle = watchPluginAssets({
      srcRoot: src,
      destRoot: dest,
      debounceMs: 100,
      rescanMs: NO_RESCAN,
      watch: fake.watch,
    });

    writeFile(path.join(pluginSrc, "bin", "old.mjs"), "edited\n");
    fake.emit("builtin", path.join("demo", "bin", "old.mjs"));
    await vi.advanceTimersByTimeAsync(60);
    fake.emit("builtin", path.join("demo", "bin", "old.mjs"));
    await vi.advanceTimersByTimeAsync(60);
    expect(read(path.join(pluginDest, "bin", "old.mjs"))).toBe("script\n");

    await vi.advanceTimersByTimeAsync(60);
    expect(read(path.join(pluginDest, "bin", "old.mjs"))).toBe("edited\n");
  });

  it("drains an edit that lands while a previous pass is still rechecking", async () => {
    vi.useFakeTimers();
    const { pluginSrc, pluginDest } = seedPlugin();
    const fake = fakeWatch();
    let release = () => {};
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const onChange = vi.fn(() => (onChange.mock.calls.length === 1 ? blocked : undefined));
    handle = watchPluginAssets({
      srcRoot: src,
      destRoot: dest,
      debounceMs: 20,
      rescanMs: NO_RESCAN,
      onChange,
      watch: fake.watch,
    });
    const script = path.join(pluginDest, "bin", "old.mjs");

    try {
      writeFile(path.join(pluginSrc, "bin", "old.mjs"), "edit 1\n");
      fake.emit("builtin", path.join("demo", "bin", "old.mjs"));
      await vi.advanceTimersByTimeAsync(50);
      expect(onChange).toHaveBeenCalledTimes(1);

      writeFile(path.join(pluginSrc, "bin", "old.mjs"), "edit 2\n");
      fake.emit("builtin", path.join("demo", "bin", "old.mjs"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(read(script)).toBe("edit 1\n");
    } finally {
      release();
    }

    await vi.waitFor(() => expect(read(script)).toBe("edit 2\n"));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("ignores events for the sources esbuild compiles", async () => {
    vi.useFakeTimers();
    const { pluginSrc, pluginDest } = seedPlugin();
    const fake = fakeWatch();
    handle = watchPluginAssets({
      srcRoot: src,
      destRoot: dest,
      debounceMs: 20,
      rescanMs: NO_RESCAN,
      watch: fake.watch,
    });
    // Changed on disk with no event of its own, so only a scheduled sync can copy it.
    writeFile(path.join(pluginSrc, "bin", "old.mjs"), "unsynced\n");

    fake.emit("builtin", path.join("demo", "main", "index.ts"));
    fake.emit("builtin", path.join("demo", "Renderer", "panel.tsx"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(read(path.join(pluginDest, "bin", "old.mjs"))).toBe("script\n");

    fake.emit("builtin", path.join("demo", "view", "panel.mjs"));
    await vi.advanceTimersByTimeAsync(50);
    expect(read(path.join(pluginDest, "bin", "old.mjs"))).toBe("unsynced\n");
  });

  it.each([".\\notes", "./notes", "../builtin", "DEMO~1/bin/old.mjs", null])(
    "rescans the tier, pruning no plugin, for an event naming %s",
    async (filename) => {
      vi.useFakeTimers();
      const { pluginSrc, pluginDest } = seedPlugin();
      const other = seedPlugin("other");
      const fake = fakeWatch();
      handle = watchPluginAssets({
        srcRoot: src,
        destRoot: dest,
        debounceMs: 20,
        rescanMs: NO_RESCAN,
        watch: fake.watch,
      });
      writeFile(path.join(pluginSrc, "bin", "old.mjs"), "unsynced\n");

      fake.emit("builtin", filename);
      await vi.advanceTimersByTimeAsync(50);

      expect(read(path.join(pluginDest, "bin", "old.mjs"))).toBe("unsynced\n");
      expect(exists(path.join(other.pluginDest, "plugin.json"))).toBe(true);
      expect(exists(path.join(other.pluginDest, "bin", "old.mjs"))).toBe(true);
      expect(fs.readdirSync(path.join(dest, "builtin")).sort()).toEqual(["demo", "other"]);
    }
  );

  it("reports a tier it can't read and tries again on the next rescan", async () => {
    vi.useFakeTimers();
    const { pluginSrc, pluginDest } = seedPlugin();
    const onError = vi.fn();
    const tierDir = path.join(src, "builtin");
    const realReaddir = fs.readdirSync;
    let failures = 0;
    vi.spyOn(fs, "readdirSync").mockImplementation((dir, options) => {
      if (dir === tierDir && failures === 0) {
        failures += 1;
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      }
      return realReaddir.call(fs, dir, options);
    });
    handle = watchPluginAssets({
      srcRoot: src,
      destRoot: dest,
      rescanMs: 100,
      onError,
      watch: fakeWatch().watch,
    });
    writeFile(path.join(pluginSrc, "bin", "old.mjs"), "edited\n");

    await vi.advanceTimersByTimeAsync(110);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "EACCES" }));
    expect(read(path.join(pluginDest, "bin", "old.mjs"))).toBe("script\n");

    await vi.advanceTimersByTimeAsync(100);
    expect(read(path.join(pluginDest, "bin", "old.mjs"))).toBe("edited\n");
  });

  it("rechecks a manifest copied by a pass that failed partway", async () => {
    vi.useFakeTimers();
    const { pluginSrc } = seedPlugin();
    const fake = fakeWatch();
    const onChange = vi.fn(async () => {});
    const onError = vi.fn();
    handle = watchPluginAssets({
      srcRoot: src,
      destRoot: dest,
      debounceMs: 20,
      rescanMs: NO_RESCAN,
      onChange,
      onError,
      watch: fake.watch,
    });
    writeManifest(pluginSrc, { name: "v2", contributes: { agents: [{ command: "./run.mjs" }] } });
    writeFile(path.join(pluginSrc, "bin", "old.mjs"), "edited\n");
    const realCopy = fs.copyFileSync;
    vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, mode) => {
      if (from === path.join(pluginSrc, "bin", "old.mjs")) throw new Error("vanished mid-save");
      return realCopy.call(fs, from, to, mode);
    });

    fake.emit("builtin", path.join("demo", "plugin.json"));
    await vi.advanceTimersByTimeAsync(50);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "vanished mid-save" }));
    expect(onChange).toHaveBeenCalledWith([
      { tier: "builtin", name: "demo", copied: ["plugin.json"], removed: [] },
    ]);
  });

  it("mirrors every tier before returning when asked, and reports it like any pass", async () => {
    writeManifest(path.join(src, "sample", "first"));
    const onChange = vi.fn(async () => {});

    handle = watchPluginAssets({
      srcRoot: src,
      destRoot: dest,
      rescanMs: NO_RESCAN,
      initialSync: true,
      onChange,
      watch: fakeWatch().watch,
    });

    expect(exists(path.join(dest, "sample", "first", "plugin.json"))).toBe(true);
    await vi.waitFor(() =>
      expect(onChange).toHaveBeenCalledWith([
        { tier: "sample", name: "first", copied: ["plugin.json"], removed: [] },
      ])
    );
  });

  it("picks up a tier created after it started through the periodic rescan", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn(async () => {});
    handle = watchPluginAssets({ srcRoot: src, destRoot: dest, rescanMs: 100, onChange });

    writeManifest(path.join(src, "sample", "late"));
    await vi.advanceTimersByTimeAsync(110);

    expect(exists(path.join(dest, "sample", "late", "plugin.json"))).toBe(true);
    expect(onChange).toHaveBeenCalledWith([
      { tier: "sample", name: "late", copied: ["plugin.json"], removed: [] },
    ]);
  });

  it("closes its watchers and clears its timers on close", async () => {
    vi.useFakeTimers();
    const { pluginSrc, pluginDest } = seedPlugin();
    fs.mkdirSync(path.join(src, "sample"));
    const fake = fakeWatch();
    handle = watchPluginAssets({
      srcRoot: src,
      destRoot: dest,
      debounceMs: 20,
      rescanMs: 100,
      watch: fake.watch,
    });
    fake.emit("builtin", path.join("demo", "bin", "old.mjs"));

    await handle.close();

    expect(fake.watchers).toHaveLength(2);
    for (const watcher of fake.watchers) expect(watcher.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    writeFile(path.join(pluginSrc, "bin", "old.mjs"), "after close\n");
    fake.emit("builtin", path.join("demo", "bin", "old.mjs"));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(read(path.join(pluginDest, "bin", "old.mjs"))).toBe("script\n");
  });
});
