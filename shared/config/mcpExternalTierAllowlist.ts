import type { BuiltInActionId } from "../types/actions.js";
import { ACTIONS_LIST_TOOL } from "./helpAssistantTierAllowlists.js";

/**
 * The one and only tool surface reachable by an `external` (api-key) MCP
 * session, and the sole seam for widening it — each entry is a deliberate,
 * individually vetted addition. There is no opt-in that lifts this floor: a
 * `fullToolSurface` flag used to short-circuit both tier gates and trust the
 * author-set `danger` / `mcpVisibility` fields as the ceiling, which exposed 335
 * of 426 actions to any api-key caller (#10701). The MCP spec is explicit that
 * tool annotations are untrusted UX hints, not an access-control boundary; this
 * server-side allowlist is the enforceable one. The flag was never reachable
 * from the UI or IPC and was removed outright in #11537 rather than left
 * dormant.
 *
 * This list is simultaneously the *advertised* and the *callable* external
 * contract: `tools/list` shows exactly these, and `tools/call` accepts exactly
 * these. Nothing is withheld from the listing while staying dispatchable —
 * #11582 tried that and it does not work, because no shipped client sends
 * `tools/call` for a name it never received (Claude Code builds its registry
 * from `tools/list` and rejects unlisted names before they become requests).
 *
 * The size is a hard product constraint, not a style preference (#11585). At 99
 * entries / ~128 KB of schema this surface was past what clients tolerate:
 * Cursor caps the tool count across all connected servers and silently
 * truncates the overflow, and GitHub Copilot's 128-tool cap is a hard blocking
 * error. Either way we were losing tools without controlling *which*. Selection
 * rule: keep what only Daintree can do — terminal and agent orchestration,
 * worktrees, recipes, skills, live IDE context — and drop what the caller can
 * already do for itself. An external agent driving us over MCP sits in a
 * terminal with its own shell and its own `gh`, so git plumbing, forge
 * reads/writes, file reads and project queries are its job, not ours. All of
 * that remains fully available to the in-app assistant via the
 * workbench/action/system tiers in `helpAssistantTierAllowlists.ts`, which no
 * third-party client cap applies to.
 *
 * Both the count and the summed description bytes are budgeted by
 * `actionDefinitions.quality.test.ts` — 24 tools carrying novel-length
 * descriptions would reproduce the same failure the count alone looks fine for.
 */
export const MCP_EXTERNAL_TIER_TOOLS = [
  ACTIONS_LIST_TOOL,
  "actions.getContext",
  "actions.search",
  "actions.getSchema",

  "agent.launch",
  // `agent.launch` accepts user- and plugin-contributed agent ids, and only
  // Daintree knows the authoritative effective registry and live launchability.
  // Not something the caller's shell can answer.
  "agent.listAvailable",

  // Read-only fleet-run supervision snapshot (#10930). The broadcast itself is
  // deliberately NOT exposed — external orchestrators fan out
  // `terminal.sendCommand` per terminal (see CLAUDE.tasks.md guidance).
  "fleet.getRunStatus",

  "recipe.list",
  "recipe.run",

  // Plugin-contributed skills are Daintree-owned data with no shell equivalent,
  // and the external-tier contract is pinned by an E2E
  // (e2e/full/plugins/core-plugin-skills.spec.ts).
  "skills.search",
  "skills.load",

  "terminal.list",
  "terminal.getOutput",
  "terminal.getStatus",
  "terminal.sendCommand",
  "terminal.inject",
  "terminal.new",
  // The one id this cut *adds* externally. Recoverable (moves the terminal to
  // trash) and already guarded against unbound agent dispatch by
  // `requireExplicitTerminalIdForAgentDispatch`, so it completes the terminal
  // lifecycle without `kill` / `closeAll` / `restart`, which stay internal.
  "terminal.close",
  "terminal.waitUntilIdle",
  "terminal.waitUntilIdleBatch",

  "worktree.list",
  "worktree.getCurrent",
  "worktree.createWithRecipe",
  "worktree.setActive",
] as const satisfies readonly BuiltInActionId[];
