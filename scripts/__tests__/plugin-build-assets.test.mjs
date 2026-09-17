import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GUEST_RUNTIME_ASSETS,
  PLUGIN_EXTRA_ASSET_SKIP_DIRS,
  copyPluginExtraAssets,
  findMissingPluginAssets,
  findTypeScriptCommandHandlers,
  guestRuntimeBuildConfig,
} from "../build-main.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let workDir;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-build-assets-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function writeFile(filePath, contents = "// stub\n") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

describe("copyPluginExtraAssets", () => {
  it("copies bundled asset directories (bin, mcp, view) verbatim", () => {
    const src = path.join(workDir, "src");
    const dest = path.join(workDir, "dest");
    writeFile(path.join(src, "bin", "demo-agent.mjs"), "agent\n");
    writeFile(path.join(src, "mcp", "server.mjs"), "server\n");
    writeFile(path.join(src, "view", "panel.mjs"), "view\n");

    const copied = copyPluginExtraAssets(src, dest);

    expect(copied.sort()).toEqual(["bin", "mcp", "view"]);
    expect(fs.readFileSync(path.join(dest, "bin", "demo-agent.mjs"), "utf8")).toBe("agent\n");
    expect(fs.readFileSync(path.join(dest, "mcp", "server.mjs"), "utf8")).toBe("server\n");
    expect(fs.readFileSync(path.join(dest, "view", "panel.mjs"), "utf8")).toBe("view\n");
  });

  it("skips compiled/host-owned directories", () => {
    const src = path.join(workDir, "src");
    const dest = path.join(workDir, "dest");
    for (const skipped of PLUGIN_EXTRA_ASSET_SKIP_DIRS) {
      writeFile(path.join(src, skipped, "index.ts"), "skip\n");
    }
    writeFile(path.join(src, "bin", "keep.mjs"));

    const copied = copyPluginExtraAssets(src, dest);

    expect(copied).toEqual(["bin"]);
    for (const skipped of PLUGIN_EXTRA_ASSET_SKIP_DIRS) {
      expect(fs.existsSync(path.join(dest, skipped))).toBe(false);
    }
  });

  it("ignores top-level files, copying only directories", () => {
    const src = path.join(workDir, "src");
    const dest = path.join(workDir, "dest");
    writeFile(path.join(src, "plugin.json"), "{}");
    writeFile(path.join(src, "README.md"), "readme\n");
    writeFile(path.join(src, "bin", "keep.mjs"));

    const copied = copyPluginExtraAssets(src, dest);

    expect(copied).toEqual(["bin"]);
    expect(fs.existsSync(path.join(dest, "plugin.json"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "README.md"))).toBe(false);
  });

  it("returns an empty list when the source directory does not exist", () => {
    expect(
      copyPluginExtraAssets(path.join(workDir, "missing"), path.join(workDir, "dest"))
    ).toEqual([]);
  });

  it("is idempotent across repeated runs", () => {
    const src = path.join(workDir, "src");
    const dest = path.join(workDir, "dest");
    writeFile(path.join(src, "bin", "demo-agent.mjs"), "v1\n");

    copyPluginExtraAssets(src, dest);
    copyPluginExtraAssets(src, dest);

    expect(fs.readFileSync(path.join(dest, "bin", "demo-agent.mjs"), "utf8")).toBe("v1\n");
  });

  it("overwrites a changed source file on the next copy", () => {
    const src = path.join(workDir, "src");
    const dest = path.join(workDir, "dest");
    writeFile(path.join(src, "bin", "demo-agent.mjs"), "v1\n");
    copyPluginExtraAssets(src, dest);

    writeFile(path.join(src, "bin", "demo-agent.mjs"), "v2\n");
    copyPluginExtraAssets(src, dest);

    expect(fs.readFileSync(path.join(dest, "bin", "demo-agent.mjs"), "utf8")).toBe("v2\n");
  });

  it("copies a top-level asset file named by a ./relative command", () => {
    const src = path.join(workDir, "src");
    const dest = path.join(workDir, "dest");
    writeFile(
      path.join(src, "plugin.json"),
      JSON.stringify({ contributes: { agents: [{ command: "./agent.mjs" }] } })
    );
    writeFile(path.join(src, "agent.mjs"), "agent\n");

    const copied = copyPluginExtraAssets(src, dest);

    expect(copied).toContain("./agent.mjs");
    expect(fs.readFileSync(path.join(dest, "agent.mjs"), "utf8")).toBe("agent\n");
  });

  it("does not copy a top-level asset file that escapes the plugin dir", () => {
    const src = path.join(workDir, "src");
    const dest = path.join(workDir, "dest");
    writeFile(
      path.join(src, "plugin.json"),
      JSON.stringify({ contributes: { mcpServers: [{ command: "./../secret.mjs" }] } })
    );
    writeFile(path.join(workDir, "secret.mjs"), "secret\n");

    const copied = copyPluginExtraAssets(src, dest);

    expect(copied).not.toContain("./../secret.mjs");
    expect(fs.existsSync(path.join(dest, "secret.mjs"))).toBe(false);
    expect(fs.existsSync(path.join(workDir, "dest", "..", "secret.mjs"))).toBe(true); // untouched original
  });
});

