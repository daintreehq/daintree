import { describe, expect, it } from "vitest";
import {
  LAUNCH_MCP_FILE_PLACEHOLDER,
  renderLaunchMcp,
  type LaunchMcpServer,
} from "../renderLaunchMcp.js";

const DAINTREE: LaunchMcpServer = {
  key: "daintree",
  url: "http://127.0.0.1:4000/mcp",
  claudeSseUrl: "http://127.0.0.1:4000/sse",
  bearer: "orchestration-bearer",
  bearerEnvVar: "DAINTREE_MCP_TOKEN",
};
const LEDGER: LaunchMcpServer = {
  key: "daintree-acme_ledger-_databases",
  url: "http://127.0.0.1:4000/mcp/plugin/acme.ledger/%40databases",
  bearer: "plugin-bearer",
  bearerEnvVar: "DAINTREE_PLUGIN_MCP_TOKEN_1",
};

describe("renderLaunchMcp", () => {
  it("writes Claude a --mcp-config file, SSE for the orchestration server and HTTP for plugins", () => {
    const rendered = renderLaunchMcp({ format: "claude-mcp-config" }, [DAINTREE, LEDGER]);

    expect(rendered.args).toEqual(["--mcp-config", LAUNCH_MCP_FILE_PLACEHOLDER]);
    expect(rendered.env).toEqual({});
    expect(JSON.parse(rendered.file!)).toEqual({
      mcpServers: {
        daintree: {
          type: "sse",
          url: "http://127.0.0.1:4000/sse",
          headers: { Authorization: "Bearer orchestration-bearer" },
        },
        "daintree-acme_ledger-_databases": {
          type: "http",
          url: LEDGER.url,
          headers: { Authorization: "Bearer plugin-bearer" },
        },
      },
    });
  });

  it("gives Codex -c overrides that read each bearer from the env, never from argv", () => {
    const rendered = renderLaunchMcp({ format: "codex-config-overrides" }, [DAINTREE, LEDGER]);

    expect(rendered.file).toBeNull();
    expect(rendered.args).toEqual([
      "-c",
      'mcp_servers.daintree.url="http://127.0.0.1:4000/mcp"',
      "-c",
      'mcp_servers.daintree.bearer_token_env_var="DAINTREE_MCP_TOKEN"',
      "-c",
      `mcp_servers.daintree-acme_ledger-_databases.url="${LEDGER.url}"`,
      "-c",
      'mcp_servers.daintree-acme_ledger-_databases.bearer_token_env_var="DAINTREE_PLUGIN_MCP_TOKEN_1"',
    ]);
    expect(rendered.args.join(" ")).not.toContain("orchestration-bearer");
    expect(rendered.args.join(" ")).not.toContain("plugin-bearer");
    expect(rendered.env).toEqual({
      DAINTREE_MCP_TOKEN: "orchestration-bearer",
      DAINTREE_PLUGIN_MCP_TOKEN_1: "plugin-bearer",
    });
  });

  it("refuses a key that is not a bare TOML key, or a duplicate", () => {
    expect(() =>
      renderLaunchMcp({ format: "codex-config-overrides" }, [{ ...LEDGER, key: "a.b" }])
    ).toThrow(/Invalid MCP server key/);
    expect(() =>
      renderLaunchMcp({ format: "codex-config-overrides" }, [LEDGER, { ...LEDGER }])
    ).toThrow(/Duplicate MCP server key/);
    expect(() =>
      renderLaunchMcp({ format: "codex-config-overrides" }, [
        { ...LEDGER, bearerEnvVar: "lower-case" },
      ])
    ).toThrow(/Invalid MCP bearer env var/);
  });

  it("renders nothing to connect to for an empty server list, in every format", () => {
    expect(renderLaunchMcp({ format: "codex-config-overrides" }, [])).toEqual({
      file: null,
      args: [],
      env: {},
    });
  });

  it("writes Gemini a system-defaults file over the admin's own, named by its env var", () => {
    const rendered = renderLaunchMcp(
      { format: "gemini-system-defaults", envVar: "GEMINI_CLI_SYSTEM_DEFAULTS_PATH" },
      [LEDGER],
      { general: { vimMode: true }, mcpServers: { admin: { command: "admin-mcp" } } }
    );

    expect(rendered.args).toEqual([]);
    expect(rendered.env).toEqual({ GEMINI_CLI_SYSTEM_DEFAULTS_PATH: LAUNCH_MCP_FILE_PLACEHOLDER });
    expect(JSON.parse(rendered.file!)).toEqual({
      general: { vimMode: true },
      mcpServers: {
        admin: { command: "admin-mcp" },
        [LEDGER.key]: {
          type: "http",
          url: LEDGER.url,
          headers: { Authorization: "Bearer plugin-bearer" },
        },
      },
    });
  });

  it("writes Qwen Code's dialect, where Streamable HTTP is httpUrl", () => {
    const rendered = renderLaunchMcp({ format: "qwen-mcp-config" }, [LEDGER]);

    expect(rendered.args).toEqual(["--mcp-config", LAUNCH_MCP_FILE_PLACEHOLDER]);
    expect(JSON.parse(rendered.file!).mcpServers[LEDGER.key]).toEqual({
      httpUrl: LEDGER.url,
      headers: { Authorization: "Bearer plugin-bearer" },
    });
  });

  it("gives opencode every field inline, merged over an inherited config", () => {
    const rendered = renderLaunchMcp(
      { format: "opencode-config-content", envVar: "OPENCODE_CONFIG_CONTENT" },
      [LEDGER],
      { theme: "tokyonight", mcp: { mine: { type: "local", command: ["x"] } } }
    );

    expect(rendered.file).toBeNull();
    expect(rendered.args).toEqual([]);
    expect(JSON.parse(rendered.env.OPENCODE_CONFIG_CONTENT)).toEqual({
      theme: "tokyonight",
      mcp: {
        mine: { type: "local", command: ["x"] },
        [LEDGER.key]: {
          type: "remote",
          url: LEDGER.url,
          enabled: true,
          oauth: false,
          headers: { Authorization: "Bearer plugin-bearer" },
        },
      },
    });
  });

  it("hands Copilot a file with @, never the JSON inline where ps would show the bearer", () => {
    const rendered = renderLaunchMcp({ format: "copilot-additional-mcp-config" }, [LEDGER]);

    expect(rendered.args).toEqual(["--additional-mcp-config", `@${LAUNCH_MCP_FILE_PLACEHOLDER}`]);
    expect(JSON.parse(rendered.file!).mcpServers[LEDGER.key]).toEqual({
      type: "http",
      url: LEDGER.url,
      headers: { Authorization: "Bearer plugin-bearer" },
      tools: ["*"],
    });
  });

  it("hands Amp a bare server map, which is the only shape its flag accepts", () => {
    const rendered = renderLaunchMcp({ format: "amp-mcp-config" }, [LEDGER]);

    expect(rendered.args).toEqual(["--mcp-config", LAUNCH_MCP_FILE_PLACEHOLDER]);
    expect(JSON.parse(rendered.file!)).toEqual({
      [LEDGER.key]: { url: LEDGER.url, headers: { Authorization: "Bearer plugin-bearer" } },
    });
  });

  it("gives Mistral Vibe its servers in the env, each reading its bearer from another variable", () => {
    const rendered = renderLaunchMcp({ format: "vibe-mcp-servers-env" }, [DAINTREE, LEDGER]);

    expect(rendered.file).toBeNull();
    expect(JSON.parse(rendered.env.VIBE_MCP_SERVERS)).toEqual([
      {
        name: "daintree",
        transport: "streamable-http",
        url: DAINTREE.url,
        auth: { type: "static", api_key_env: "DAINTREE_MCP_TOKEN" },
      },
      {
        name: LEDGER.key,
        transport: "streamable-http",
        url: LEDGER.url,
        auth: { type: "static", api_key_env: "DAINTREE_PLUGIN_MCP_TOKEN_1" },
      },
    ]);
    expect(rendered.env.VIBE_MCP_SERVERS).not.toContain("plugin-bearer");
    expect(rendered.env.DAINTREE_PLUGIN_MCP_TOKEN_1).toBe("plugin-bearer");
  });

  it("never puts a bearer in argv, in any format", () => {
    const formats = [
      { format: "claude-mcp-config" },
      { format: "codex-config-overrides" },
      { format: "gemini-system-defaults", envVar: "GEMINI_CLI_SYSTEM_DEFAULTS_PATH" },
      { format: "qwen-mcp-config" },
      { format: "opencode-config-content", envVar: "OPENCODE_CONFIG_CONTENT" },
      { format: "copilot-additional-mcp-config" },
      { format: "amp-mcp-config" },
      { format: "vibe-mcp-servers-env" },
    ] as const;
    for (const injection of formats) {
      const { args } = renderLaunchMcp(injection, [DAINTREE, LEDGER]);
      expect(args.join(" "), injection.format).not.toMatch(/orchestration-bearer|plugin-bearer/);
    }
  });

  it("drops an inherited Daintree-owned server, which carries another pane's bearer", () => {
    const gemini = renderLaunchMcp(
      { format: "gemini-system-defaults", envVar: "GEMINI_CLI_SYSTEM_DEFAULTS_PATH" },
      [LEDGER],
      { mcpServers: { daintree: { url: "old" }, "daintree-old": { url: "old" }, admin: {} } }
    );
    expect(Object.keys(JSON.parse(gemini.file!).mcpServers).sort()).toEqual(
      ["admin", LEDGER.key].sort()
    );

    const vibe = renderLaunchMcp({ format: "vibe-mcp-servers-env" }, [LEDGER], {
      servers: [{ name: "mine" }, { name: "daintree" }, { name: LEDGER.key, url: "stale" }],
    });
    expect(JSON.parse(vibe.env.VIBE_MCP_SERVERS).map((s: { name: string }) => s.name)).toEqual([
      "mine",
      LEDGER.key,
    ]);
  });

  it("refuses two servers reading one bearer variable", () => {
    expect(() =>
      renderLaunchMcp({ format: "codex-config-overrides" }, [LEDGER, { ...LEDGER, key: "other" }])
    ).toThrow(/Duplicate MCP bearer env var/);
  });

  it("escapes a URL for TOML the way it escapes JSON", () => {
    const rendered = renderLaunchMcp({ format: "codex-config-overrides" }, [
      { ...LEDGER, url: 'http://127.0.0.1:4000/mcp/plugin/a%22b/"x"' },
    ]);
    expect(rendered.args[1]).toBe(
      `mcp_servers.${LEDGER.key}.url="http://127.0.0.1:4000/mcp/plugin/a%22b/\\"x\\""`
    );
  });
});
