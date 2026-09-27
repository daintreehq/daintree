import type { LaunchMcpInjection } from "../../../shared/config/launchMcp.js";

/**
 * One MCP server a launch hands its agent, before it is written in any agent's
 * dialect. `bearer` is the literal credential; each format decides whether it
 * travels in a 0600 file or in the PTY env — never in argv.
 */
export interface LaunchMcpServer {
  /** Server name, `[A-Za-z0-9_-]` only — a bare TOML key and a safe JSON key. */
  key: string;
  /** Streamable HTTP endpoint (`/mcp` or a plugin route). */
  url: string;
  /** Claude reads the orchestration server over SSE; everything else is Streamable HTTP. */
  claudeSseUrl?: string;
  bearer: string;
  /** PTY env var that carries `bearer` for formats that read it from the env. */
  bearerEnvVar: string;
}

export interface RenderedLaunchMcp {
  /** File content to write (0600) before launch, or null when the format needs none. */
  file: string | null;
  /** Args appended to the agent command; `{file}` stands for the written file's path. */
  args: string[];
  /** Env merged into the PTY spawn env; `{file}` is substituted here too. */
  env: Record<string, string>;
}

export const LAUNCH_MCP_FILE_PLACEHOLDER = "{file}";

/**
 * What the agent would have read without Daintree, where a format replaces it
 * rather than adding to it — an admin's Gemini system defaults, an inherited
 * `OPENCODE_CONFIG_CONTENT`, an inherited `VIBE_MCP_SERVERS` list (as
 * `{ servers }`) — so the rendered config carries it forward, minus any
 * Daintree-owned entry. Resolved by the caller (`resolveLaunchMcpBase`).
 */
export type LaunchMcpBase = Record<string, unknown> | null;

const SERVER_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

function assertUnique(servers: readonly LaunchMcpServer[]): void {
  const keys = new Set<string>();
  const envVars = new Set<string>();
  for (const server of servers) {
    if (!SERVER_KEY_PATTERN.test(server.key)) {
      throw new Error(`Invalid MCP server key: ${server.key}`);
    }
    if (!ENV_VAR_PATTERN.test(server.bearerEnvVar)) {
      throw new Error(`Invalid MCP bearer env var: ${server.bearerEnvVar}`);
    }
    if (keys.has(server.key)) throw new Error(`Duplicate MCP server key: ${server.key}`);
    if (envVars.has(server.bearerEnvVar)) {
      throw new Error(`Duplicate MCP bearer env var: ${server.bearerEnvVar}`);
    }
    keys.add(server.key);
    envVars.add(server.bearerEnvVar);
  }
}