describe("findMissingPluginAssets", () => {
  function writeManifest(tier, name, manifest, assets = {}) {
    const pluginDir = path.join(workDir, tier, name);
    writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest));
    for (const [relPath, contents] of Object.entries(assets)) {
      writeFile(path.join(pluginDir, relPath), contents);
    }
  }

  it("returns no findings when every ./relative path exists", () => {
    writeManifest(
      "sample",
      "ok",
      {
        contributes: {
          agents: [{ command: "./bin/demo-agent.mjs" }],
          mcpServers: [{ command: "node", args: ["./mcp/server.mjs"] }],
        },
      },
      { "bin/demo-agent.mjs": "agent\n", "mcp/server.mjs": "server\n" }
    );

    expect(findMissingPluginAssets(workDir)).toEqual([]);
  });

  it("flags an agent command whose file is absent", () => {
    writeManifest("sample", "broken", {
      contributes: { agents: [{ command: "./bin/demo-agent.mjs" }] },
    });

    const missing = findMissingPluginAssets(workDir);

    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("sample/broken");
    expect(missing[0]).toContain("./bin/demo-agent.mjs");
  });

  it("reports only the missing path when a plugin mixes present and absent assets", () => {
    writeManifest(
      "sample",
      "mixed",
      {
        contributes: {
          agents: [{ command: "./bin/present.mjs" }],
          mcpServers: [{ command: "./mcp/absent.mjs" }],
        },
      },
      { "bin/present.mjs": "ok\n" }
    );

    const missing = findMissingPluginAssets(workDir);

    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("./mcp/absent.mjs");
  });

  it("resolves a ./relative MCP server command path", () => {
    writeManifest(
      "builtin",
      "mcp-command",
      { contributes: { mcpServers: [{ command: "./mcp/server.mjs" }] } },
      { "mcp/server.mjs": "server\n" }
    );

    expect(findMissingPluginAssets(workDir)).toEqual([]);
  });

  it("flags a ./relative path that escapes the plugin directory", () => {
    writeManifest("sample", "traversal", {
      contributes: { mcpServers: [{ command: "./../sibling/server.mjs" }] },
    });

    const missing = findMissingPluginAssets(workDir);

    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("escapes the plugin directory");
  });

  it("flags a missing MCP server arg path", () => {
    writeManifest("builtin", "broken-mcp", {
      contributes: { mcpServers: [{ command: "node", args: ["./mcp/server.mjs"] }] },
    });

    const missing = findMissingPluginAssets(workDir);

    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("builtin/broken-mcp");
    expect(missing[0]).toContain("./mcp/server.mjs");
  });

  it("ignores bare PATH commands and non-relative args", () => {
    writeManifest("sample", "path-binary", {
      contributes: {
        agents: [{ command: "echo", args: ["hello"] }],
        mcpServers: [{ command: "node", args: ["--version"] }],
      },
    });

    expect(findMissingPluginAssets(workDir)).toEqual([]);
  });

  it("returns no findings when the dist plugins root does not exist", () => {
    expect(findMissingPluginAssets(path.join(workDir, "never-built"))).toEqual([]);
  });

  it("reports an unreadable manifest instead of throwing", () => {
    const pluginDir = path.join(workDir, "sample", "bad-json");
    writeFile(path.join(pluginDir, "plugin.json"), "{ not json");

    const missing = findMissingPluginAssets(workDir);

    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("sample/bad-json");
  });
});

