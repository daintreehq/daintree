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
import { AGENT_REGISTRY, getAgentDisplayTitle } from "@/config/agents";
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

  actions.set("agent.launch", () => ({
    id: "agent.launch",
    title: "Launch Agent",
    description:
      "Launch an AI agent in a new terminal. Returns { launched, terminalId, location, worktreeId, worktreePath, branch, cwd } — the resolved identity tells you where the agent landed, so parallel launches can be mapped back to their work without re-resolving the target. `launched: true` means the panel was created and its process is starting, NOT that the agent is ready — poll agent.getState or terminal.getStatus for that. `launched: false` means no agent is running: either nothing was created (every field null) or the CLI is missing, where Daintree opened a setup diagnostic instead (terminalId is that panel, spawnStatus is missing-cli). Fire up to 4 in parallel per message.",
    category: "agent",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      agentId: AgentIdSchema,
      location: LaunchLocationSchema.optional(),
      cwd: z.string().optional(),
      worktreeId: z.string().optional(),
      prompt: z.string().optional(),
      interactive: z.boolean().optional(),
      model: z.string().optional(),
      presetId: z.string().nullable().optional(),
      activateDockOnCreate: z.boolean().optional(),
      env: z.record(z.string(), z.string()).optional(),
      excludeFromPersistence: z.boolean().optional(),
      removeOnExit: z.boolean().optional(),
      agentLaunchFlags: z.array(z.string()).optional(),
      spawnedBy: TerminalSpawnSourceSchema.optional(),
      focusPolicy: AddPanelFocusPolicySchema.optional(),
      requestedId: z.string().optional(),
      force: z.boolean().optional(),
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
    description: "Launch a plain terminal",
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
    description: "Focus the next agent in waiting state",
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
      await projectState.switchProject(target.id, { focusIntent: "focus-next-waiting" });
    },
  }));

  actions.set("agent.focusNextWorking", () => ({
    id: "agent.focusNextWorking",
    title: "Focus Next Working Agent",
    description: "Focus the next agent in working state",
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
    description: "Cycle through all agent panels",
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
      "Look up the live state of an agent by its agent id. Args: `agentId` (required) — agent id such as 'claude' or 'codex', as seen in `terminal.list` entries' `agentId` field. Returns { agentId, state, waitingReason ('prompt'|'question'|'approval'|'error', non-null only when state is 'waiting'), lastTransitionAt, exitCode (number|null — set once the PTY has exited, null while running or on a signal kill; read alongside `state` to tell pass from fail), spawnedAt, terminalId, found }. Never errors — an unknown agent returns found:false with null fields. Do NOT use this to enumerate terminals — use `terminal.list` or `terminal.getStatus`.",
    category: "agent",
    kind: "query",
    danger: "safe",
    scope: "renderer",
    argsSchema: z.object({
      agentId: z
        .string()
        .min(1)
        .describe(
          "Agent id to look up (e.g. 'claude', 'codex') — from `terminal.list` entries' `agentId` field."
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
      "List resumable agent sessions from the on-disk journal — the closed sessions the user can relaunch. A faithful record listing, NOT a summary of what happened in each session. Requires a scope: pass `worktreeId` and/or `projectId` (they combine), else the caller's worktree and project context is used; with no resolvable scope this throws rather than listing every project. Args: `worktreeId`, `projectId`, `limit` (default 20, max 100), `offset` (default 0). Returns { sessions: [{ sessionId, agentId, worktreeId, title, projectId, savedAt (epoch ms; newest-first), agentLaunchFlags?, agentModelId?, cwd?, branch?, bookmark? }], total, hasMore } — `total` counts the scoped records before paging; when `hasMore` is true, advance `offset` for the next page. Pruned by the journal's retention policy. To relaunch a session, feed its `agentId`/`cwd`/`worktreeId`/`agentLaunchFlags`/`agentModelId` into `agent.launch`.",
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
      "List the user's durable session bookmarks for one project, newest-first by bookmark time. Args: `projectId` (optional) — the project to scope to; when omitted the caller's project context is used. `limit` (default 20, max 100) and `offset` (default 0). Bookmarks are project-scoped: with no explicit `projectId` and no project context this returns an empty list rather than leaking bookmarks across projects. Returns { bookmarks: [{ sessionId, agentId, worktreeId, title, projectId, savedAt, agentLaunchFlags?, agentModelId?, cwd?, branch?, bookmark: { bookmarkedAt, label, ... } }], total, hasMore } — `total` counts the project's bookmarks before paging; bookmarks never expire, so advance `offset` while `hasMore` is true to reach them all. Read-only metadata; NO transcript content. Never errors.",
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
      "List the built-in agents and their resolved toolbar visibility. Returns { agents: [{ id, displayName, pinned, installed, visible }] } for every launchable built-in agent. `pinned` is tri-state: true (explicitly pinned), false (explicitly hidden), or omitted (follows CLI availability). `installed` is whether the agent's CLI binary was detected. `visible` is the resolved toolbar state — true when the agent button currently shows in the toolbar. Use this to discover which agents the user has surfaced without reading the full agent settings.",
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
      "List every registered direct-agent candidate in Daintree's current effective registry, including built-in, user-defined, and plugin agents. Returns { complete, availabilityComplete, agents: [{ id, displayName, source, availability?, installed?, launchable?, pinned?, toolbarVisible? }] }. Registry membership comes from the authoritative main process; `complete` marks a full (never-truncated) read of the current effective registry — plugin agents still initializing at call time appear on a later call. `launchable` is true only for ready/unauthenticated agents and is omitted with availability (and `availabilityComplete` is false) until a live CLI probe has finished this session — never inferred from the still-hydrating cache. Built-in rows include tri-state explicit pin intent and resolved main-toolbar visibility; user/plugin rows omit toolbar fields because they are not toolbar entries.",
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
        await Promise.all([
          readAgentDiscoveryState(),
          agentCapabilitiesClient.getRegistry(),
          userAgentRegistryClient.get(),
        ]);
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

  actions.set("agent.focusPreviousAgent", () => ({
    id: "agent.focusPreviousAgent",
    title: "Focus Previous Agent",
    description: "Cycle backwards through all agent panels",
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
