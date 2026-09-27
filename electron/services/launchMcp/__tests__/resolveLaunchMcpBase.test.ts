import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  envValue,
  geminiSystemDefaultsPath,
  LaunchMcpBaseError,
  resolveLaunchMcpBase,
  stripJsonComments,
} from "../resolveLaunchMcpBase.js";

const GEMINI = {
  format: "gemini-system-defaults",
  envVar: "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
} as const;
const OPENCODE = { format: "opencode-config-content", envVar: "OPENCODE_CONFIG_CONTENT" } as const;
const VIBE = { format: "vibe-mcp-servers-env" } as const;

let dir: string;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "launch-mcp-base-"));
  return dir;
}

describe("resolveLaunchMcpBase", () => {
  it("carries forward the Gemini defaults file an inherited variable names, comments and all", async () => {
    const root = await tempDir();
    const file = path.join(root, "defaults.json");
    await fs.writeFile(
      file,
      '{\n  // the admin\'s server\n  "mcpServers": { "admin": { "url": "http://x//y" } } /* end */\n}'
    );

    await expect(
      resolveLaunchMcpBase(GEMINI, { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: file })
    ).resolves.toEqual({ mcpServers: { admin: { url: "http://x//y" } } });
  });

  it("resolves a relative path against the agent's working directory", async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, "d.json"), '{"general":{}}');

    await expect(
      resolveLaunchMcpBase(GEMINI, { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: "d.json" }, { cwd: root })
    ).resolves.toEqual({ general: {} });
  });

  it("finds the defaults beside an inherited system settings file", async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, "system-defaults.json"), '{"ui":{}}');

    await expect(
      resolveLaunchMcpBase(GEMINI, {
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(root, "settings.json"),
      })
    ).resolves.toEqual({ ui: {} });
  });

  it("never takes another Daintree pane's file as the user's defaults", async () => {
    const root = await tempDir();
    const managedDir = path.join(root, "mcp-pane-configs");
    await fs.mkdir(managedDir);
    await fs.writeFile(path.join(managedDir, "other-pane.json"), '{"mcpServers":{}}');

    await expect(
      resolveLaunchMcpBase(
        GEMINI,
        { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: path.join(managedDir, "other-pane.json") },
        { managedDir, platform: "linux" }
      )
    ).resolves.toBeNull();
  });

  it("is null when there is nothing to carry forward", async () => {
    await expect(
      resolveLaunchMcpBase(GEMINI, {
        GEMINI_CLI_SYSTEM_DEFAULTS_PATH: "/nonexistent/defaults.json",
      })
    ).resolves.toBeNull();
    await expect(resolveLaunchMcpBase(OPENCODE, {})).resolves.toBeNull();
    await expect(
      resolveLaunchMcpBase({ format: "codex-config-overrides" }, {})
    ).resolves.toBeNull();
  });

  it("refuses rather than hides configuration it cannot carry forward", async () => {
    const root = await tempDir();
    const file = path.join(root, "bad.json");
    await fs.writeFile(file, "{ not json");

    await expect(
      resolveLaunchMcpBase(GEMINI, { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: file })
    ).rejects.toBeInstanceOf(LaunchMcpBaseError);
    await expect(
      resolveLaunchMcpBase(OPENCODE, { OPENCODE_CONFIG_CONTENT: "[1,2]" })
    ).rejects.toBeInstanceOf(LaunchMcpBaseError);
    await expect(resolveLaunchMcpBase(VIBE, { VIBE_MCP_SERVERS: "{}" })).rejects.toBeInstanceOf(
      LaunchMcpBaseError
    );
  });

  it("parses an inherited OPENCODE_CONFIG_CONTENT and VIBE_MCP_SERVERS", async () => {
    await expect(
      resolveLaunchMcpBase(OPENCODE, { OPENCODE_CONFIG_CONTENT: '{"theme":"x"}' })
    ).resolves.toEqual({ theme: "x" });
    await expect(
      resolveLaunchMcpBase(VIBE, { VIBE_MCP_SERVERS: '[{"name":"mine"}]' })
    ).resolves.toEqual({ servers: [{ name: "mine" }] });
  });

  it("reads env keys case-insensitively on Windows only", () => {
    const env = { opencode_config_content: "{}" };
    expect(envValue(env, "OPENCODE_CONFIG_CONTENT", "win32")).toBe("{}");
    expect(envValue(env, "OPENCODE_CONFIG_CONTENT", "linux")).toBeUndefined();
  });

  it("strips comments but never inside strings", () => {
    expect(stripJsonComments('{"a":"//not","b":1} // gone')).toBe('{"a":"//not","b":1} ');
    expect(stripJsonComments('{"a":"x\\"/*y*/"}/*z*/')).toBe('{"a":"x\\"/*y*/"}');
    expect(() => stripJsonComments('{"a":1} /* never closed')).toThrow(/unterminated/);
  });

  it("knows each platform's admin defaults file", () => {
    expect(geminiSystemDefaultsPath("darwin")).toBe(
      "/Library/Application Support/GeminiCli/system-defaults.json"
    );
    expect(geminiSystemDefaultsPath("linux")).toBe("/etc/gemini-cli/system-defaults.json");
    expect(geminiSystemDefaultsPath("win32")).toBe(
      "C:\\ProgramData\\gemini-cli\\system-defaults.json"
    );
  });
});
