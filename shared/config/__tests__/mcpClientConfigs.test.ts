import { describe, it, expect } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  MCP_CLIENT_CONFIGS,
  buildMcpClientConfig,
  buildMcpServerUrl,
  type McpClientConfigId,
} from "../mcpClientConfigs";

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
      expect(built.snippet).not.toContain("null");
      expect(built.snippet).not.toContain("undefined");
    });
  });

  it("emits claude code json that parses to a bearer-authed http server entry", () => {
    const built = buildMcpClientConfig("claude-code", READY);
    const parsed = JSON.parse(built.snippet) as {
      mcpServers: Record<string, { type: string; url: string; headers?: Record<string, string> }>;
    };
    const entry = parsed.mcpServers.daintree;
    expect(entry.type).toBe("http");
    expect(entry.url).toBe(built.url);
    expect(entry.headers?.Authorization).toBe(`Bearer ${READY.apiKey}`);
  });

  it("drops the headers key rather than emitting an empty object when unauthed", () => {
    const parsed = JSON.parse(
      buildMcpClientConfig("claude-code", { port: 9020, apiKey: null }).snippet
    ) as { mcpServers: Record<string, Record<string, unknown>> };
    expect("headers" in parsed.mcpServers.daintree).toBe(false);
  });

  it("emits codex toml that parses to the same url and bearer", () => {
    const built = buildMcpClientConfig("codex", READY);
    const parsed = parseToml(built.snippet) as {
      mcp_servers: Record<string, { url: string; http_headers?: Record<string, string> }>;
    };
    const entry = parsed.mcp_servers.daintree;
    expect(entry.url).toBe(built.url);
    expect(entry.http_headers?.Authorization).toBe(`Bearer ${READY.apiKey}`);
  });

  it("escapes a key containing toml string metacharacters", () => {
    const nasty = 'key"with\\quotes';
    const built = buildMcpClientConfig("codex", { port: 9020, apiKey: nasty });
    const parsed = parseToml(built.snippet) as {
      mcp_servers: Record<string, { http_headers?: Record<string, string> }>;
    };
    expect(parsed.mcp_servers.daintree.http_headers?.Authorization).toBe(`Bearer ${nasty}`);
  });

  it("emits generic connection details as parseable label/value lines", () => {
    const built = buildMcpClientConfig("streamable-http", READY);
    const fields = new Map(
      built.snippet.split("\n").map((line) => {
        const separator = line.indexOf(":");
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      })
    );
    expect(fields.get("URL")).toBe(built.url);
    expect(fields.get("Header")).toBe(`Authorization: Bearer ${READY.apiKey}`);
  });
});
