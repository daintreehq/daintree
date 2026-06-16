import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PLUGIN_EXTRA_ASSET_SKIP_DIRS,
  copyPluginExtraAssets,
  findMissingPluginAssets,
} from "../build-main.mjs";

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
    expect(copyPluginExtraAssets(path.join(workDir, "missing"), path.join(workDir, "dest"))).toEqual(
      []
    );
  });

  it("is idempotent across repeated runs", () => {
    const src = path.join(workDir, "src");
    const dest = path.join(workDir, "dest");
    writeFile(path.join(src, "bin", "demo-agent.mjs"), "v1\n");

    copyPluginExtraAssets(src, dest);
    copyPluginExtraAssets(src, dest);

    expect(fs.readFileSync(path.join(dest, "bin", "demo-agent.mjs"), "utf8")).toBe("v1\n");
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