function authHeaders(server: LaunchMcpServer): { Authorization: string } {
  return { Authorization: `Bearer ${server.bearer}` };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** TOML basic string: JSON's escaping is a valid subset for the characters a URL or env name holds. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Daintree's own server names. One found in an inherited base came from an
 * earlier Daintree launch — another pane's, carrying that pane's bearer — so it
 * is dropped rather than carried into this launch.
 */
export function isDaintreeServerKey(key: string): boolean {
  return key === "daintree" || key.startsWith("daintree-");
}

/** `base` with `servers` merged into its `section` map, ours winning on a shared key. */
function withServers(
  base: LaunchMcpBase,
  section: string,
  servers: Record<string, unknown>
): Record<string, unknown> {
  const root = asObject(base);
  const inherited = Object.fromEntries(
    Object.entries(asObject(root[section])).filter(([key]) => !isDaintreeServerKey(key))
  );
  return { ...root, [section]: { ...inherited, ...servers } };
}

function fileFlag(flag: string, value: string, file: string): RenderedLaunchMcp {
  return { file, args: [flag, value], env: {} };
}

/**
 * Render the servers for one agent's launch format. Pure: the caller mints the
 * bearers, resolves `base`, writes `file` with owner-only permissions,
 * substitutes its path and shell-quotes each arg.
 */
export function renderLaunchMcp(
  injection: LaunchMcpInjection,
  servers: readonly LaunchMcpServer[],
  base: LaunchMcpBase = null
): RenderedLaunchMcp {
  assertUnique(servers);
  const map = (entry: (server: LaunchMcpServer) => unknown): Record<string, unknown> =>
    Object.fromEntries(servers.map((server) => [server.key, entry(server)]));

  switch (injection.format) {
    case "claude-mcp-config":
      // Literal bearers in the file: Claude's `${VAR}` header substitution
      // never reaches the wire (anthropics/claude-code#6204).
      return fileFlag(
        "--mcp-config",
        LAUNCH_MCP_FILE_PLACEHOLDER,
        json({
          mcpServers: map((server) =>
            server.claudeSseUrl
              ? { type: "sse", url: server.claudeSseUrl, headers: authHeaders(server) }
              : { type: "http", url: server.url, headers: authHeaders(server) }
          ),
        })
      );

    case "codex-config-overrides": {
      // A dotted `-c` key is its own config layer, merged table by table, so
      // the user's `mcp_servers` stay. Codex splits keys on `.` even inside
      // quotes, which is why keys are held to `[A-Za-z0-9_-]`.
      const args: string[] = [];
      const env: Record<string, string> = {};
      for (const server of servers) {
        env[server.bearerEnvVar] = server.bearer;
        args.push(
          "-c",
          `mcp_servers.${server.key}.url=${tomlString(server.url)}`,
          "-c",
          `mcp_servers.${server.key}.bearer_token_env_var=${tomlString(server.bearerEnvVar)}`
        );
      }
      return { file: null, args, env };
    }

    case "gemini-system-defaults":
      return {
        file: json(
          withServers(
            base,
            "mcpServers",
            map((server) => ({ type: "http", url: server.url, headers: authHeaders(server) }))
          )
        ),
        args: [],
        env: { [injection.envVar]: LAUNCH_MCP_FILE_PLACEHOLDER },
      };

    case "qwen-mcp-config":
      // In Qwen Code `url` means SSE; Streamable HTTP is `httpUrl`. The flag's
      // file does no env expansion, so the bearer is literal.
      return fileFlag(
        "--mcp-config",
        LAUNCH_MCP_FILE_PLACEHOLDER,
        json({
          mcpServers: map((server) => ({ httpUrl: server.url, headers: authHeaders(server) })),
        })
      );

    case "opencode-config-content": {
      // Merged field by field over the user's configs, so every field an
      // entry needs is spelled out: a same-named project entry cannot blend in.
      const config = withServers(
        base,
        "mcp",
        map((server) => ({
          type: "remote",
          url: server.url,
          enabled: true,
          oauth: false,
          headers: authHeaders(server),
        }))
      );
      return { file: null, args: [], env: { [injection.envVar]: JSON.stringify(config) } };
    }

    case "copilot-additional-mcp-config":
      return fileFlag(
        "--additional-mcp-config",
        `@${LAUNCH_MCP_FILE_PLACEHOLDER}`,
        json({
          mcpServers: map((server) => ({
            type: "http",
            url: server.url,
            headers: authHeaders(server),
            tools: ["*"],
          })),
        })
      );

    case "amp-mcp-config":
      // A bare server map; Amp rejects the `mcpServers` wrapper here.
      return fileFlag(
        "--mcp-config",
        LAUNCH_MCP_FILE_PLACEHOLDER,
        json(map((server) => ({ url: server.url, headers: authHeaders(server) })))
      );

    case "vibe-mcp-servers-env": {
      const env: Record<string, string> = {};
      const ours = new Set(servers.map((server) => server.key));
      const inherited = (
        Array.isArray(asObject(base).servers) ? (asObject(base).servers as unknown[]) : []
      ).filter((entry) => {
        const name = asObject(entry).name;
        return typeof name !== "string" || (!isDaintreeServerKey(name) && !ours.has(name));
      });
      const list = servers.map((server) => {
        env[server.bearerEnvVar] = server.bearer;
        return {
          name: server.key,
          transport: "streamable-http",
          url: server.url,
          auth: { type: "static", api_key_env: server.bearerEnvVar },
        };
      });
      return {
        file: null,
        args: [],
        env: { ...env, VIBE_MCP_SERVERS: JSON.stringify([...inherited, ...list]) },
      };
    }
  }
}
