import type { HelpAssistantTier } from "../types/ipc/maps.js";
import type { BuiltInActionId } from "../types/actions.js";

export const ACTIONS_LIST_TOOL = "actions.list";

/**
 * The two in-app tool sets, smallest first. Every help session and every agent
 * pane with Daintree MCP enabled runs at one of them.
 */
export const HELP_ASSISTANT_TIERS = [
  "core",
  "full",
] as const satisfies readonly HelpAssistantTier[];

export const DEFAULT_HELP_ASSISTANT_TIER: HelpAssistantTier = "core";

/**
 * Map a stored tier onto the current pair. Settings written before the
 * core/full split carry the old three-rung ladder; `workbench` and `action`
 * read as `core` and `system` as `full`, so nothing on disk has to be
 * rewritten. Anything unrecognised is `null`.
 */
export function normalizeHelpAssistantTier(value: unknown): HelpAssistantTier | null {
  switch (value) {
    case "core":
    case "full":
      return value;
    case "workbench":
    case "action":
      return "core";
    case "system":
      return "full";
    default:
      return null;
  }
}

/**
 * The orchestration surface: create worktrees, launch agents, prompt them,
 * read and wait on them, move and close them. It is the default because it
 * covers what the Daintree assistant and its runbooks actually call — terminal
 * reads, sends and launches are nearly all real traffic — and every tool here
 * is re-sent to the model on each turn, so what is not needed for that loop
 * belongs in `full`.
 */
export const CORE_TIER_TOOLS = [
  "actions.getContext",
  "actions.search",
  "actions.getSchema",
  // Reports the caller's own tool surface as data (#11549) — a read of what
  // `tools/list` already told this session, so it grants nothing.
  "mcp.surface",
  // Workspace ids are minted by Daintree and cannot be reconstructed from
  // outside it (#12307). Identity only.
  "workspace.list",

  "worktree.list",
  // Daintree's own creator: copies project config, initializes submodules and
  // runs setup. A recipe is optional.
  "worktree.createWithRecipe",
  // A caller that can see setup `running` must be able to wait for it.
  "worktree.waitUntilReady",
  // Waits on the PR Daintree already detects, so a queue can start the next
  // agent once this one has opened its PR without polling the forge (#12717).
  "worktree.waitForPullRequest",
  // The counterpart to creation, and only that: it deletes a worktree this
  // session created and refuses everything else (#11909). Keeps
  // `danger: "confirm"`, so a human still approves it.
  "worktree.deleteOwned",
  // `worktree.createWithRecipe` takes a recipe id, and nothing else says what
  // the ids are.
  "recipe.list",

  "agent.launch",
  // `agent.launch` accepts user- and plugin-contributed agent ids; only Daintree
  // knows the effective registry and live launchability.
  "agent.listAvailable",
  // Preset ids are generated, merged from settings, `.daintree/presets/` and
  // CCR discovery; without this the launch argument is undiscoverable (#11859).
  "agent.listPresets",

  "terminal.list",
  "terminal.getStatus",
  "terminal.getOutput",
  // What an agent this session launched last said (#12479). Scoped to panels
  // the session created.
  "terminal.readLastMessageOwned",
  // Reaches any panel, so sessions that are not Daintree's own assistant get
  // `terminal.sendCommandOwned` in its place — see `OWNED_TWIN_TOOLS`.
  "terminal.sendCommand",
  "terminal.waitUntilIdle",
  "terminal.waitUntilIdleBatch",
  // Stop a turn without losing the conversation (#12338).
  "terminal.interruptOwned",
  // Swapped for `terminal.closeOwned` outside the assistant, like the send.
  "terminal.close",
  "terminal.moveToWorktree",
  // Brings a panel this session created into view (#12315).
  "terminal.revealOwned",
  "terminal.rename",

  "help.displayImage",
] as const satisfies readonly BuiltInActionId[];

/**
 * Added on top of `core`. Everything an orchestrator reaches for less often —
 * recipes and workflows, project checks, forge and git reads, context bundles,
 * diagnostics, pane watches, worktree resources, the plugin-authoring loop.
 *
 * Deliberately absent from both sets, and so from MCP entirely: git writes and
 * most git reads, forge writes and browser openers, file reads, UI navigation
 * and layout, theme and settings writes, session bookmarks, the recipe editor,
 * fleet arming, and bulk kills. An agent has its own shell and forge CLI for
 * repository work, and the rest is the user's to drive from the UI.
 * `agentSettings.get` is out too: its result carries launch flags and preset
 * payloads that can hold credentials.
 */
