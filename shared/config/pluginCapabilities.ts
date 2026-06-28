import type { BuiltInPluginCapability } from "../types/plugin.js";

/**
 * Single source of truth for the plugin capabilities that grant irreversible or
 * hard-to-undo side effects: arbitrary process execution, git history mutation,
 * project/user-config filesystem writes, and agent invocation/registration.
 *
 * Two subsystems classify "is this capability high-risk" and must agree, so the
 * set lives here rather than being declared twice:
 *
 * 1. **Action danger elevation** (`PluginService`) — any action a plugin
 *    contributes is forced up to `effectiveDanger: "confirm"` if the plugin
 *    declares one of these, regardless of the `danger` it self-declared. The
 *    host may only raise danger, never lower it.
 * 2. **MCP tier cap** (`PluginMcpTierAuth`) — a plugin's MCP tool surface can
 *    only *reach* the D2 ("shared-state mutation") confirmation tier if the
 *    plugin declares one of these. A call whose annotation floor exceeds the
 *    cap is denied, not silently downgraded.
 *
 * Read-only or trivially-reversible capabilities (`*-read`, `network:fetch`,
 * `clipboard:*`) are intentionally excluded — promoting on those would
 * over-confirm and train users to dismiss the dialog.
 */
export const CONFIRM_TRIGGERING_CAPABILITIES: ReadonlySet<BuiltInPluginCapability> = new Set([
  "shell:exec",
  "git:write",
  "fs:project-write",
  "fs:user-data-write",
  "agent:invoke",
  // Registering a launchable agent CLI (with its own command/args, and a
  // detection config in the full tier) is a runtime side effect on par with
  // `agent:invoke` — a plugin holding it elevates its actions to "confirm" and
  // entitles its MCP tool surface to reach D2.
  "agent:register",
  // Injecting text into a live agent session (`host.sendToActiveAgent`) drives
  // the agent — even the stage-only default places text in its input — so it
  // ranks with `agent:invoke`: actions elevate to "confirm" and the MCP tool
  // surface may reach D2 (#10558).
  "agent:input",
]);
