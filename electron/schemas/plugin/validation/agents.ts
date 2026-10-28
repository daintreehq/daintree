import { z } from "zod";
import { SAFE_ID_PATTERN } from "../../pluginIdentifiers.js";
import { AGENT_MCP_MAX_TOOLS_PER_ENDPOINT } from "../../../../shared/types/plugin.js";
import { isBuiltInAgentId } from "../../../../shared/config/agentIds.js";
import { PROCESS_TOOL_ICON_BY_COMMAND } from "../../../../shared/config/processToolRegistry.js";
import { AGENT_CLI_NAMES } from "../../../services/ProcessDetector/registries.js";
import { RESERVED_AGENT_MCP_TOOL_NAMES } from "../../../services/pluginAgentMcp/types.js";
import type { ManifestValidationContext } from "./context.js";
import type { ParsedPluginManifest } from "../manifestShape.js";

// `contributes.agents` registers a launchable agent CLI — gate it behind
// the explicit `agent:register` capability so the contribution is
// surfaced to the user at install time (#9560).
export function validateAgentRegistration(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { capabilities } = context;
  const agents = manifest.contributes.agents;
  if (agents.length > 0 && !capabilities.has("agent:register")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contributes", "agents"],
      message:
        'contributes.agents requires the "agent:register" capability to be declared in capabilities.',
      params: { errorCode: "agent_register_capability_required" },
    });
  }
}

// An agent-facing tools endpoint is a new way for a plugin's data to reach
// agents, so it is disclosed at install like any other capability. Unlike
// `mcpServers` it is allowed under `scope: "project"`: every credential for
// it is minted per terminal and bound to one project, so the surface has
// the project axis those registries lack.
export function validateAgentMcp(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { capabilities } = context;
  if (manifest.contributes.agentMcp.length > 0 && !capabilities.has("mcp:expose")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["contributes", "agentMcp"],
      message:
        'contributes.agentMcp requires the "mcp:expose" capability to be declared in capabilities.',
      params: { errorCode: "mcp_expose_capability_required" },
    });
  }

  // A bridged endpoint's roster is the manifest's allowlist, so every rule
  // registerTools enforces on names, groups and budget is checked here,
  // where an author sees it before any server runs.
  manifest.contributes.agentMcp.forEach((endpoint, endpointIndex) => {
    const source = endpoint.source;
    if (!source) return;
    const sourcePath = ["contributes", "agentMcp", endpointIndex, "source"] as const;
    if (!manifest.contributes.mcpServers.some((server) => server.id === source.mcpServer)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...sourcePath, "mcpServer"],
        message: `agentMcp source "${source.mcpServer}" matches no contributes.mcpServers[].id.`,
        params: { errorCode: "agent_mcp_source_unknown_server" },
      });
    }
    const declaredQueryNames = new Set(
      manifest.contributes.databases.flatMap((database) =>
        (database.queries ?? []).map((query) => query.name)
      )
    );
    if (source.tools.length + declaredQueryNames.size > AGENT_MCP_MAX_TOOLS_PER_ENDPOINT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...sourcePath, "tools"],
        message: `agentMcp source serves ${source.tools.length} tools beside the ${declaredQueryNames.size} database queries the manifest declares; a plugin may serve at most ${AGENT_MCP_MAX_TOOLS_PER_ENDPOINT} of the two together.`,
        params: { errorCode: "agent_mcp_source_too_many_tools" },
      });
    }
    const groupIds = new Set((endpoint.groups ?? []).map((group) => group.id));
    const names = new Set<string>();
    const serverTools = new Set<string>();
    source.tools.forEach((tool, toolIndex) => {
      const toolPath = [...sourcePath, "tools", toolIndex] as const;
      const issue = (field: string, message: string, errorCode: string) =>
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...toolPath, field],
          message,
          params: { errorCode },
        });
      if (names.has(tool.name)) {
        issue("name", `Tool name "${tool.name}" is served twice.`, "agent_mcp_source_duplicate");
      }
      names.add(tool.name);
      if (serverTools.has(tool.serverTool)) {
        issue(
          "serverTool",
          `Server tool "${tool.serverTool}" is selected twice.`,
          "agent_mcp_source_duplicate"
        );
      }
      serverTools.add(tool.serverTool);
      if (RESERVED_AGENT_MCP_TOOL_NAMES.has(tool.name) || declaredQueryNames.has(tool.name)) {
        issue(
          "name",
          `Tool name "${tool.name}" is taken by the host's database tools on this plugin's MCP server.`,
          "agent_mcp_source_reserved_name"
        );
      }
      if (groupIds.size === 0 && tool.group !== undefined) {
        issue(
          "group",
          `Tool "${tool.name}" names group "${tool.group}", but its endpoint declares no groups.`,
          "agent_mcp_source_group_unknown"
        );
      } else if (groupIds.size > 0 && (tool.group === undefined || !groupIds.has(tool.group))) {
        issue(
          "group",
          `Tool "${tool.name}" must name one of its endpoint's groups: ${[...groupIds].join(", ")}.`,
          "agent_mcp_source_group_unknown"
        );
      }
    });
  });
}