export const FULL_TIER_ADDONS = [
  ACTIONS_LIST_TOOL,
  "worktree.getCurrent",
  "worktree.setActive",
  // The unscoped delete: it reaches any eligible worktree in the project, not
  // only ones the session made, so it sits here while the owned form is core.
  // `danger: "confirm"`, and a force whose target resolves to D3 still
  // escalates to the typed-name gate (#12115) even under a grant.
  "worktree.delete",
  "worktree.reviewReadiness",
  "worktree.resource.status",
  "worktree.resource.provision",
  "worktree.resource.pause",
  "worktree.resource.resume",
  // The teardown command is project-defined and may destroy a remote resource,
  // so it keeps `danger: "confirm"`. The deletes run it implicitly too.
  "worktree.resource.teardown",

  // Resume spawns a pane; the record owns its launch directory (#11908).
  "agentSessionHistory.list",
  "agentSessionHistory.resume",

  "terminal.new",
  "terminal.inject",
  "terminal.kill",
  "terminal.restart",
  "terminal.closeAll",
  // The event-driven counterpart to the waits (#12491). Inert unless the user
  // has turned pane wakes on.
  "terminal.registerWatch",
  "terminal.listWatches",
  "terminal.getWatchEvents",
  "terminal.cancelWatch",
  // Orchestrator-owned metadata about a panel (#12340). Bounded, invisible in
  // the UI, and confers no ownership.
  "terminal.setClientMetadata",

  "recipe.run",
  "workflow.startWorkOnIssue",
  "workflow.prepBranchForReview",
  "project.detectRunners",
  // Runs a project-declared command as a real child process.
  "project.runCheck",

  "git.getProjectPulse",
  "forge.getPR",
  "forge.listPRs",
  "forge.getIssue",
  "forge.listIssues",
  "forge.getCIStatus",

  "copyTree.generate",
  "copyTree.injectToTerminal",
  // Puts a file on the clipboard with the project's own CopyTree policy, the
  // same way on every platform (#11722). Its blast radius is a clipboard
  // overwrite, which `actionRiskBand` bands `destructive-local`.
  "copyTree.generateAndCopyFile",

  "skills.search",
  "skills.load",
  "slashCommands.list",
  // Read-only snapshot of the user's fleet broadcast run (#10930). Dispatching
  // a broadcast stays off MCP.
  "fleet.getRunStatus",

  "browser.getConsoleMessages",
  "devPreview.reloadPreview",
  "devPreview.restart",
  "errors.recent",
  "notifications.recent",

  // The plugin-authoring loop (#12214, #12611): two reads, a project reload
  // and a single-view remount that stages the user's confirm on unsaved work.
  "plugin.validate",
  "plugin.diagnostics",
  "plugin.reloadProject",
  "plugin.reloadPanel",
] as const satisfies readonly BuiltInActionId[];

/**
 * Tools that act on any panel or worktree a listing returns, paired with the
 * form scoped to what the calling session created (#11909, #12407).
 *
 * The tool sets name the unscoped id. Daintree's own assistant keeps it — it
 * runs pinned to the window the user is watching, and prompting agents the
 * user launched is most of what it is asked to do. Every other session gets
 * the owned form in its place: an agent pane's own bearer, whose origin is
 * `external`, could otherwise type into or close a neighbouring shell, and an
 * agent running in a read-only sandbox would then be running commands as the
 * user. That is not a sandbox — a session holding `terminal.new` can still open
 * a shell — but it stops the authority reaching panels the session did not
 * open.
 */
export const OWNED_TWIN_TOOLS = {
  "terminal.sendCommand": "terminal.sendCommandOwned",
  "terminal.inject": "terminal.injectOwned",
  "terminal.close": "terminal.closeOwned",
  "worktree.delete": "worktree.deleteOwned",
} as const satisfies Partial<Record<BuiltInActionId, BuiltInActionId>>;

/**
 * Unscoped tools with no owned form, reserved for Daintree's own assistant
 * surfaces — `help` and `assistant-pane` sessions — for the reason above.
 * Withheld from every other session at discovery and at dispatch.
 */
export const RENDERER_OWNED_ORIGIN_ONLY_TOOLS = [
  "copyTree.injectToTerminal",
  "terminal.kill",
  "terminal.restart",
  "terminal.closeAll",
] as const satisfies readonly BuiltInActionId[];

/**
 * The surface a session whose origin is not renderer-owned is admitted
 * against: each unscoped tool swapped for its owned twin, and the reserved
 * tools removed. Order-preserving and duplicate-free, so `full` — which carries
 * both `worktree.delete` and core's `worktree.deleteOwned` — collapses to one.
 */
export function toNonRendererOwnedTools(ids: readonly string[]): string[] {
  const reserved = new Set<string>(RENDERER_OWNED_ORIGIN_ONLY_TOOLS);
  const twins: Readonly<Record<string, string>> = OWNED_TWIN_TOOLS;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (reserved.has(id)) continue;
    const mapped = twins[id] ?? id;
    if (seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
  }
  return out;
}

/**
 * Tools added at each tier on top of the previous one. Useful for the
 * blast-radius preview UI which shows the incremental capability change.
 */
export const HELP_TIER_INCREMENTAL: Record<HelpAssistantTier, readonly string[]> = {
  core: CORE_TIER_TOOLS,
  full: FULL_TIER_ADDONS,
};

/**
 * Cumulative static allow-list per tier, as Daintree's own assistant sees it —
 * every tool that tier permits before a live grant widens the session.
 */
export const HELP_TIER_CUMULATIVE: Record<HelpAssistantTier, readonly string[]> = {
  core: CORE_TIER_TOOLS,
  full: [...CORE_TIER_TOOLS, ...FULL_TIER_ADDONS],
};

/**
 * Tools whose blast radius is high enough that the UI pins them at the top of a
 * tier's preview so users don't miss them in a long list.
 *
 * Operational risk, not minimum tier. The preview intersects this list with the
 * tier being previewed, so the same tool is called out wherever it first
 * becomes reachable. All three run project-defined teardown — arbitrary
 * commands from `.daintree/config.json`, and resource teardown that can destroy
 * a remote devbox. The two delete variants then remove the tree as well.
 */
export const HIGH_BLAST_RADIUS_TOOLS: readonly string[] = [
  "worktree.delete",
  "worktree.deleteOwned",
  "worktree.resource.teardown",
];
