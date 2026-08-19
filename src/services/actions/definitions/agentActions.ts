import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import {
  AgentIdSchema,
  LaunchLocationSchema,
  TerminalSpawnSourceSchema,
  AddPanelFocusPolicySchema,
  AgentFacingSessionRecordSchema,
} from "./schemas";
import { z } from "zod";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { AGENT_REGISTRY, getAgentDisplayTitle, getMergedPresetIdentities } from "@/config/agents";
import { agentCapabilitiesClient, agentSettingsClient, cliAvailabilityClient } from "@/clients";
import { userAgentRegistryClient } from "@/clients/userAgentRegistryClient";
import {
  isAssistantOnlyAgentId,
  isBuiltInAgentId,
  LAUNCHABLE_AGENT_IDS,
} from "@shared/config/agentIds";
import { isAgentToolbarVisible } from "@shared/utils/agentPinned";
import { isAgentInstalled, isAgentLaunchable } from "@shared/utils/agentAvailability";
import type { ActionContext, ActionId } from "@shared/types/actions";
import { isPtyPanel, type TerminalSpawnSource } from "@shared/types/panel";
import type {
  AgentSessionBookmarkMetadata,
  AgentSessionRecord,
} from "@shared/types/ipc/agentSessionHistory";

// Named so the bookmark actions can both declare `argsSchema` and `.parse()` in
// run() for typed args without an unsafe `as` cast (#11288).
const BookmarkAndCloseArgsSchema = z.object({
  terminalId: z.string().trim().min(1),
  label: z.string().trim().min(1).max(120),
});
const BookmarkMutateArgsSchema = z.object({
  sessionId: z.string().min(1),
  label: z.string().trim().min(1).max(120),
});
const BookmarkDeleteArgsSchema = z.object({ sessionId: z.string().min(1) });

// Bounds for the two agent-facing session listings (#11530). Deliberately
// tighter than the 50/500 used for log-shaped actions: a session record is an
// order of magnitude heavier than a log line, and an MCP result is billed twice
// (once as text, once as `structuredContent`). 20 matches RESUME_PAGE_SIZE, the
// resume palette's own page size.
const SESSION_LIST_DEFAULT_LIMIT = 20;
const SESSION_LIST_MAX_LIMIT = 100;
const SessionListLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(SESSION_LIST_MAX_LIMIT)
  .default(SESSION_LIST_DEFAULT_LIMIT)
  .describe(
    `Max records to return, newest-first (default: ${SESSION_LIST_DEFAULT_LIMIT}, max: ${SESSION_LIST_MAX_LIMIT}).`
  );

// Paired with the limit so a bounded page isn't a one-way door. Bookmarks are
// exempt from every eviction rule, so a project can hold more of them than the
// maximum limit — without an offset those records would be unreachable through
// the action, and their sessionId is the only handle rename/delete accept.
const SessionListOffsetSchema = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Records to skip before the page, for reaching past the limit (default: 0).");

const BookmarkListArgsSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    limit: SessionListLimitSchema,
    offset: SessionListOffsetSchema,
  })
  .optional();

const AgentListPresetsArgsSchema = z.object({
  agentId: AgentIdSchema,
  projectId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Which project's repository presets to include. Defaults to the project this call is dispatched in. Naming one that is not the loaded project returns the other layers and reports the result as incomplete rather than answering for the wrong project."
    ),
});

const SessionHistoryListArgsSchema = z
  .object({
    // `.min(1)`: an empty string would fall through the bridge's `if
    // (!worktreeId)` guard to an unfiltered listing — a surprising result for a
    // caller that passed a (blank) id expecting a scoped one.
    worktreeId: z.string().min(1).optional().describe("Restrict the listing to one worktree id."),
    projectId: z
      .string()
      .min(1)
      .optional()
      .describe("Restrict the listing to one project id; combines with `worktreeId`."),
    limit: SessionListLimitSchema,
    offset: SessionListOffsetSchema,
  })
  .optional();

/**
 * Rebuild bookmark metadata as the lean shape an agent is given (#11530).
 * Allowlist rather than omit/rest-destructuring: a pane-presentation field
 * added to the record later must stay out of MCP output until someone
 * deliberately opts it in here.
 */
function toAgentFacingBookmark(
  bookmark: AgentSessionBookmarkMetadata
): AgentSessionBookmarkMetadata {
  return {
    bookmarkedAt: bookmark.bookmarkedAt,
    label: bookmark.label,
    ...(bookmark.sourceLocation !== undefined && { sourceLocation: bookmark.sourceLocation }),
    ...(bookmark.agentPresetId !== undefined && { agentPresetId: bookmark.agentPresetId }),
    ...(bookmark.originalPresetId !== undefined && { originalPresetId: bookmark.originalPresetId }),
    ...(bookmark.isInputLocked !== undefined && { isInputLocked: bookmark.isInputLocked }),
  };
}

/**
 * Rebuild a journal record as the agent-facing shape (#11530). Applied by BOTH
 * list actions — a bookmarked record surfaces through session history too, so
 * stripping in only one of them would leave the other as an open path for the
 * same pane-presentation fields. Dispatch parses results against `resultSchema`
 * now (#11539), but this stays real code: the records ride under an
 * `z.unknown()` arm that opts out of stripping, so the parse cannot narrow them.
 */
