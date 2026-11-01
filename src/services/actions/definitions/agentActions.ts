import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import type { ActionContext, ActionId } from "@shared/types/actions";
import {
  AgentIdSchema,
  AgentLaunchLocationSchema,
  LaunchLocationSchema,
  TerminalSpawnSourceSchema,
  AddPanelFocusPolicySchema,
  AgentFacingSessionRecordSchema,
  PanelLimitSnapshotSchema,
} from "./schemas";
import { z } from "zod";
import { AGENT_REGISTRY } from "@/config/agents";
import { NOTIFY_ARG_DESCRIPTION, NotifyReplyLinesSchema } from "@shared/types/terminalNotify";
import { AgentLaunchManyArgsSchema } from "@shared/types/mcpBatch";
import {
  AwaitedReplySchema,
  REPLY_WAIT_MAX_SECONDS,
  WaitForReplySchema,
  WaitSecondsSchema,
} from "@shared/types/replyWait";
import { SYSTEM_PROMPT_MAX_LENGTH } from "@shared/utils/agentSystemPrompt";
import {
  LAUNCH_SETUP_WAIT_DEFAULT_MS,
  LAUNCH_SETUP_WAIT_MAX_MS,
} from "@shared/utils/launchInNewWorktree";
import { WorktreeCreationSourceSchema } from "./workflowCreationActionArgs";
import {
  AgentCreatePresetArgsSchema,
  AgentDeletePresetArgsSchema,
  AgentListModelsArgsSchema,
  AgentListPresetsArgsSchema,
  AgentUpdatePresetArgsSchema,
  BookmarkAndCloseArgsSchema,
  BookmarkDeleteArgsSchema,
  BookmarkListArgsSchema,
  BookmarkMutateArgsSchema,
  ResumeSessionArgsSchema,
  SessionHistoryListArgsSchema,
} from "./agentActionArgs";
import type { AgentActionRunId } from "./agentActions.impl";

/**
 * `agent.launch`'s arguments, shared with `agent.launchInNewWorktree`, which
 * takes every one of them but the worktree it creates itself.
 */
const AgentLaunchArgsSchema = z.object({
  agentId: AgentIdSchema,
  location: AgentLaunchLocationSchema.optional(),
  cwd: z
    .string()
    .optional()
    .describe("Absolute launch directory, not a worktree selector. Defaults to the worktree root."),
  worktreeId: z
    .string()
    .optional()
    .describe("Worktree id from the worktree listing. Defaults to the active worktree."),
  prompt: z
    .string()
    .optional()
    .describe("First turn, submitted once the agent starts. Omit to leave it waiting."),
  handback: z
    .boolean()
    .optional()
    .describe(
      "Ask the agent to end its reply to `prompt` with a Daintree marker, read back as `lastHandback`."
    ),
  // Acted on in main, which sets up the notice; `run()` only refuses it for
  // a launch with no agent to watch.
  notify: z.boolean().optional().describe(NOTIFY_ARG_DESCRIPTION),
  replyLines: NotifyReplyLinesSchema,
  waitForReply: WaitForReplySchema,
  waitSeconds: WaitSecondsSchema,
  systemPrompt: z
    .string()
    .max(SYSTEM_PROMPT_MAX_LENGTH)
    .optional()
    .describe(
      "Appended to the agent's system prompt, at most 2000 characters, kept on resume. Claude and Codex only; others refuse it."
    ),
  interactive: z
    .boolean()
    .optional()
    .describe("Run as a conversation the user can continue, not one non-interactive pass."),
  model: z
    .string()
    .optional()
    .describe(
      "Omit for the CLI's default; set only when the user names a model. No preset needed."
    ),
  presetId: z
    .string()
    .nullable()
    .optional()
    .describe("One of the user's saved launch presets. Explicit null ignores the default preset."),
  activateDockOnCreate: z
    .boolean()
    .optional()
    .describe("Open the sidebar dock when placing the agent there."),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Extra env vars merged over the inherited environment. They reach a real process: never add credentials the user has not exposed."
    ),
  excludeFromPersistence: z
    .boolean()
    .optional()
    .describe(
      "Hide the terminal from the saved session, listings, status reads and bulk close or kill, so it can't be polled later. For throwaway work."
    ),
  removeOnExit: z
    .boolean()
    .optional()
    .describe("Close the panel when the agent exits, discarding its output."),
  agentLaunchFlags: z
    .array(z.string())
    .optional()
    .describe(
      'Extra CLI flags for this launch, verbatim, e.g. Codex effort ["-c", "model_reasoning_effort=high"]. Bad ones fail at CLI start.'
    ),
  spawnedBy: TerminalSpawnSourceSchema.optional(),
  focusPolicy: AddPanelFocusPolicySchema.optional(),
  requestedId: z
    .string()
    .optional()
    .describe("Panel id to create the terminal with, to correlate the launch."),
  force: z
    .boolean()
    .optional()
    .describe(
      "Skip the CLI launchability check, so an unlaunchable CLI starts and fails instead of opening a setup diagnostic. Leave off."
    ),
  name: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Always pass a short tab title ('Claude: auth refactor') so parallel agents are told apart. Blank uses the default."
    ),
});

