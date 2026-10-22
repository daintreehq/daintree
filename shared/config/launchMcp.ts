/**
 * How an agent CLI is handed Daintree's MCP servers at launch — the
 * orchestration server when the project's tier is not `off`, and every plugin
 * endpoint the project turned on — declared per agent in its registry entry
 * (`capabilities.launchMcp`). Each format is a mechanism the CLI itself merges
 * over the user's own servers, so nothing the user configured is replaced, and
 * none writes into the user's agent config or the repository: a file, when one
 * is needed, is written 0600 under Daintree's userData and deleted when the PTY
 * exits. Bearers travel in that file or in the PTY env, never in argv.
 *
 * - `claude-mcp-config`: `--mcp-config <file>` (`mcpServers`, literal bearers).
 * - `codex-config-overrides`: `-c mcp_servers.<key>.…` overrides; each bearer is
 *   read from the PTY env through `bearer_token_env_var`.
 * - `gemini-system-defaults`: a settings file named by `envVar`, loaded as the
 *   lowest-precedence layer, whose `mcpServers` merge by name. An admin's own
 *   system-defaults file is carried into it, since the variable replaces it.
 * - `qwen-mcp-config`: `--mcp-config <file>` in Qwen Code's dialect (`httpUrl`).
 * - `opencode-config-content`: inline config JSON in `envVar`, deep-merged over
 *   every config file; an inherited value is carried into it.
 * - `copilot-additional-mcp-config`: `--additional-mcp-config @<file>`.
 * - `amp-mcp-config`: `--mcp-config <file>` holding a bare server map.
 * - `vibe-mcp-servers-env`: `VIBE_MCP_SERVERS` JSON, bearers read from the env.
 */
export type LaunchMcpInjection =
  | { format: "claude-mcp-config" }
  | { format: "codex-config-overrides" }
  | { format: "gemini-system-defaults"; envVar: string }
  | { format: "qwen-mcp-config" }
  | { format: "opencode-config-content"; envVar: string }
  | { format: "copilot-additional-mcp-config" }
  | { format: "amp-mcp-config" }
  | { format: "vibe-mcp-servers-env" };

export type LaunchMcpFormat = LaunchMcpInjection["format"];

export const LAUNCH_MCP_FORMATS = [
  "claude-mcp-config",
  "codex-config-overrides",
  "gemini-system-defaults",
  "qwen-mcp-config",
  "opencode-config-content",
  "copilot-additional-mcp-config",
  "amp-mcp-config",
  "vibe-mcp-servers-env",
] as const satisfies readonly LaunchMcpFormat[];

/**
 * The one environment variable each env-carrying format writes. Built-in
 * entries and plugin-contributed agents both take it from here, so a manifest
 * never names a variable on the spawned PTY.
 */
export const LAUNCH_MCP_ENV_VARS = {
  "gemini-system-defaults": "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
  "opencode-config-content": "OPENCODE_CONFIG_CONTENT",
} as const;

export function buildLaunchMcpInjection(format: LaunchMcpFormat): LaunchMcpInjection {
  switch (format) {
    case "gemini-system-defaults":
    case "opencode-config-content":
      return { format, envVar: LAUNCH_MCP_ENV_VARS[format] };
    default:
      return { format };
  }
}