function toAgentFacingRecord(record: AgentSessionRecord): AgentSessionRecord {
  return {
    sessionId: record.sessionId,
    agentId: record.agentId,
    worktreeId: record.worktreeId,
    title: record.title,
    projectId: record.projectId,
    savedAt: record.savedAt,
    ...(record.agentLaunchFlags !== undefined && { agentLaunchFlags: record.agentLaunchFlags }),
    ...(record.agentModelId !== undefined && { agentModelId: record.agentModelId }),
    ...(record.cwd !== undefined && { cwd: record.cwd }),
    ...(record.branch !== undefined && { branch: record.branch }),
    // Truthiness, not `!== undefined`, only for the nested object: the journal
    // is a plain JSON file on disk and `normalizeRecords` admits any object
    // with a string sessionId, so a hand-edited `"bookmark": null` would reach
    // this projection and throw — taking down a whole listing the journal is
    // documented to survive. The scalar spreads above stay `!== undefined` on
    // purpose so falsy-but-present values (`isInputLocked: false`) survive.
    ...(record.bookmark ? { bookmark: toAgentFacingBookmark(record.bookmark) } : {}),
  };
}

/**
 * Drop projected records the advertised shape cannot carry.
 *
 * `normalizeRecords` (electron/services/pty/agentSessionHistory.ts) deliberately
 * admits any object with a string `sessionId` so a garbage, hand-edited, or
 * newer-schema journal degrades gracefully instead of crashing reads that are
 * documented never to error. Dispatch now parses results against `resultSchema`
 * (#11539), which would turn one degraded row back into exactly that crash — for
 * the whole page, not the row. Filtering here keeps the guarantee: the caller
 * loses the unrepresentable record and nothing else. `session.bookmarks.list`
 * needs this doubly, since it selects on `bookmark !== undefined` and so admits
 * a hand-written `"bookmark": {}` that carries neither `bookmarkedAt` nor
 * `label`.
 */
function keepRepresentableRecords(records: AgentSessionRecord[]): AgentSessionRecord[] {
  return records.filter((record) => AgentFacingSessionRecordSchema.safeParse(record).success);
}

/**
 * Deadline for `agent.listAvailable`'s discovery reads.
 *
 * Main abandons an MCP dispatch after `MCP_DISPATCH_TIMEOUT_MS` (30s) without
 * cancelling the renderer-side action, so an IPC leg that never settles used to
 * hold its `mcpSpawnFocusGuard` lease indefinitely — long past the 45s TTL, and
 * observed pending for over 13 hours (#11795). Settling first keeps that lease
 * bounded and turns a stall into a diagnosable error.
 *
 * Sized above the slowest LEGITIMATE cold read, which is ~20s rather than the
 * 10s it first looks like: before the stores hydrate `readAgentDiscoveryState`
 * calls `getCliAvailability`, which on an empty cache falls through to
 * `CliAvailabilityService.checkAvailability()` — and that awaits `refreshPath()`
 * (its own 10s budget) BEFORE starting its 10s probe timer. Undershooting turns
 * a slow cold start into a spurious failure. Still clears main's 30s dispatch
 * timeout and the guard's 45s lease TTL.
 */
const AGENT_DISCOVERY_READ_TIMEOUT_MS = 25_000;