/** Why a preset write asks first, shown in the host's confirm dialog. */
const PRESET_WRITE_DANGER_RATIONALE =
  "A preset's env vars and flags apply to every launch that picks it, and can redirect where the agent sends its traffic or relax its permissions.";

/** What a preset write reports: identity only, never env or flags. */
const PresetWriteResultSchema = z.object({
  presetId: z.string(),
  name: z.string(),
});

/**
 * Run bodies load on first dispatch (#14268, after the git pilot in #14239).
 * Every view registers the agent actions at boot for menus, keybindings and the
 * MCP manifest, but an empty view runs none of them. A failed chunk load
 * rejects inside `run`, which ActionService turns into an error result like any
 * other failure.
 */
async function runAgentAction(
  id: AgentActionRunId,
  args: unknown,
  ctx: ActionContext,
  callbacks: ActionCallbacks
): Promise<unknown> {
  const { agentActionRuns } = await import("./agentActions.impl");
  return agentActionRuns[id](args, ctx, callbacks);
}

/** The per-agent shortcuts share one run, parameterised by the agent they launch. */
async function runAgentShortcut(
  agentId: string,
  args: unknown,
  callbacks: ActionCallbacks
): Promise<unknown> {
  const { launchAgentShortcut } = await import("./agentActions.impl");
  return launchAgentShortcut(agentId, args, callbacks);
}

