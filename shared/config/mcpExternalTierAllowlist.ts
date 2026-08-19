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
 * The size is a hard product constraint, not a style preference (#11585). At 100
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
 * Budgeted in both dimensions, because the failure is measured in bytes as much
 * as in tools: the count ceiling lives in `tierAuth.test.ts` (against
 * `TIER_ALLOWLISTS.external`, the actual gate) and the summed description bytes
 * in `actionDefinitions.quality.test.ts` (where the live registry text is
 * reachable). 23 tools carrying novel-length descriptions would reproduce the
 * same truncation with a count that still looks fine.
 */
export const MCP_EXTERNAL_TIER_TOOLS = [
  ACTIONS_LIST_TOOL,
  "actions.getContext",
  "actions.search",
  "actions.getSchema",
  // Only Daintree can answer what its own surface currently is, and this caller
  // class needs it most: the external contract is the one that just shrank from
  // 100 tools to this list, and a third-party client written against the old
  // shape has no other way to find out (#11549).
  "mcp.surface",

  "agent.launch",
  // `agent.launch` accepts user- and plugin-contributed agent ids, and only
  // Daintree knows the authoritative effective registry and live launchability.
  // Not something the caller's shell can answer.
  "agent.listAvailable",
  // The same argument one step further in: launching also takes a preset id,
  // and those ids are generated rather than guessable. They come from user
  // settings, `.daintree/presets/` files and CCR discovery, merged with a
  // precedence only Daintree applies, so no shell command reconstructs the
  // list. Without it the preset argument is undiscoverable from out here — the
  // caller's only route today is reading an id off a panel already running one
  // (#11859). Identity only: no env, args or flags at any redaction level.
  "agent.listPresets",

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
  // `terminal.close` is deliberately NOT here, though #11540's draft core set
  // included it. The argument for it was that closing is recoverable, so an
  // orchestrator that opens terminals should be able to close them. That does
  // not survive contact with this caller class: `terminal.list` enumerates every
  // panel in the view — the user's own shells and other agents' terminals
  // included — and nothing binds a panel to the session that created it, so
  // "close the ones it opened" is not an invariant we actually have. Recovery is
  // worse: trash is purged after TRASH_TTL_MS (20s), which kills the PTY, and no
  // restore action is on this surface. Adding it back needs session-scoped panel
  // ownership first, not just an id argument.
  "terminal.waitUntilIdle",
  "terminal.waitUntilIdleBatch",

  "worktree.list",
  "worktree.getCurrent",
  "worktree.createWithRecipe",
  "worktree.setActive",

  // A deliberate product exception rather than a clean pass of the rule above,
  // so it is worth stating the reasoning plainly. A caller holding
  // `terminal.sendCommand` could pipe files through `pbcopy` itself, so this is
  // not a capability it categorically lacks. What it cannot reproduce is the
  // actual deliverable: one call that applies the project's own CopyTree policy
  // (ignore rules, budgets, format) and puts a FILE on the clipboard the same
  // way across macOS, Linux and Windows. The alternative is a brittle
  // shell-and-pipe reconstruction per platform. Without the entry the feature
  // only half exists — the in-app assistant reaches it through the system tier
  // while Claude Code and Codex, the callers #11722 names, cannot.
  //
  // Its blast radius is a clipboard overwrite, which `actionRiskBand` already
  // bands `destructive-local` and the tool advertises via `destructiveHint`.
  "copyTree.generateAndCopyFile",
] as const satisfies readonly BuiltInActionId[];