export function registerAgentActions(actions: ActionRegistry, callbacks: ActionCallbacks): void {
  const readAgentDiscoveryState = async () => {
    // These are the same normalized renderer stores the toolbar reads. Fall back to
    // cache-aware IPC clients only before hydration; neither path exposes settings
    // details beyond the narrow fields each discovery action selects below.
    const [{ useAgentSettingsStore }, { useCliAvailabilityStore }] = await Promise.all([
      import("@/store/agentSettingsStore"),
      import("@/store/cliAvailabilityStore"),
    ]);
    const storeSettings = useAgentSettingsStore.getState().settings;
    const settings = storeSettings ?? (await agentSettingsClient.get());
    const availabilityStore = useCliAvailabilityStore.getState();
    const availability = availabilityStore.hasRealData
      ? availabilityStore.availability
      : await cliAvailabilityClient.get();
    // `hasRealData` flips true the moment the localStorage cache hydrates, where
    // absent agents are synthesized as "missing" — only `isInitialized` proves a
    // live CLI probe has actually completed this session. listAvailable uses this
    // so it never certifies a never-probed agent as "missing"; listToolbar keeps
    // reading `availability` directly because it must mirror the live toolbar,
    // which renders from the same hydrating store.
    const availabilityLive = availabilityStore.isInitialized === true;
    return { settings, availability, availabilityLive };
  };

  /**
   * Read the three sources `agent.listAvailable` needs, under a deadline.
   *
   * Each leg is tracked by name so a timeout says which one is still
   * outstanding — the whole difficulty of #11795 was that a bare dispatch
   * timeout gave no hint which await had stalled. The deadline only stops
   * waiting; `ipcRenderer.invoke` takes no `AbortSignal`, so an in-flight
   * invoke keeps running. A late rejection needs no extra guard: `Promise.race`
   * leaves its handlers attached, so the leg stays handled after the deadline
   * has already won.
   */
  const readAvailableAgentSources = async () => {
    const pending = new Set(["agentDiscoveryState", "agentRegistry", "userAgentRegistry"]);
    const track = <T>(leg: string, work: Promise<T>): Promise<T> =>
      work.finally(() => pending.delete(leg));

    const sources = Promise.all([
      track("agentDiscoveryState", readAgentDiscoveryState()),
      track("agentRegistry", agentCapabilitiesClient.getRegistry()),
      track("userAgentRegistry", userAgentRegistryClient.get()),
    ]);

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        reject(
          new Error(
            `Timed out after ${AGENT_DISCOVERY_READ_TIMEOUT_MS}ms reading agent discovery data; still waiting on: ${[...pending].join(", ")}`
          )
        );
      }, AGENT_DISCOVERY_READ_TIMEOUT_MS);
    });

    try {
      return await Promise.race([sources, deadline]);
    } finally {
      clearTimeout(deadlineTimer);
    }
  };

  actions.set("agent.launch", () => ({
    id: "agent.launch",
    title: "Launch Agent",
    description:
      "Start an AI agent in a new terminal and report where it landed, so parallel launches can be told apart without re-resolving the target. Success means the panel was created and its process is starting, not that the agent is ready — poll its state or a terminal status snapshot for that. A failure to launch may mean the agent's CLI is missing, in which case a setup diagnostic panel is opened instead. Launching consumes real resources, so keep concurrent launches modest.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      agentId: AgentIdSchema,
      location: LaunchLocationSchema.optional(),
      cwd: z
        .string()
        .optional()
        .describe(
          "Absolute directory to start the agent process in. This is the launch directory, not a worktree selector — name the worktree separately. Defaults to the resolved worktree root."
        ),
      worktreeId: z
        .string()
        .optional()
        .describe(
          "Identifies the worktree to launch in, using an id from the worktree-listing capability. Defaults to the active worktree."
        ),
      prompt: z
        .string()
        .optional()
        .describe(
          "Initial text submitted to the agent once it starts, as its first turn. Omit to leave the agent waiting for input."
        ),
      interactive: z
        .boolean()
        .optional()
        .describe(
          "Whether the agent runs as a conversation the user can continue, rather than a single non-interactive pass."
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Overrides the model the agent CLI would otherwise pick. Accepted values are the agent's own model names, so an unrecognised one fails when the CLI starts rather than here."
        ),
      presetId: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Applies one of the user's saved launch presets for this agent. Pass an explicit null to ignore the configured default preset rather than inherit it."
        ),
      activateDockOnCreate: z
        .boolean()
        .optional()
        .describe(
          "Whether to open the sidebar dock when the agent is placed there. Only meaningful for a dock placement; it changes what the user sees."
        ),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          "Extra environment variables for the agent process, merged over the inherited environment. These reach a real subprocess, so never put credentials here that the user has not already agreed to expose."
        ),
      excludeFromPersistence: z
        .boolean()
        .optional()
        .describe(
          "Keeps the terminal out of the saved session, so it does not come back after a restart. It also hides the panel from terminal listings, status snapshots and agent-state reads, and spares it from bulk close and kill — so the launching caller cannot find or poll the terminal afterwards. Use for throwaway work the user should not inherit."
        ),
      removeOnExit: z
        .boolean()
        .optional()
        .describe(
          "Closes the panel automatically once the agent process ends, discarding its output. Leave off when the output still needs reading."
        ),
      agentLaunchFlags: z
        .array(z.string())
        .optional()
        .describe(
          "Extra command-line flags passed through to the agent CLI verbatim. Unrecognised flags fail when the CLI starts, not here."
        ),
      spawnedBy: TerminalSpawnSourceSchema.optional(),
      focusPolicy: AddPanelFocusPolicySchema.optional(),
      requestedId: z
        .string()
        .optional()
        .describe(
          "Asks for a specific panel id when the terminal is created, so a caller can correlate the launch it requested with the terminal it got."
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "Skips the check that the agent's CLI can actually run. Without it an unlaunchable CLI opens a setup diagnostic instead of failing; with it the process is started anyway and simply fails. Leave it off unless the check itself is known to be wrong."
        ),
      name: z
        .string()
        .max(200)
        .optional()
        .describe(
          'Always provide a short, task-descriptive name for the terminal tab (e.g. "Claude: auth refactor") so the user can tell parallel agents apart. Pins the title so agent detection cannot overwrite it. Empty/whitespace falls back to the default title.'
        ),
    }),
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
      location: z.enum(["grid", "dock"]).nullable(),
      spawnStatus: z.literal("missing-cli").nullable(),
      worktreeId: z.string().nullable(),
      worktreePath: z.string().nullable(),
      branch: z.string().nullable(),
      cwd: z.string().nullable(),
    }),
    mcpOutputSchema: true,
    run: async (args: unknown) => {
      const {
        agentId,
        location,
        cwd,
        worktreeId,
        prompt,
        interactive,
        model,
        presetId,
        activateDockOnCreate,
        env,
        excludeFromPersistence,
        removeOnExit,
        agentLaunchFlags,
        spawnedBy,
        focusPolicy,
        requestedId,
        force,
        name,
      } = args as {
        agentId: string;
        location?: "grid" | "dock" | "overlay";
        cwd?: string;
        worktreeId?: string;
        prompt?: string;
        interactive?: boolean;
        model?: string;
        presetId?: string | null;
        activateDockOnCreate?: boolean;
        env?: Record<string, string>;
        excludeFromPersistence?: boolean;
        removeOnExit?: boolean;
        agentLaunchFlags?: string[];
        spawnedBy?: TerminalSpawnSource;
        focusPolicy?: "auto" | "preserve" | "take";
        requestedId?: string;
        force?: boolean;
        name?: string;
      };
      const result = await callbacks.onLaunchAgent(agentId, {
        location,
        cwd,
        worktreeId,
        prompt,
        interactive,
        modelId: model,
        presetId,
        activateDockOnCreate,
        env,
        excludeFromPersistence,
        removeOnExit,
        agentLaunchFlags,
        spawnedBy,
        focusPolicy,
        requestedId,
        force,
        name,
      });
      // Nothing to report: the launcher declined (Electron unavailable, a
      // re-entrant launch of the same agent, or a caught spawn failure). Still
      // an object so the MCP output schema stays satisfiable — `launched:false`
      // is the honest discriminant, where a bare null read as a success with no
      // terminal. Genuine rejections (unknown id, unresolvable worktree) throw
      // out of the launcher and surface as ok:false instead.
      if (!result) {
        return {
          launched: false,
          terminalId: null,
          location: null,
          spawnStatus: null,
          worktreeId: null,
          worktreePath: null,
          branch: null,
          cwd: null,
        };
      }
      return {
        // A missing CLI opens a diagnostic panel but starts no agent, so it is
        // not a launch — the caller reads spawnStatus for the reason.
        launched: result.spawnStatus !== "missing-cli",
        terminalId: result.terminalId,
        location: result.location,
        spawnStatus: result.spawnStatus ?? null,
        worktreeId: result.worktreeId,
        worktreePath: result.worktreePath,
        branch: result.branch,
        cwd: result.cwd,
      };
    },
  }));

  actions.set("agent.palette", () => ({
    id: "agent.palette",
    title: "Open Quick Switcher",
    description: "Open the quick switcher to find panels",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      callbacks.onOpenQuickSwitcher();
    },
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
    // Assistant-only agents (e.g. daintree-assistant) have no direct-launch
    // action — they're never spawned as a standalone agent, only used by the
    // Daintree Assistant overlay. Skipping registration keeps them out of the
    // action palette and the MCP action manifest.
    if (isAssistantOnlyAgentId(id)) continue;
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
      run: async (args: unknown) => {
        const { location, spawnedBy, focusPolicy } = (args ?? {}) as {
          location?: "grid" | "dock" | "overlay";
          spawnedBy?: TerminalSpawnSource;
          focusPolicy?: "auto" | "preserve" | "take";
        };
        const result = await callbacks.onLaunchAgent(id, {
          location,
          spawnedBy,
          focusPolicy,
        });
        if (!result) return null;
        return { terminalId: result.terminalId, location: result.location };
      },
    }));
  }

  actions.set("agent.terminal", () => ({
    id: "agent.terminal",
    title: "Launch Terminal",
    description:
      "Open a plain shell terminal with no agent attached, for running ordinary commands. Use an agent launch instead when the intent is to start an AI CLI. This creates a visible panel and starts a shell process, so it consumes resources until closed.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: shortcutLaunchSchema,
    resultSchema: shortcutResultSchema,
    run: async (args: unknown) => {
      const { location, spawnedBy, focusPolicy } = (args ?? {}) as {
        location?: "grid" | "dock" | "overlay";
        spawnedBy?: TerminalSpawnSource;
        focusPolicy?: "auto" | "preserve" | "take";
      };
      const result = await callbacks.onLaunchAgent("terminal", {
        location,
        spawnedBy,
        focusPolicy,
      });
      if (!result) return null;
      return { terminalId: result.terminalId, location: result.location };
    },
  }));

  actions.set("agent.browser", () => ({
    id: "agent.browser",
    title: "Launch Browser",
    description: "Launch a browser panel",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: shortcutLaunchSchema,
    resultSchema: shortcutResultSchema,
    run: async (args: unknown) => {
      const { location, spawnedBy } = (args ?? {}) as {
        location?: "grid" | "dock" | "overlay";
        spawnedBy?: TerminalSpawnSource;
      };
      const result = await callbacks.onLaunchAgent("browser", {
        location,
        spawnedBy,
      });
      if (!result) return null;
      return { terminalId: result.terminalId, location: result.location };
    },
  }));

  actions.set("agent.focusNextWaiting", () => ({
    id: "agent.focusNextWaiting",
    title: "Focus Next Waiting Agent",
    description:
      "Move keyboard focus to the next agent that is blocked waiting on the user, so it can be answered. This changes what the user sees and is a navigation aid only — it reports no agent state. Use an agent status snapshot to find out which agents are waiting and why.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = usePanelStore.getState();
      const worktreeData = getCurrentViewStore().getState();
      const validWorktreeIds = new Set<string>();
      for (const [id, wt] of worktreeData.worktrees) {
        validWorktreeIds.add(id);
        if (wt.worktreeId) validWorktreeIds.add(wt.worktreeId);
      }
      state.focusNextWaiting(state.isInTrash, validWorktreeIds);
    },
  }));

  actions.set("agent.focusNextWaitingGlobal", () => ({
    id: "agent.focusNextWaitingGlobal",
    title: "Focus Next Waiting Agent (All Projects)",
    description:
      "Jump to the next project with a waiting agent. Cycles across all projects in sidebar order, wrapping around.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const projectState = useProjectStore.getState();
      const stats = useProjectStatsStore.getState().stats;
      const projects = projectState.projects;
      if (projects.length === 0) return;

      const currentProjectId = projectState.currentProject?.id ?? null;
      const currentIdx = currentProjectId
        ? projects.findIndex((p) => p.id === currentProjectId)
        : -1;

      // Start the search at the position AFTER the current project so the
      // first comparison hits the next candidate, not currentProject itself.
      // When currentProject isn't in the list (stale state, recently removed),
      // start from the head. Wrap around the full list so a single waiting
      // agent in currentProject still resolves (to a local focus dispatch).
      const startIdx = currentIdx >= 0 ? currentIdx + 1 : 0;
      let target: { id: string } | null = null;
      for (let i = 0; i < projects.length; i++) {
        const idx = (startIdx + i) % projects.length;
        const candidate = projects[idx];
        if (!candidate) continue;
        const waiting = stats[candidate.id]?.waitingAgentCount ?? 0;
        if (waiting > 0) {
          target = candidate;
          break;
        }
      }

      if (!target) return;

      if (target.id === currentProjectId) {
        // Same-project: just cycle within the active view.
        const panelState = usePanelStore.getState();
        const worktreeData = getCurrentViewStore().getState();
        const validWorktreeIds = new Set<string>();
        for (const [id, wt] of worktreeData.worktrees) {
          validWorktreeIds.add(id);
          if (wt.worktreeId) validWorktreeIds.add(wt.worktreeId);
        }
        panelState.focusNextWaiting(panelState.isInTrash, validWorktreeIds);
        return;
      }

      // Cross-project: switch with a one-shot focus intent. The main process
      // delivers `project:focus-on-activate` to the incoming view once the
      // paint gate resolves (cold start) or immediately on cache hit, and
      // the renderer subscriber dispatches local `agent.focusNextWaiting`.
      await projectState.switchProject(target.id, {
        focusIntent: { intent: "focus-next-waiting" },
      });
    },
  }));

  actions.set("agent.focusNextWorking", () => ({
    id: "agent.focusNextWorking",
    title: "Focus Next Working Agent",
    description:
      "Move keyboard focus to the next agent that is currently working, to watch its progress. This changes what the user sees and is a navigation aid only — it reports no agent state. Use an agent status snapshot to find out which agents are working.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = usePanelStore.getState();
      const worktreeData = getCurrentViewStore().getState();
      const validWorktreeIds = new Set<string>();
      for (const [id, wt] of worktreeData.worktrees) {
        validWorktreeIds.add(id);
        if (wt.worktreeId) validWorktreeIds.add(wt.worktreeId);
      }
      state.focusNextWorking(state.isInTrash, validWorktreeIds);
    },
  }));

  actions.set("agent.focusNextAgent", () => ({
    id: "agent.focusNextAgent",
    title: "Focus Next Agent",
    description:
      "Move keyboard focus to the next agent panel in order, cycling back to the first at the end. This changes what the user sees and reports no agent state; use a terminal listing to enumerate panels instead.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = usePanelStore.getState();
      const worktreeData = getCurrentViewStore().getState();
      const validWorktreeIds = new Set<string>();
      for (const [id, wt] of worktreeData.worktrees) {
        validWorktreeIds.add(id);
        if (wt.worktreeId) validWorktreeIds.add(wt.worktreeId);
      }
      state.focusNextAgent(state.isInTrash, validWorktreeIds);
    },
  }));

  actions.set("dock.focusNextWaiting", () => ({
    id: "dock.focusNextWaiting",
    title: "Focus Next Blocked Dock Agent",
    description: "Jump to the next waiting agent in the dock",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = usePanelStore.getState();
      const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
      state.focusNextBlockedDock(activeWorktreeId ?? undefined, state.getPanelGroup);
    },
  }));

  actions.set("agent.getState", () => ({
    id: "agent.getState",
    title: "Get Agent State",
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
    run: async (args: unknown) => {
      const { agentId } = args as { agentId: string };
      const state = usePanelStore.getState();
      for (const id of state.panelIds) {
        const panel = state.panelsById[id];
        // Skip tooling-internal panels (e.g. the Daintree Assistant's own dock
        // terminal) for the same reason terminal.list filters them — the
        // assistant must not be able to introspect its own process.
        if (!panel || !isPtyPanel(panel) || panel.excludeFromPersistence === true) continue;
        const effectiveAgentId = panel.detectedAgentId ?? panel.launchAgentId;
        if (effectiveAgentId === agentId) {
          return {
            agentId,
            state: panel.agentState ?? null,
            waitingReason: panel.agentState === "waiting" ? (panel.waitingReason ?? null) : null,
            lastTransitionAt: panel.lastStateChange ?? null,
            exitCode: panel.exitCode ?? null,
            spawnedAt: panel.startedAt ?? null,
            terminalId: panel.id,
            found: true,
          };
        }
      }
      return {
        agentId,
        state: null,
        waitingReason: null,
        lastTransitionAt: null,
        exitCode: null,
        spawnedAt: null,
        terminalId: null,
        found: false,
      };
    },
  }));

  actions.set("agentSessionHistory.list", () => ({
    id: "agentSessionHistory.list",
    title: "List Resumable Sessions",
    description:
      "List closed agent sessions that can be relaunched, read from the on-disk journal. This is a faithful record of which sessions exist, not a summary of what happened in them — it carries no transcript text. It must be scoped to a worktree or project and fails rather than listing every project when no scope can be resolved. Old sessions are pruned by the journal's retention policy, so absence does not mean a session never existed.",
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
    run: async (args: unknown, ctx: ActionContext) => {
      // `args ?? {}` means zod always parses the object branch, so the schema
      // defaults for limit/offset are always applied.
      const { worktreeId, projectId, limit, offset } = SessionHistoryListArgsSchema.parse(
        args ?? {}
      ) ?? { limit: SESSION_LIST_DEFAULT_LIMIT, offset: 0 };
      // Explicit args are honoured verbatim — never widened, and never silently
      // narrowed with context the caller didn't ask for. Falling back to
      // context contributes BOTH ids when it has them: a worktree id is a
      // normalized absolute path, so the same worktree opened as its own
      // project journals records under a different projectId. Scoping by
      // worktree alone would surface that other project's sessions and could
      // even fill the whole page with them.
      let scopeWorktreeId: string | undefined;
      let scopeProjectId: string | undefined;
      if (worktreeId || projectId) {
        scopeWorktreeId = worktreeId;
        scopeProjectId = projectId;
      } else if (ctx.activeWorktreeId || ctx.projectId || ctx.scratchId) {
        scopeWorktreeId = ctx.activeWorktreeId;
        // A scratch view has neither a project nor any git worktrees, but its
        // terminals are journaled under the opaque scratch id as their
        // ownership stamp (see the terminal.create handler). Without this the
        // scope guard turns every scratch into a dead end (#11482 class).
        scopeProjectId = ctx.projectId ?? ctx.scratchId;
      } else {
        // Throw rather than return empty: an empty list is indistinguishable
        // from a valid scope that simply has no sessions, which would read as
        // "nothing to resume" and send an agent down the wrong path.
        throw new Error(
          "No session history scope: pass worktreeId or projectId, or dispatch from an active worktree or project"
        );
      }
      const sessions = await window.electron.agentSessionHistory.list(
        scopeWorktreeId,
        scopeProjectId
      );
      // The journal is already newest-first (main sorts by `savedAt` descending
      // after eviction), so the window keeps the most recent records.
      const total = sessions.length;
      const scanned = sessions.slice(offset, offset + limit);
      // `hasMore` is computed from the unfiltered slice: paging is over the
      // journal's records, so a row dropped as unrepresentable must not read as
      // "end of list" and strand the records behind it.
      const hasMore = offset + scanned.length < total;
      const page = keepRepresentableRecords(scanned.map(toAgentFacingRecord));
      return { sessions: page, total, hasMore };
    },
  }));

  actions.set("session.bookmarkAndClose", () => ({
    id: "session.bookmarkAndClose",
    title: "Bookmark and close",
    description:
      "Capture a live agent pane's resumable conversation as a durable bookmark, then close the pane once the session is saved. Args: `terminalId` (the target agent pane) and a non-empty `label`. Confirmation is enforced by the dispatch layer, not an argument. Only agents with exact-session resume are eligible, and the target must be a live local pane. Prepare-before-remove: if capture or persistence fails the pane stays open and no bookmark is created. This interrupts a running agent and discards terminal scrollback — the conversation is resumable, the live process is not. Returns { record }.",
    category: "agent",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Interrupts a running agent and removes its pane. The conversation is bookmarked and resumable, but the live process and terminal scrollback are discarded.",
    // danger:"confirm" gates agent/plugin dispatch through ActionService (the
    // caller must attest confirmation via the dispatch option) — no confirm
    // dialog exists in Phase 1; the Phase-2 pane dialog will supply it. Hidden
    // from the palette so a source:"user" pick can't bypass the D1 guard.
    palette: { mode: "hidden" },
    argsSchema: BookmarkAndCloseArgsSchema,
    run: async (args: unknown) => {
      const { terminalId, label } = BookmarkAndCloseArgsSchema.parse(args);
      const panelStore = usePanelStore.getState();
      const panel = panelStore.getTerminal(terminalId);
      // Require a live local agent pane: the same id must resolve here (for the
      // metadata snapshot and the pane removal) AND in main (for the capture).
      // Acting on a stale/cross-project id would kill a main terminal while
      // leaving its owning pane on screen (dead).
      if (!panel || !isPtyPanel(panel)) {
        throw new Error(`No local agent pane for terminal ${terminalId}`);
      }
      const location = panel.location;
      const metadata = {
        sourcePanelId: terminalId,
        sourceLocation: location === "grid" || location === "dock" ? location : undefined,
        titleMode: panel.titleMode,
        agentPresetId: panel.agentPresetId,
        agentPresetColor: panel.agentPresetColor,
        originalPresetId: panel.originalPresetId,
        isUsingFallback: panel.isUsingFallback,
        fallbackChainIndex: panel.fallbackChainIndex,
        isInputLocked: panel.isInputLocked,
      };
      const { record } = await window.electron.agentSessionHistory.prepareBookmark({
        terminalId,
        label,
        metadata,
      });
      // Persisted successfully — remove the pane without a redundant second kill
      // (prepareBookmark already gracefully shut the agent down in main).
      panelStore.removePanel(terminalId, { backendAlreadyClosed: true });
      return { record };
    },
  }));

  actions.set("session.bookmark.promote", () => ({
    id: "session.bookmark.promote",
    title: "Add bookmark to session",
    description:
      "Pin an existing resumable session (from history) as a durable bookmark, keyed by `sessionId`, without launching it. Args: `sessionId` and a non-empty `label`. Bookmarked sessions are exempt from history retention and the per-worktree cap until deleted. Returns the updated record.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: BookmarkMutateArgsSchema,
    run: async (args: unknown) => {
      const { sessionId, label } = BookmarkMutateArgsSchema.parse(args);
      return window.electron.agentSessionHistory.promoteBookmark({ sessionId, label });
    },
  }));

  actions.set("session.bookmark.rename", () => ({
    id: "session.bookmark.rename",
    title: "Rename bookmark",
    description:
      "Change a bookmark's label without touching the agent session or its title. Args: `sessionId` and a non-empty `label`. Only an already-bookmarked session can be renamed. Returns the updated record.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: BookmarkMutateArgsSchema,
    run: async (args: unknown) => {
      const { sessionId, label } = BookmarkMutateArgsSchema.parse(args);
      return window.electron.agentSessionHistory.renameBookmark({ sessionId, label });
    },
  }));

  actions.set("session.bookmark.delete", () => ({
    id: "session.bookmark.delete",
    title: "Delete bookmark",
    description:
      "Remove a bookmark, demoting the session back to ordinary time-limited history. Args: `sessionId`. Confirmation is enforced by the dispatch layer, not an argument. Does NOT delete the provider's transcript or any open pane. Irreversible for the Daintree bookmark.",
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
    run: async (args: unknown) => {
      const { sessionId } = BookmarkDeleteArgsSchema.parse(args);
      await window.electron.agentSessionHistory.deleteBookmark({ sessionId });
    },
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
    run: async (args: unknown, ctx: ActionContext) => {
      const { projectId, limit, offset } = BookmarkListArgsSchema.parse(args ?? {}) ?? {
        limit: SESSION_LIST_DEFAULT_LIMIT,
        offset: 0,
      };
      // Bookmarks are project-scoped (privacy). Resolve the explicit arg, then the
      // caller's project context. With neither, DO NOT fall open to every project
      // — return empty; an all-project view is a deliberate future enhancement.
      const scope = projectId ?? ctx.projectId ?? ctx.scratchId;
      if (!scope) return { bookmarks: [], total: 0, hasMore: false };
      const bookmarks = await window.electron.agentSessionHistory.listBookmarks({
        projectId: scope,
      });
      // Bookmarks are exempt from both the age window and the per-worktree cap,
      // so this set grows without bound — the limit is the only thing holding
      // the agent-facing payload down, and the offset is how a caller still
      // reaches a bookmark that sits past it (#11530).
      const total = bookmarks.length;
      const scanned = bookmarks.slice(offset, offset + limit);
      const hasMore = offset + scanned.length < total;
      const page = keepRepresentableRecords(scanned.map(toAgentFacingRecord));
      return { bookmarks: page, total, hasMore };
    },
  }));

  actions.set("agent.listToolbar", () => ({
    id: "agent.listToolbar",
    title: "List Toolbar Agents",
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
    run: async () => {
      const { settings, availability } = await readAgentDiscoveryState();
      return {
        agents: LAUNCHABLE_AGENT_IDS.map((id) => {
          const entry = settings.agents?.[id];
          const state = availability[id];
          // Omit `pinned` unless it's an explicit boolean (tri-state): an
          // absent key means "follows CLI availability", distinct from an
          // explicit true/false pin/unpin. A non-boolean from a corrupted
          // config is treated as absent, never forwarded.
          return {
            id,
            displayName: getAgentDisplayTitle(id),
            ...(typeof entry?.pinned === "boolean" ? { pinned: entry.pinned } : {}),
            installed: isAgentInstalled(state),
            visible: isAgentToolbarVisible(entry, state),
          };
        }),
      };
    },
  }));

  actions.set("agent.listAvailable", () => ({
    id: "agent.listAvailable",
    title: "List Available Agents",
    description:
      "List every registered agent — built-in, user-defined and plugin-contributed — from the authoritative registry, including ones that are not currently launchable. Use this before launching so an id is known to exist, and read each entry's launchability rather than assuming membership implies it. Those fields appear only once a live probe of each CLI finishes, and the result says so while that is incomplete.",
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
    run: async () => {
      const [{ settings, availability, availabilityLive }, registry, userRegistry] =
        await readAvailableAgentSources();
      const registryIds = [
        ...LAUNCHABLE_AGENT_IDS.filter((id) => Object.hasOwn(registry, id)),
        ...Object.keys(registry)
          .filter((id) => !isBuiltInAgentId(id) && !isAssistantOnlyAgentId(id))
          .sort(),
      ];
      return {
        complete: true as const,
        // Only certify completeness once a live probe has run: a hydrating cache
        // synthesizes "missing" for unprobed agents, which would otherwise pass
        // the own-key check and mislabel a never-checked agent as uninstalled.
        availabilityComplete:
          availabilityLive && registryIds.every((id) => Object.hasOwn(availability, id)),
        agents: registryIds.map((id) => {
          // `rawState` mirrors what the toolbar renders (used for toolbarVisible);
          // `probedState` is the authoritative probe result we're willing to
          // report as availability/installed/launchable — undefined until live.
          const rawState = availability[id];
          const probedState = availabilityLive ? rawState : undefined;
          const builtIn = isBuiltInAgentId(id);
          const entry = builtIn ? settings.agents?.[id] : undefined;
          return {
            id,
            displayName: registry[id]?.name ?? id,
            source: builtIn
              ? ("built-in" as const)
              : Object.prototype.hasOwnProperty.call(userRegistry, id)
                ? ("user" as const)
                : ("plugin" as const),
            ...(probedState
              ? {
                  availability: probedState,
                  installed: isAgentInstalled(probedState),
                  launchable: isAgentLaunchable(probedState),
                }
              : {}),
            ...(builtIn && typeof entry?.pinned === "boolean" ? { pinned: entry.pinned } : {}),
            ...(builtIn ? { toolbarVisible: isAgentToolbarVisible(entry, rawState) } : {}),
          };
        }),
      };
    },
  }));

  /**
   * Read the three layers a merged preset list is built from.
   *
   * Deliberately reads the same renderer stores the launcher resolves against
   * rather than re-fetching over IPC. A fresh IPC read could report a preset
   * the launcher's stores have not installed yet, and an id that cannot be
   * launched is worse than an id reported a moment late — the whole point of
   * this listing is that what it returns is what a launch will accept.
   *
   * Settings keep the cache-aware client fallback because that layer has one;
   * the two preset stores do not, so they carry hydration markers instead and
   * an unproven snapshot is reported as incomplete rather than guessed at.
   */
  const readAgentPresetSources = async (agentId: string, projectId: string | undefined) => {
    const [{ useAgentSettingsStore }, { useCcrPresetsStore }, { useProjectPresetsStore }] =
      await Promise.all([
        import("@/store/agentSettingsStore"),
        import("@/store/ccrPresetsStore"),
        import("@/store/projectPresetsStore"),
      ]);

    const storeSettings = useAgentSettingsStore.getState().settings;
    const settings = storeSettings ?? (await agentSettingsClient.get());
    const ccrState = useCcrPresetsStore.getState();
    const projectState = useProjectPresetsStore.getState();

    // Without a project in scope there are no repository presets to miss, so
    // that layer is complete by having nothing in it. With one, the snapshot
    // only counts if it demonstrably belongs to that project — the store is
    // reused across project switches, and serving another project's presets
    // would hand back ids this project cannot launch.
    const projectScoped = projectId !== undefined && projectState.hydratedProjectId === projectId;

    return {
      customPresets: settings?.agents?.[agentId]?.customPresets,
      // Passed through exactly as stored: `undefined` keeps the built-in
      // registry presets, while any array replaces them wholesale.
      ccrPresets: ccrState.ccrPresetsByAgent[agentId],
      projectPresets: projectScoped ? projectState.presetsByAgent[agentId] : undefined,
      presetsComplete:
        settings != null && ccrState.isInitialized && (projectId === undefined || projectScoped),
    };
  };

  actions.set("agent.listPresets", () => ({
    id: "agent.listPresets",
    title: "List Agent Presets",
    description:
      "List the launch presets for one agent, merged across user settings, repository preset files and CCR discovery in the precedence the launcher applies, so every id returned is one a launch will accept. Identity only: no environment values or flags. While the completeness flag is false a source is still loading.",
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
    run: async (args: unknown, ctx: ActionContext) => {
      const { agentId, projectId: requestedProjectId } = AgentListPresetsArgsSchema.parse(
        args ?? {}
      );
      const projectId = requestedProjectId ?? ctx.projectId;
      const sources = await readAgentPresetSources(agentId, projectId);

      return {
        presetsComplete: sources.presetsComplete,
        presets: getMergedPresetIdentities(
          agentId,
          sources.customPresets,
          sources.ccrPresets,
          sources.projectPresets
        ),
      };
    },
  }));

  actions.set("agent.focusPreviousAgent", () => ({
    id: "agent.focusPreviousAgent",
    title: "Focus Previous Agent",
    description:
      "Move keyboard focus to the previous agent panel in order, cycling to the last at the beginning. This changes what the user sees and reports no agent state; use a terminal listing to enumerate panels instead.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    run: async () => {
      const state = usePanelStore.getState();
      const worktreeData = getCurrentViewStore().getState();
      const validWorktreeIds = new Set<string>();
      for (const [id, wt] of worktreeData.worktrees) {
        validWorktreeIds.add(id);
        if (wt.worktreeId) validWorktreeIds.add(wt.worktreeId);
      }
      state.focusPreviousAgent(state.isInTrash, validWorktreeIds);
    },
  }));
}