// Plugin agent IDs are additive for new IDs only — they may never shadow
// or patch a built-in agent.
export function validateAgentIds(manifest: ParsedPluginManifest, ctx: z.RefinementCtx): void {
  const agents = manifest.contributes.agents;
  agents.forEach((agent, index) => {
    if (isBuiltInAgentId(agent.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "agents", index, "id"],
        message: `Plugin agent id "${agent.id}" collides with a built-in agent — plugin agents must use new IDs.`,
        params: { errorCode: "agent_id_reserved" },
      });
    }
  });
}

// Plugin process-tool commands are additive for new commands only (#11613).
// A command already claimed by a built-in tool or by a built-in agent's CLI
// would never win at runtime — the detector merges built-ins over the plugin
// snapshot — so accepting it would register a detection that silently never
// fires. Reject at parse time, mirroring the agent-id reservation above.
// Cross-plugin collisions are deliberately NOT checked here: they resolve
// first-registered-wins at runtime, and a manifest cannot know what else is
// installed.
export function validateProcessTools(manifest: ParsedPluginManifest, ctx: z.RefinementCtx): void {
  const processTools = manifest.contributes.processTools;
  const seenProcessToolCommands = new Set<string>();
  processTools.forEach((tool, index) => {
    if (Object.hasOwn(PROCESS_TOOL_ICON_BY_COMMAND, tool.command)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "processTools", index, "command"],
        message: `Process-tool command "${tool.command}" collides with a built-in tool — plugin process tools must use new commands.`,
        params: { errorCode: "process_tool_command_reserved" },
      });
    } else if (Object.hasOwn(AGENT_CLI_NAMES, tool.command)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "processTools", index, "command"],
        message: `Process-tool command "${tool.command}" collides with a built-in agent CLI — plugin process tools must use new commands.`,
        params: { errorCode: "process_tool_command_reserved" },
      });
    }
    // A manifest declaring the same command twice is a typo, not a
    // precedence question — the registry's per-plugin map is last-wins, so
    // one of the two icons would silently disappear. Reject rather than
    // pick.
    if (seenProcessToolCommands.has(tool.command)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contributes", "processTools", index, "command"],
        message: `Duplicate process-tool command "${tool.command}" in this manifest.`,
        params: { errorCode: "process_tool_command_duplicate" },
      });
    }
    seenProcessToolCommands.add(tool.command);
  });
}

// Every `${settings:<id>}` token in an MCP server's command/args/env must
// name a declared setting — the supervisor substitutes only declared ids
// (`SETTINGS_TEMPLATE_RE` in PluginMcpSupervisor.ts) and an unknown id
// resolves to the empty string, silently dropping the value. Agent
// command/args also resolve `${settings:*}` at spawn (via
// `resolveSettingTemplate` in terminal/lifecycle.ts), but are deliberately
// NOT validated here — that path throws `SettingTemplateError` for an
// unset or empty value at launch, so this parse-time check stays scoped
// to MCP contributions. The
// scan matches any `${settings:...}` shape (broad inner pattern), then
// classifies: a key outside the `${SAFE_ID_PATTERN}` grammar is malformed
// (the supervisor's stricter regex would skip it, passing the literal
// token to exec); a well-formed key naming no setting is unknown.
export function validateMcpServerSettingsTokens(
  manifest: ParsedPluginManifest,
  ctx: z.RefinementCtx,
  context: ManifestValidationContext
): void {
  const { settingIds } = context;
  const settingsTokenRe = /\$\{settings:([^}]*)\}/g;
  const reportUnknownSettingsTokens = (text: string, path: (string | number)[]) => {
    for (const match of text.matchAll(settingsTokenRe)) {
      const key = match[1]!;
      if (!SAFE_ID_PATTERN.test(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `Malformed settings token "${match[0]}" — the setting id must match ${SAFE_ID_PATTERN.source}.`,
          params: { errorCode: "settings_token_malformed" },
        });
        continue;
      }
      if (!settingIds.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `Reference to undeclared setting "\${settings:${key}}" — no contributes.settings[].id matches "${key}".`,
          params: { errorCode: "settings_token_unknown" },
        });
      }
    }
  };
  manifest.contributes.mcpServers.forEach((server, index) => {
    reportUnknownSettingsTokens(server.command, ["contributes", "mcpServers", index, "command"]);
    server.args?.forEach((arg, argIndex) =>
      reportUnknownSettingsTokens(arg, ["contributes", "mcpServers", index, "args", argIndex])
    );
    for (const [envKey, envValue] of Object.entries(server.env ?? {})) {
      reportUnknownSettingsTokens(envValue, ["contributes", "mcpServers", index, "env", envKey]);
    }
  });
}