export function registerAgentActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  // Manifest metadata only: main runs each agent through `agent.launch` under
  // the same gate, notice and audit as a single call (see `sessionServer`).
  actions.set("agent.launchMany", () => ({
    id: "agent.launchMany",
    title: "Launch several agents",
    description:
      "Launch several agents with one shared prompt in one call, each a single launch in its own terminal with its own notice. Results come back in order.",
    category: "agent",
    kind: "command",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["several", "many", "batch", "fleet"],
    palette: { mode: "hidden" },
    argsSchema: AgentLaunchManyArgsSchema,
    run: async () => {
      throw new Error(
        "agent.launchMany must be invoked through the MCP main-process path, not renderer dispatch."
      );
    },
  }));

  actions.set("agent.launchInNewWorktree", () => ({
    id: "agent.launchInNewWorktree",
    title: "Create worktree and launch agent",
    description:
      "Create a managed worktree and launch one agent in it: source as for any managed worktree (no recipe), the rest as for any agent launch. Launches only once setup ends ready, else stops and says which. The session owns both. A failure after creation is PARTIAL_SUCCESS carrying worktreeId: use that worktree, don't retry.",
    category: "agent",
    kind: "command",
    danger: "safe",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["branch", "issue", "unit", "setup"],
    palette: { mode: "hidden" },
    argsSchema: AgentLaunchArgsSchema.omit({ worktreeId: true }).extend({
      source: WorktreeCreationSourceSchema,
      setupTimeoutMs: z
        .number()
        .int()
        .min(0)
        .max(LAUNCH_SETUP_WAIT_MAX_MS)
        .optional()
        .describe(
          `Ms to wait for setup, 0-${LAUNCH_SETUP_WAIT_MAX_MS} (default ${LAUNCH_SETUP_WAIT_DEFAULT_MS}). With waitForReply, it plus waitSeconds stays within ${REPLY_WAIT_MAX_SECONDS} s.`
        ),
    }),
    run: async () => {
      throw new Error(
        "agent.launchInNewWorktree must be invoked through the MCP main-process path, not renderer dispatch."
      );
    },
  }));

  actions.set("agent.launch", () => ({
    id: "agent.launch",
    title: "Launch agent",
    description:
      "Start an AI agent in a new terminal and report where it landed. Success means the panel exists and its process is starting, not that the agent is ready; read its status for that. A missing CLI opens a setup diagnostic panel instead. Keep concurrent launches modest.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["spawn", "start", "run", "new", "agents", "task", "model", "effort", "reasoning"],
    argsSchema: AgentLaunchArgsSchema,
    // Top-level object, never `.nullable()`: `buildToolOutputSchema` (tierAuth)
    // forwards a manifest schema only when its JSON Schema has
    // `type === "object"`, and zod renders a nullable object as a top-level
    // `anyOf`. A nullable schema here silently disabled `mcpOutputSchema` and
    // no `structuredContent` was ever emitted (#11547). Every field is
    // required and individually nullable — same shape as `agent.getState`, so
    // a strict client validating structuredContent never sees a missing key.
    resultSchema: z.object({
      launched: z.boolean(),
      terminalId: z.string().nullable(),
      location: z.enum(["grid", "dock", "background"]).nullable(),
      spawnStatus: z
        .enum([
          "missing-cli",
          "panel-limit",
          "already-launching",
          "spawn-failed",
          "unavailable",
          "presets-loading",
        ])
        .nullable()
        .describe(
          "Null if launched. Retry already-launching or presets-loading; missing-cli opened a setup panel."
        ),
      worktreeId: z.string().nullable(),
      worktreePath: z.string().nullable(),
      branch: z.string().nullable(),
      cwd: z.string().nullable(),
      // Observation, not a filing decision: cwd is not a worktree selector, so
      // a cwd in another repo still files under the resolved worktree (#13130).
      // Null when either path is unknown.
      cwdOutsideWorktree: z.boolean().nullable(),
      // Nested nullable is safe: only a nullable root disables the output schema.
      panelLimit: PanelLimitSnapshotSchema.nullable(),
      // Filled in by main when the call waits for the reply.
      reply: AwaitedReplySchema.nullable(),
    }),
    mcpOutputSchema: true,
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agent.launch", args, ctx, callbacks),
  }));

  actions.set("agent.palette", () => ({
    id: "agent.palette",
    title: "Open quick switcher",
    description: "Open the quick switcher to find panels",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agent.palette", args, ctx, callbacks),
  }));

  // Per-agent shortcut actions (`agent.claude`, `agent.codex`, …) accept
  // optional `location` and `spawnedBy` args so MCP-initiated launches can set
  // placement and be marked non-focus-stealing. See #6959, #7669.
  const shortcutLaunchSchema = z
    .object({
      location: LaunchLocationSchema.optional(),
      spawnedBy: TerminalSpawnSourceSchema.optional(),
      focusPolicy: AddPanelFocusPolicySchema.optional(),
    })
    .optional();

  const shortcutResultSchema = z
    .object({
      terminalId: z.string(),
      location: LaunchLocationSchema,
    })
    .nullable();

  for (const [id, config] of Object.entries(AGENT_REGISTRY)) {
    const actionId = `agent.${id}` as ActionId;
    actions.set(actionId, () => ({
      id: actionId,
      title: `Launch ${config.name}`,
      description: `Launch ${config.name} agent`,
      category: "agent",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: shortcutLaunchSchema,
      resultSchema: shortcutResultSchema,
      run: (args: unknown) => runAgentShortcut(id, args, callbacks),
    }));
  }

  actions.set("agent.terminal", () => ({
    id: "agent.terminal",
    title: "Launch terminal",
    description:
      "Open a plain shell terminal with no agent attached, for running ordinary commands. Use an agent launch instead when the intent is to start an AI CLI. This creates a visible panel and starts a shell process, so it consumes resources until closed.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: shortcutLaunchSchema,
    resultSchema: shortcutResultSchema,
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agent.terminal", args, ctx, callbacks),
  }));

  actions.set("agent.browser", () => ({
    id: "agent.browser",
    title: "Launch browser",
    description: "Launch a browser panel",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: shortcutLaunchSchema,
    resultSchema: shortcutResultSchema,
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agent.browser", args, ctx, callbacks),
  }));

  actions.set("agent.focusNextWaiting", () => ({
    id: "agent.focusNextWaiting",
    title: "Focus next waiting agent",
    description:
      "Move keyboard focus to the next agent that is blocked waiting on the user, so it can be answered. This changes what the user sees and is a navigation aid only — it reports no agent state. Use an agent status snapshot to find out which agents are waiting and why.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agent.focusNextWaiting", args, ctx, callbacks),
  }));

  actions.set("agent.focusNextWaitingGlobal", () => ({
    id: "agent.focusNextWaitingGlobal",
    title: "Focus next waiting agent (all projects)",
    description:
      "Jump to the next project with a waiting agent. Cycles across all projects in sidebar order, wrapping around.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agent.focusNextWaitingGlobal", args, ctx, callbacks),
  }));

  actions.set("agent.focusNextWorking", () => ({
    id: "agent.focusNextWorking",
    title: "Focus next working agent",
    description:
      "Move keyboard focus to the next agent that is currently working, to watch its progress. This changes what the user sees and is a navigation aid only — it reports no agent state. Use an agent status snapshot to find out which agents are working.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agent.focusNextWorking", args, ctx, callbacks),
  }));

  actions.set("agent.focusNextAgent", () => ({
    id: "agent.focusNextAgent",
    title: "Focus next agent",
    description:
      "Move keyboard focus to the next agent panel in order, cycling back to the first at the end. This changes what the user sees and reports no agent state; use a terminal listing to enumerate panels instead.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agent.focusNextAgent", args, ctx, callbacks),
  }));

  actions.set("dock.focusNextWaiting", () => ({
    id: "dock.focusNextWaiting",
    title: "Focus next blocked dock agent",
    description: "Jump to the next waiting agent in the dock",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("dock.focusNextWaiting", args, ctx, callbacks),
  }));

  actions.set("agent.getState", () => ({
    id: "agent.getState",
    title: "Get agent state",
    description:
      "Look up one agent's live state by its agent id, to tell whether it is working, waiting on the user, or finished. Use a terminal listing or status snapshot to enumerate terminals — this answers about a single agent only. It never fails: with no matching panel the result is flagged not found with empty fields, while a panel whose agent has exited stays found and carries its exit code.",
    category: "agent",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      agentId: z
        .string()
        .min(1)
        .describe(
          "Identifies the agent to look up, using an agent id such as 'claude' or 'codex' as reported by the terminal-listing capability."
        ),
    }),
    examples: [
      {
        args: { agentId: "claude" },
        description: "Check whether the Claude agent is working, waiting, or idle",
      },
    ],
    resultSchema: z.object({
      agentId: z.string(),
      state: z.string().nullable(),
      waitingReason: z.string().nullable(),
      lastTransitionAt: z.number().nullable(),
      // Process exit code once the agent's PTY has exited; null while running or
      // when signal-terminated with no numeric code. Disambiguate via `state`.
      exitCode: z.number().int().nullable(),
      // Wall-clock spawn timestamp (ms) for duration reasoning; null if unknown.
      spawnedAt: z.number().nullable(),
      terminalId: z.string().nullable(),
      found: z.boolean(),
    }),
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agent.getState", args, ctx, callbacks),
  }));

  actions.set("agentSessionHistory.list", () => ({
    id: "agentSessionHistory.list",
    title: "List resumable sessions",
    description:
      "List closed agent sessions that can be relaunched, from the on-disk journal: which sessions exist, no transcript text. Needs a worktree or project scope and fails when none resolves. Old sessions are pruned, so absence proves nothing.",
    category: "agent",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: SessionHistoryListArgsSchema,
    examples: [
      {
        args: { worktreeId: "wt-1" },
        description: "List the most recent resumable sessions for one worktree",
      },
      {
        args: { projectId: "proj-1", limit: 50 },
        description: "List up to 50 resumable sessions across one project",
      },
    ],
    resultSchema: z.object({
      sessions: z.array(AgentFacingSessionRecordSchema),
      total: z.number(),
      hasMore: z.boolean(),
    }),
    mcpOutputSchema: true,
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agentSessionHistory.list", args, ctx, callbacks),
  }));

  actions.set("agentSessionHistory.resume", () => ({
    id: "agentSessionHistory.resume",
    title: "Resume agent session",
    description:
      "Relaunch one closed agent session by exact id and return its pane. It relaunches in the worktree it was recorded in, so one recorded outside the named worktree is refused. A repeat call brings the live pane forward, not a second agent. Opens off-screen unless that worktree is active.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: ResumeSessionArgsSchema,
    examples: [
      {
        args: { worktreeId: "wt-1", sessionId: "sess-abc123" },
        description: "Resume one journaled session in the worktree it was recorded in",
      },
    ],
    resultSchema: z.object({
      terminalId: z.string(),
      sessionId: z.string(),
      worktreeId: z.string().nullable(),
      outcome: z.enum(["created", "activatedExisting"]),
    }),
    mcpOutputSchema: true,
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agentSessionHistory.resume", args, ctx, callbacks),
  }));

  actions.set("session.bookmarkAndClose", () => ({
    id: "session.bookmarkAndClose",
    title: "Bookmark and close",
    description:
      "Save a live agent pane's conversation as a durable bookmark, then close the pane. For a session that is already closed, promote it instead. Prepare-before-remove: if the capture fails the pane stays open and nothing is bookmarked. It interrupts a running agent and discards its scrollback — the conversation returns on resume, the process does not.",
    category: "agent",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Interrupts a running agent and removes its pane. The conversation is bookmarked and resumable, but the live process and terminal scrollback are discarded.",
    // danger:"confirm" gates agent/plugin dispatch through ActionService (the
    // caller must attest confirmation via the dispatch option). Since #11908 put
    // this on the assistant's action tier, that attestation comes from the
    // renderer's own MCP confirm modal, which `useMcpBridge` raises for any
    // dispatch whose effective danger is "confirm" — so an assistant call is
    // gated by a real human dialog rather than dead-ending. The bound-session
    // withholding rule that hides confirm-gated tools does not apply: it keys on
    // the `external` tier, and the first-party assistant is never external.
    // Hidden from the palette so a source:"user" pick can't bypass the D1 guard.
    palette: { mode: "hidden" },
    argsSchema: BookmarkAndCloseArgsSchema,
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("session.bookmarkAndClose", args, ctx, callbacks),
  }));

  actions.set("session.bookmark.promote", () => ({
    id: "session.bookmark.promote",
    title: "Add bookmark to session",
    description:
      "Pin a session that is already in history as a durable bookmark, without launching it or touching any pane. Use this when the session is closed; the bookmark-and-close capability is the one that retires a still-open pane. Bookmarking exempts a session from retention and from the per-worktree cap, so it stops aging out until the bookmark is deleted. Returns the updated record.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: BookmarkMutateArgsSchema,
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("session.bookmark.promote", args, ctx, callbacks),
  }));

  actions.set("session.bookmark.rename", () => ({
    id: "session.bookmark.rename",
    title: "Rename bookmark",
    description:
      "Change the label on an existing bookmark. Only the bookmark's own label moves — the agent session, its recorded title, and any live pane are left alone, so this cannot be used to retitle a terminal. A session that was never bookmarked is rejected rather than bookmarked on the spot; promote it first. Returns the updated record.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: BookmarkMutateArgsSchema,
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("session.bookmark.rename", args, ctx, callbacks),
  }));

  actions.set("session.bookmark.delete", () => ({
    id: "session.bookmark.delete",
    title: "Delete bookmark",
    description:
      "Remove a bookmark, demoting its session back to ordinary time-limited history where retention can eventually age it out. The provider's own transcript and any open pane are untouched, so this deletes the pin rather than the conversation — but the pin itself does not come back, and the session may be gone by the time anyone looks again. Confirmation is enforced by the dispatch layer.",
    category: "agent",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Permanently removes the durable bookmark; the session demotes to ordinary history and may then age out. The provider transcript is untouched.",
    // See session.bookmarkAndClose — danger:"confirm" gates dispatch through
    // ActionService; hidden from the palette so a user pick can't bypass it.
    palette: { mode: "hidden" },
    argsSchema: BookmarkDeleteArgsSchema,
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("session.bookmark.delete", args, ctx, callbacks),
  }));

  actions.set("session.bookmarks.list", () => ({
    id: "session.bookmarks.list",
    title: "List bookmarks",
    description:
      "List the durable session bookmarks the user has saved for one project, newest first. Bookmarks never expire, unlike ordinary session history, so this is where deliberately kept sessions live. It is strictly project-scoped: with no project to scope to it returns nothing rather than leaking bookmarks between projects. Read-only metadata — it carries no transcript text.",
    category: "agent",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: BookmarkListArgsSchema,
    resultSchema: z.object({
      bookmarks: z.array(AgentFacingSessionRecordSchema),
      total: z.number(),
      hasMore: z.boolean(),
    }),
    mcpOutputSchema: true,
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("session.bookmarks.list", args, ctx, callbacks),
  }));

  actions.set("agent.listToolbar", () => ({
    id: "agent.listToolbar",
    title: "List toolbar agents",
    description:
      "List the built-in agents together with whether each one currently shows in the toolbar. Use this to see what the user has surfaced without reading full agent settings. Visibility is resolved for you: an agent can be explicitly pinned, explicitly hidden, or left to follow whether its CLI is installed, so read the resolved visibility rather than inferring it from pinning alone.",
    category: "agent",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({
      agents: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          pinned: z.boolean().optional(),
          installed: z.boolean(),
          visible: z.boolean(),
        })
      ),
    }),
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agent.listToolbar", args, ctx, callbacks),
  }));

  actions.set("agent.listAvailable", () => ({
    id: "agent.listAvailable",
    title: "List available agents",
    description:
      "List every registered agent (built-in, user-defined, plugin) from the authoritative registry, launchable or not. Use before launching, and read each entry's launchability rather than assuming it. Launchability appears once each CLI's live probe finishes; the result says while that is incomplete.",
    category: "agent",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    resultSchema: z.object({
      complete: z.literal(true),
      availabilityComplete: z.boolean(),
      agents: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          source: z.enum(["built-in", "user", "plugin"]),
          launchable: z.boolean().optional(),
          availability: z
            .enum(["missing", "installed", "ready", "blocked", "unauthenticated"])
            .optional(),
          installed: z.boolean().optional(),
          pinned: z.boolean().optional(),
          toolbarVisible: z.boolean().optional(),
        })
      ),
    }),
    mcpOutputSchema: true,
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agent.listAvailable", args, ctx, callbacks),
  }));

  actions.set("agent.listPresets", () => ({
    id: "agent.listPresets",
    title: "List agent presets",
    description:
      "List one agent's launchable presets, merged from user settings, repository preset files and CCR as the launcher does. Identity only, no env or flags; a launch can set model and flags without one. A false completeness flag means a source is loading.",
    category: "agent",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: AgentListPresetsArgsSchema,
    examples: [
      {
        args: { agentId: "claude" },
        description: "Discover the preset ids available for Claude Code",
      },
    ],
    resultSchema: z.object({
      presetsComplete: z.boolean(),
      presets: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          source: z.enum(["custom", "project", "ccr", "registry"]),
          description: z.string().optional(),
        })
      ),
    }),
    mcpOutputSchema: true,
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agent.listPresets", args, ctx, callbacks),
  }));

  // The user-preset writes (#16047). Confirm tier, so an agent's call raises
  // the host's dialog with the exact change (`resolveMcpConfirmPreviewTarget`),
  // or rides the person's own grant or skip preference, never the model's say.
  // Palette-hidden: Settings edits presets directly, and the palette has no way
  // to ask for the fields. Closed to plugins, like `agentSettings.set`.
  actions.set("agent.createPreset", () => ({
    id: "agent.createPreset",
    title: "Create launch preset",
    description:
      "Save a new user launch preset for an agent: a named set of env vars, flags and modes picked at launch. The user approves the exact preset first; values Daintree would drop at launch are refused. It doesn't become the agent's default. Returns its id.",
    category: "agent",
    kind: "command",
    danger: "confirm",
    dangerRationale: PRESET_WRITE_DANGER_RATIONALE,
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["preset", "profile", "env", "account", "add"],
    palette: { mode: "hidden" },
    argsSchema: AgentCreatePresetArgsSchema,
    examples: [
      {
        args: {
          agentId: "codex",
          name: "Work account",
          env: { CODEX_HOME: "/Users/me/.codex-work" },
        },
        description: "A Codex preset that keeps its own login and history",
      },
    ],
    resultSchema: PresetWriteResultSchema,
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agent.createPreset", args, ctx, callbacks),
  }));

  actions.set("agent.updatePreset", () => ({
    id: "agent.updatePreset",
    title: "Edit launch preset",
    description:
      'Change one of the user\'s own launch presets in place, after the user approves the exact change. Pass only what changes: envSet and envUnset touch only the named env vars; an empty value or "inherit" clears a field. Repository, CCR and built-in presets are read-only.',
    category: "agent",
    kind: "command",
    danger: "confirm",
    dangerRationale: PRESET_WRITE_DANGER_RATIONALE,
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["preset", "profile", "env", "account", "edit", "rename"],
    palette: { mode: "hidden" },
    argsSchema: AgentUpdatePresetArgsSchema,
    resultSchema: PresetWriteResultSchema,
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agent.updatePreset", args, ctx, callbacks),
  }));

  actions.set("agent.deletePreset", () => ({
    id: "agent.deletePreset",
    title: "Remove launch preset",
    description:
      "Remove one of the user's own launch presets for good, after the user approves it. If it was the agent's default preset, the default is cleared. Repository, CCR and built-in presets are read-only.",
    category: "agent",
    kind: "command",
    danger: "confirm",
    dangerRationale:
      "Removes the preset for good. Launches that picked it, as a default included, go back to the agent's own settings.",
    denyPluginDispatch: true,
    scope: "renderer",
    keywords: ["preset", "profile", "remove", "delete"],
    palette: { mode: "hidden" },
    argsSchema: AgentDeletePresetArgsSchema,
    resultSchema: PresetWriteResultSchema.extend({
      agentDefaultCleared: z
        .boolean()
        .describe("It was the agent's default preset, so the agent now has none."),
    }),
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agent.deletePreset", args, ctx, callbacks),
  }));

  actions.set("agent.listModels", () => ({
    id: "agent.listModels",
    title: "List agent models",
    description:
      "Each agent CLI's current model ids and names, to turn a model the user names into an id. With none named, launch without a model.",
    category: "agent",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: AgentListModelsArgsSchema,
    examples: [
      {
        args: { agentId: "codex" },
        description: "Find the id of a Codex model the user asked for by name",
      },
    ],
    resultSchema: z.object({
      agents: z.array(
        z.object({
          agentId: z.string(),
          models: z.array(z.object({ id: z.string(), name: z.string() })),
        })
      ),
    }),
    mcpOutputSchema: true,
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agent.listModels", args, ctx, callbacks),
  }));

  actions.set("agent.focusPreviousAgent", () => ({
    id: "agent.focusPreviousAgent",
    title: "Focus previous agent",
    description:
      "Move keyboard focus to the previous agent panel in order, cycling to the last at the beginning. This changes what the user sees and reports no agent state; use a terminal listing to enumerate panels instead.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: (args: unknown, ctx: ActionContext) =>
      runAgentAction("agent.focusPreviousAgent", args, ctx, callbacks),
  }));
}
