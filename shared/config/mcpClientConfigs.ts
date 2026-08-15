/**
 * Connection configs handed to an external MCP client so it can reach
 * Daintree's local server.
 *
 * Both the URL a surface *displays* and the snippet it *copies* come from
 * `buildMcpClientConfig`, so the two can never drift — the settings tab used to
 * render a `/sse` URL beside a button that copied a `/mcp` snippet (#11535).
 *
 * `/mcp` (Streamable HTTP) is the only transport advertised here. `/sse` stays
 * live for legacy and in-app callers, but it was deprecated by the MCP spec in
 * revision 2025-03-26 and clients vary in whether they attach the auth header
 * to its separate POST leg, so no external client should be pointed at it.
 */

export const MCP_SERVER_KEY = "daintree";

/**
 * Canonical spelling of the header that binds a session to one workspace
 * (#11789). Lives beside the config builders because they are what a user
 * actually copies, and the server derives its (lower-cased) lookup key from
 * this — so the string a client is told to send and the string the server reads
 * cannot drift apart.
 *
 * External contract: renaming it breaks every config already in the wild.
 */
export const MCP_WORKSPACE_ID_HEADER = "Daintree-Workspace-Id";

export type McpClientConfigId = "claude-code" | "codex" | "streamable-http";

export type McpClientConfigLanguage = "json" | "toml" | "text";

export interface McpClientConfigInput {
  /** Live bound port, or null before the server has bound one. */
  port: number | null;
  /** Bearer token, or null/empty when no key is provisioned. */
  apiKey: string | null;
  /**
   * Opaque workspace id to bind the session to (#11789). When set, the snippet
   * carries a `Daintree-Workspace-Id` header, so every call from that client
   * routes to this workspace instead of following whichever Daintree window the
   * user last focused.
   *
   * Omitted by default, and omitting it leaves the generated snippet
   * byte-identical to what this module produced before workspace binding
   * existed — an unscoped config keeps the documented focus-following behaviour.
   */
  workspaceId?: string | null;
}

export interface McpClientConfigDescriptor {
  id: McpClientConfigId;
  label: string;
  language: McpClientConfigLanguage;
  /** Where the snippet goes, phrased for helper copy under a picker. */
  destination: string;
}

export interface BuiltMcpClientConfig extends McpClientConfigDescriptor {
  url: string;
  snippet: string;
}

export const MCP_CLIENT_CONFIGS: readonly McpClientConfigDescriptor[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    language: "json",
    destination: "Add to .mcp.json in your project, or ~/.claude.json for every project",
  },
  {
    id: "codex",
    label: "Codex",
    language: "toml",
    destination: "Add to ~/.codex/config.toml",
  },
  {
    id: "streamable-http",
    label: "Other client",
    language: "text",
    destination: "Enter these by hand in any Streamable HTTP client",
  },
];

const PORT_PLACEHOLDER = "<port>";

export function buildMcpServerUrl(port: number | null): string {
  return `http://127.0.0.1:${port ?? PORT_PLACEHOLDER}/mcp`;
}

function getDescriptor(id: McpClientConfigId): McpClientConfigDescriptor {
  const descriptor = MCP_CLIENT_CONFIGS.find((entry) => entry.id === id);
  if (!descriptor) {
    throw new Error(`Unknown MCP client config: ${id}`);
  }
  return descriptor;
}

/** Escape for a TOML basic string (the quoted form used by `http_headers`). */
function escapeTomlBasicString(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return out;
}

/**
 * `type: "http"` + a literal `Authorization` header — the shape
 * `claude mcp add --transport http … --header` writes. Verified against Claude
 * Code 2.1.220.
 *
 * Field order and 2-space indent are load-bearing: `HttpLifecycle.getConfigSnippet()`
 * delegates here, and its output is copied verbatim by the assistant settings tab.
 */
function buildClaudeCodeSnippet(
  url: string,
  apiKey: string | null,
  workspaceId: string | null
): string {
  const entry: Record<string, unknown> = { type: "http", url };
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (workspaceId) {
    headers[MCP_WORKSPACE_ID_HEADER] = workspaceId;
  }
  if (Object.keys(headers).length > 0) {
    entry.headers = headers;
  }
  return JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: entry } }, null, 2);
}

/**
 * A literal `http_headers` table rather than `bearer_token_env_var`, because the
 * key here is copy-pasted rather than injected: Daintree cannot reach the
 * environment of an external Codex process, and the key rotates from this same
 * tab, which would strand an exported variable. Verified against Codex CLI
 * 0.146.0, which reports `transport: streamable_http` for this shape.
 */
function buildCodexSnippet(url: string, apiKey: string | null, workspaceId: string | null): string {
  const lines = [`[mcp_servers.${MCP_SERVER_KEY}]`, `url = "${escapeTomlBasicString(url)}"`];
  const headers: string[] = [];
  if (apiKey) {
    headers.push(`Authorization = "Bearer ${escapeTomlBasicString(apiKey)}"`);
  }
  if (workspaceId) {
    // Quoted key: TOML bare keys allow dashes, but quoting keeps the header
    // spelling verbatim rather than relying on that.
    headers.push(`"${MCP_WORKSPACE_ID_HEADER}" = "${escapeTomlBasicString(workspaceId)}"`);
  }
  if (headers.length > 0) {
    lines.push(`http_headers = { ${headers.join(", ")} }`);
  }
  return lines.join("\n");
}

/** Transport-level truth for clients whose config format we haven't verified. */
function buildGenericSnippet(
  url: string,
  apiKey: string | null,
  workspaceId: string | null
): string {
  const lines = ["Transport: Streamable HTTP", `URL: ${url}`];
  if (apiKey) {
    lines.push(`Header: Authorization: Bearer ${apiKey}`);
  }
  if (workspaceId) {
    lines.push(`Header: ${MCP_WORKSPACE_ID_HEADER}: ${workspaceId}`);
  }
  return lines.join("\n");
}

export function buildMcpClientConfig(
  id: McpClientConfigId,
  input: McpClientConfigInput
): BuiltMcpClientConfig {
  const descriptor = getDescriptor(id);
  const url = buildMcpServerUrl(input.port);
  const apiKey = input.apiKey ? input.apiKey : null;
  const workspaceId = input.workspaceId ? input.workspaceId : null;

  const snippet =
    id === "claude-code"
      ? buildClaudeCodeSnippet(url, apiKey, workspaceId)
      : id === "codex"
        ? buildCodexSnippet(url, apiKey, workspaceId)
        : buildGenericSnippet(url, apiKey, workspaceId);

  return { ...descriptor, url, snippet };
}
