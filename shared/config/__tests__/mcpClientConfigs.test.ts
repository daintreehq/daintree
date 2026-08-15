import { describe, it, expect } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  MCP_CLIENT_CONFIGS,
  buildMcpClientConfig,
  buildMcpServerUrl,
  MCP_WORKSPACE_ID_HEADER,
  type McpClientConfigId,
} from "../mcpClientConfigs.js";

const ALL_IDS = MCP_CLIENT_CONFIGS.map((entry) => entry.id);

const READY = { port: 9020, apiKey: "dnt-key-abc123" };

describe("mcpClientConfigs", () => {
  it("registers each client id exactly once", () => {
    expect(new Set(ALL_IDS).size).toBe(ALL_IDS.length);
  });

  it("rejects an unregistered client id", () => {
    expect(() => buildMcpClientConfig("cursor" as McpClientConfigId, READY)).toThrow(/cursor/);
  });

  describe.each(ALL_IDS)("%s", (id) => {
    it("embeds the same url it reports, at the supplied port", () => {
      const built = buildMcpClientConfig(id, READY);
      expect(built.url).toBe(buildMcpServerUrl(READY.port));
      expect(built.url).toContain(`:${READY.port}/`);
      // The drift this whole module exists to prevent (#11535): the URL a
      // surface displays must be the one inside the snippet it copies.
      expect(built.snippet).toContain(built.url);
    });

    it("advertises streamable http, never the deprecated sse transport", () => {
      const built = buildMcpClientConfig(id, READY);
      expect(built.url.endsWith("/mcp")).toBe(true);
      expect(built.snippet).not.toContain("/sse");
    });

    it("carries the api key when one exists", () => {
      const built = buildMcpClientConfig(id, READY);
      expect(built.snippet).toContain(`Bearer ${READY.apiKey}`);
    });

    it("omits auth entirely rather than emitting an empty bearer", () => {
      const built = buildMcpClientConfig(id, { port: 9020, apiKey: null });
      expect(built.snippet).not.toContain("Bearer");
      expect(built.snippet).not.toContain("Authorization");
    });

    it("falls back to a port placeholder before the server binds", () => {
      const built = buildMcpClientConfig(id, { port: null, apiKey: READY.apiKey });
      expect(built.url).toContain("<port>");
      expect(built.snippet).toContain(built.url);
      expect(built.snippet).not.toContain("null");
      expect(built.snippet).not.toContain("undefined");
    });

    it("normalizes an empty key the same as no key", () => {
      const empty = buildMcpClientConfig(id, { port: 9020, apiKey: "" });
      const absent = buildMcpClientConfig(id, { port: 9020, apiKey: null });
      expect(empty.snippet).toBe(absent.snippet);
    });
  });

  it("emits claude code json that parses to a bearer-authed http server entry", () => {
    const built = buildMcpClientConfig("claude-code", READY);
    const parsed: unknown = JSON.parse(built.snippet);
    expect(parsed).toMatchObject({
      mcpServers: {
        daintree: {
          type: "http",
          url: built.url,
          headers: { Authorization: `Bearer ${READY.apiKey}` },
        },
      },
    });
  });

  it("drops the headers key rather than emitting an empty object when unauthed", () => {
    const { snippet } = buildMcpClientConfig("claude-code", { port: 9020, apiKey: null });
    const parsed: unknown = JSON.parse(snippet);
    expect(parsed).toMatchObject({ mcpServers: { daintree: { type: "http" } } });
    expect(snippet).not.toContain("headers");
  });

  it("emits codex toml that parses to the same url and bearer", () => {
    const built = buildMcpClientConfig("codex", READY);
    const parsed: unknown = parseToml(built.snippet);
    expect(parsed).toMatchObject({
      mcp_servers: {
        daintree: {
          url: built.url,
          http_headers: { Authorization: `Bearer ${READY.apiKey}` },
        },
      },
    });
  });

  it("escapes a key containing toml string metacharacters", () => {
    const nasty = 'key"with\\quotes';
    const built = buildMcpClientConfig("codex", { port: 9020, apiKey: nasty });
    const parsed: unknown = parseToml(built.snippet);
    expect(parsed).toMatchObject({
      mcp_servers: { daintree: { http_headers: { Authorization: `Bearer ${nasty}` } } },
    });
  });

  it("emits generic connection details as parseable label/value lines", () => {
    const built = buildMcpClientConfig("streamable-http", READY);
    const fields = new Map(
      built.snippet.split("\n").map((line) => {
        const separator = line.indexOf(":");
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      })
    );
    expect(fields.get("Transport")).toBe("Streamable HTTP");
    expect(fields.get("URL")).toBe(built.url);
    expect(fields.get("Header")).toBe(`Authorization: Bearer ${READY.apiKey}`);
  });
});

describe("workspace-scoped configs (#11789)", () => {
  const SCOPED = { ...READY, workspaceId: "ws-abc123" };

  describe.each(ALL_IDS)("%s", (id) => {
    it("carries the workspace header when scoped", () => {
      const { snippet } = buildMcpClientConfig(id, SCOPED);
      expect(snippet).toContain(MCP_WORKSPACE_ID_HEADER);
      expect(snippet).toContain("ws-abc123");
    });

    it.each([undefined, null, ""])(
      "produces the pre-binding snippet byte-for-byte when workspaceId is %o",
      (workspaceId) => {
        // An unscoped copy must keep working exactly as it did — the binding is
        // opt-in, and a silent change here would rebind every existing user.
        expect(buildMcpClientConfig(id, { ...READY, workspaceId }).snippet).toBe(
          buildMcpClientConfig(id, READY).snippet
        );
      }
    );

    it("keeps the Authorization header alongside the workspace one", () => {
      const { snippet } = buildMcpClientConfig(id, SCOPED);
      expect(snippet).toContain("Bearer dnt-key-abc123");
    });

    it("scopes without an api key too", () => {
      const { snippet } = buildMcpClientConfig(id, { ...SCOPED, apiKey: null });
      expect(snippet).toContain("ws-abc123");
      expect(snippet).not.toContain("Bearer");
    });
  });

  it("emits parseable JSON for Claude Code with both headers", () => {
    const { snippet } = buildMcpClientConfig("claude-code", SCOPED);
    const parsed = JSON.parse(snippet) as {
      mcpServers: { daintree: { headers: Record<string, string> } };
    };
    expect(parsed.mcpServers.daintree.headers).toEqual({
      Authorization: "Bearer dnt-key-abc123",
      [MCP_WORKSPACE_ID_HEADER]: "ws-abc123",
    });
  });

  it("emits parseable TOML for Codex with both headers", () => {
    const { snippet } = buildMcpClientConfig("codex", SCOPED);
    const parsed = parseToml(snippet) as {
      mcp_servers: { daintree: { http_headers: Record<string, string> } };
    };
    expect(parsed.mcp_servers.daintree.http_headers).toEqual({
      Authorization: "Bearer dnt-key-abc123",
      [MCP_WORKSPACE_ID_HEADER]: "ws-abc123",
    });
  });

  it("escapes a workspace id containing TOML-significant characters", () => {
    const { snippet } = buildMcpClientConfig("codex", { ...SCOPED, workspaceId: 'ws"a\\b' });
    const parsed = parseToml(snippet) as {
      mcp_servers: { daintree: { http_headers: Record<string, string> } };
    };
    expect(parsed.mcp_servers.daintree.http_headers[MCP_WORKSPACE_ID_HEADER]).toBe('ws"a\\b');
  });
});