describe("findTypeScriptCommandHandlers", () => {
  function writeManifest(tier, name, manifest, handlers = {}) {
    const pluginDir = path.join(workDir, tier, name);
    writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest));
    for (const [relPath, contents] of Object.entries(handlers)) {
      writeFile(path.join(pluginDir, relPath), contents);
    }
  }

  it("flags a command whose handler is authored as src/{id}.ts", () => {
    writeManifest(
      "sample",
      "ts-handler",
      { contributes: { commands: [{ id: "greet" }] } },
      { "src/greet.ts": "export default () => {}\n" }
    );

    const offenders = findTypeScriptCommandHandlers(workDir);

    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toBe("sample/ts-handler: src/greet.ts");
  });

  it("flags a .tsx handler", () => {
    writeManifest(
      "builtin",
      "tsx-handler",
      { contributes: { commands: [{ id: "panel" }] } },
      { "src/panel.tsx": "export default () => {}\n" }
    );

    const offenders = findTypeScriptCommandHandlers(workDir);

    expect(offenders).toEqual(["builtin/tsx-handler: src/panel.tsx"]);
  });

  it("accepts a .js handler", () => {
    writeManifest(
      "sample",
      "js-handler",
      { contributes: { commands: [{ id: "greet" }] } },
      { "src/greet.js": "export default () => {}\n" }
    );

    expect(findTypeScriptCommandHandlers(workDir)).toEqual([]);
  });

  it("ignores a command with no on-disk handler (imperative registration)", () => {
    writeManifest("sample", "imperative", { contributes: { commands: [{ id: "greet" }] } });

    expect(findTypeScriptCommandHandlers(workDir)).toEqual([]);
  });

  it("reports only the offending command when a plugin mixes .ts and .js handlers", () => {
    writeManifest(
      "sample",
      "mixed",
      { contributes: { commands: [{ id: "ok" }, { id: "bad" }] } },
      { "src/ok.js": "export default () => {}\n", "src/bad.ts": "export default () => {}\n" }
    );

    const offenders = findTypeScriptCommandHandlers(workDir);

    expect(offenders).toEqual(["sample/mixed: src/bad.ts"]);
  });

  it("does not flag a .ts handler when a loadable .js sibling exists", () => {
    // Mid-migration: the runtime resolves greet.js, so greet.ts is not a footgun.
    writeManifest(
      "sample",
      "migrating",
      { contributes: { commands: [{ id: "greet" }] } },
      { "src/greet.ts": "x\n", "src/greet.js": "export default () => {}\n" }
    );

    expect(findTypeScriptCommandHandlers(workDir)).toEqual([]);
  });

  it("flags .mts and .cts handlers (also unloadable at runtime)", () => {
    writeManifest(
      "builtin",
      "module-ts",
      { contributes: { commands: [{ id: "a" }, { id: "b" }] } },
      { "src/a.mts": "x\n", "src/b.cts": "x\n" }
    );

    expect(findTypeScriptCommandHandlers(workDir).sort()).toEqual([
      "builtin/module-ts: src/a.mts",
      "builtin/module-ts: src/b.cts",
    ]);
  });

  it("returns no findings when the plugins root does not exist", () => {
    expect(findTypeScriptCommandHandlers(path.join(workDir, "never"))).toEqual([]);
  });

  it("skips an unreadable manifest instead of throwing", () => {
    const pluginDir = path.join(workDir, "sample", "bad-json");
    writeFile(path.join(pluginDir, "plugin.json"), "{ not json");
    writeFile(path.join(pluginDir, "src", "greet.ts"), "x\n");

    expect(findTypeScriptCommandHandlers(workDir)).toEqual([]);
  });
});

describe("guest runtime assets", () => {
  it("names entries that exist and land inside their plugin's dist directory", () => {
    expect(GUEST_RUNTIME_ASSETS.length).toBeGreaterThan(0);
    for (const asset of GUEST_RUNTIME_ASSETS) {
      expect(fs.existsSync(path.join(repoRoot, asset.entry))).toBe(true);
      const plugin = asset.entry.split("/")[2];
      expect(asset.outfile.startsWith(`dist-electron/plugins/builtin/${plugin}/`)).toBe(true);
    }
  });

  it("emits a browser IIFE, never a module or a named-function transform", () => {
    const config = guestRuntimeBuildConfig(GUEST_RUNTIME_ASSETS[0]);

    expect(config.format).toBe("iife");
    expect(config.platform).toBe("browser");
    expect(config.bundle).toBe(true);
    // The host reads the file as text and splices it; a sourcemap comment or a
    // `keepNames` helper would travel into the page with it.
    expect(config.sourcemap).toBe(false);
    expect(config.keepNames).toBeUndefined();
    // Strict, because the prelude splices the asset where a directive prologue
    // of its own would no longer apply.
    expect(config.banner.js).toBe("(() => {");
    expect(config.footer.js).toBe("})();");
  });

  it("minifies only when the caller asks, so a dev build stays readable", () => {
    expect(guestRuntimeBuildConfig(GUEST_RUNTIME_ASSETS[0]).minify).toBe(false);
    expect(guestRuntimeBuildConfig(GUEST_RUNTIME_ASSETS[0], { minify: true }).minify).toBe(true);
  });

  it("is not a directory the plugin asset copy would also mirror", () => {
    // The entry lives under `renderer/`, which the copy step skips — otherwise
    // the TypeScript source would ship beside the built asset.
    for (const asset of GUEST_RUNTIME_ASSETS) {
      expect(PLUGIN_EXTRA_ASSET_SKIP_DIRS.has(asset.entry.split("/")[3])).toBe(true);
    }
  });
});
