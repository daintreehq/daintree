import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
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

  it("reads a manifest whose contributions have the wrong shape without throwing", () => {
    writeManifest("sample", "half-edited", {
      contributes: {
        agents: {},
        mcpServers: [
          { command: "./mcp/absent.mjs", args: { 0: "x" } },
          { command: "node", args: "./mcp/string-args.mjs" },
        ],
      },
    });
    writeManifest("sample", "servers-object", {
      contributes: { agents: [{ command: "./bin/absent.mjs" }], mcpServers: {} },
    });

    const missing = findMissingPluginAssets(workDir).sort();

    expect(missing).toHaveLength(2);
    expect(missing[0]).toContain("sample/half-edited");
    expect(missing[0]).toContain("./mcp/absent.mjs");
    expect(missing[1]).toContain("sample/servers-object");
    expect(missing[1]).toContain("./bin/absent.mjs");
  });

  it("says why a path under a reserved directory is missing", () => {
    writeManifest("builtin", "reserved", {
      contributes: {
        mcpServers: [
          {
            command: "node",
            args: ["./main/helper.mjs", "./shared/main", "./bin/x.mjs", "./main"],
          },
        ],
      },
    });

    const missing = findMissingPluginAssets(workDir);
    const forPath = (relPath) => missing.find((m) => m.includes(`"${relPath}"`));

    expect(missing).toHaveLength(4);
    expect(forPath("./main/helper.mjs")).toContain("never copies main/");
    expect(forPath("./shared/main")).toContain("never copies shared/");
    expect(forPath("./bin/x.mjs")).not.toContain("never copies");
    expect(forPath("./main")).not.toContain("never copies");
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

  it("skips commands that are not a list and keeps scanning", () => {
    writeManifest(
      "sample",
      "half-edited",
      { contributes: { commands: { id: "greet" } } },
      { "src/greet.ts": "x\n" }
    );
    writeManifest("sample", "numeric", { contributes: { commands: 3 } }, { "src/greet.ts": "x\n" });
    writeManifest(
      "sample",
      "valid",
      { contributes: { commands: [{ id: "greet" }] } },
      { "src/greet.ts": "x\n" }
    );

    expect(findTypeScriptCommandHandlers(workDir)).toEqual(["sample/valid: src/greet.ts"]);
  });
});

function writeManifest(dir, manifest) {
  writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest));
}

describe("guest runtime assets", () => {
  const SAMPLE_GUEST_ASSET = {
    id: "sample",
    entry: "electron/services/elementPicker/guest/sample.ts",
    outfile: "dist-electron/element-picker/guest/sample.js",
  };

  it("emits a browser IIFE, never a module or a named-function transform", () => {
    const config = guestRuntimeBuildConfig(SAMPLE_GUEST_ASSET);

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
    expect(guestRuntimeBuildConfig(SAMPLE_GUEST_ASSET).minify).toBe(false);
    expect(guestRuntimeBuildConfig(SAMPLE_GUEST_ASSET, { minify: true }).minify).toBe(true);
  });
});
