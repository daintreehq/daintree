// The agent actions' run bodies, loaded on first dispatch by `runAgentAction`
// in agentActions.ts, which keeps the metadata every view registers at boot
// (#14268). Nothing here may import agentActions.ts at runtime.
import type { ActionCallbacks, LaunchDecline } from "../actionTypes";
import { requireExplicitWorktreeForAgentDispatch, requireWorktreeId } from "./locationArgs";
import { resumeSessionIntoPanel } from "@/services/agentResume";
import { resolveResumeLaunchTarget } from "@/utils/resumeLaunch";
import { inferWorktreeIdFromCwd } from "@/utils/worktreePaths";
import { isForegroundDispatch } from "./dispatchSource";
import { getWorktreePathIndex } from "@/store/storeAccessors";
import {
  keepRepresentableRecords,
  pageAgentFacingSessions,
  toAgentFacingRecord,
} from "@shared/utils/agentSessionProjection";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import {
  getAgentDisplayTitle,
  getMergedPresetIdentities,
  isRegisteredAgent,
} from "@/config/agents";
import {
  agentCapabilitiesClient,
  agentSettingsClient,
  agentToolbarPinsClient,
  cliAvailabilityClient,
} from "@/clients";
import { agentToolbarPin } from "@shared/types/ipc/agentToolbarPins";
import { userAgentRegistryClient } from "@/clients/userAgentRegistryClient";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { isAgentToolbarVisible } from "@shared/utils/agentPinned";
import { buildAvailableAgentListing, listedAgentIds } from "@shared/utils/agentListing";
import { launchModelRefusal, unknownAgentIdMessage } from "@/utils/agentLaunchValidation";
import { isAgentInstalled } from "@shared/utils/agentAvailability";
import { hasSystemPromptOverride, resolveSystemPromptArgs } from "@shared/utils/agentSystemPrompt";
import { UnactionableTargetError } from "@/services/actions/unactionableTarget";
import {
  agentPresetMutationUpdates,
  planAgentPresetMutation,
  type AgentPresetMutationActionId,
} from "./agentPresetMutation";
import { appendHandbackInstruction, mintHandbackCode } from "@shared/utils/handback";
import type { ActionContext } from "@shared/types/actions";
import type { AgentPreset } from "@shared/config/agentRegistry";
import { isPtyPanel, type TerminalSpawnSource } from "@shared/types/panel";
import {
  AgentListModelsArgsSchema,
  AgentListPresetsArgsSchema,
  BookmarkAndCloseArgsSchema,
  BookmarkDeleteArgsSchema,
  BookmarkListArgsSchema,
  BookmarkMutateArgsSchema,
  ResumeSessionArgsSchema,
  SESSION_LIST_DEFAULT_LIMIT,
  SessionHistoryListArgsSchema,
} from "./agentActionArgs";

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

/**
 * Ceiling for one preset-source read.
 *
 * Sized well under Main's 30s dispatch timeout so a stalled IPC surfaces as a
 * named error here rather than leaving the renderer action — and the spawn
 * guard's lease — pending after Main has already abandoned the request. Much
 * tighter than `AGENT_DISCOVERY_READ_TIMEOUT_MS` because none of these legs
 * can fall through to a CLI probe; they read settings that are already loaded
 * or already failed.
 */
const AGENT_PRESET_READ_TIMEOUT_MS = 10_000;

async function withReadDeadline<T>(work: Promise<T>, leg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Timed out after ${AGENT_PRESET_READ_TIMEOUT_MS}ms reading ${leg} for preset discovery`
          )
        ),
      AGENT_PRESET_READ_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const readAgentDiscoveryState = async () => {
  // These are the same renderer stores the toolbar reads: this machine's pins
  // (#14702) and the view's host's availability. Fall back to IPC only before
  // they hydrate.
  const [{ useAgentToolbarPinsStore }, { useCliAvailabilityStore }] = await Promise.all([
    import("@/store/agentToolbarPinsStore"),
    import("@/store/cliAvailabilityStore"),
  ]);
  const pinsState = useAgentToolbarPinsStore.getState();
  const pins = pinsState.revision >= 0 ? pinsState.pins : (await agentToolbarPinsClient.get()).pins;
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
  return { pins, availability, availabilityLive };
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

/** Launch ids the launcher always turns into a panel, never an agent. */
const HANDBACK_PANEL_LAUNCH_IDS: ReadonlySet<string> = new Set(["browser", "dev-preview"]);

/**
 * Prove a session id belongs to the caller's project before mutating it.
 *
 * The bookmark mutations identify a session by `sessionId` alone, and main
 * matches that id against the WHOLE journal — `promoteBookmark` and friends
 * scan every record on disk, not just the current project's. That was
 * tolerable while the only callers were this project's own bookmark UI. Once
 * #11908 put these on the assistant's action tier it stopped being tolerable:
 * an id from another project, guessed or carried over from an earlier turn,
 * would promote, rename, or delete that project's bookmark and hand its
 * metadata back in the result.
 *
 * Scope is taken from the dispatch context, never from an argument — an
 * argument the caller supplies is not a boundary it can be held to. With no
 * project in context an agent dispatch is refused outright, while a human
 * surface keeps working as before: this guard tightens what a model can reach
 * and must not break the UI it was already safe for (mirrors
 * `requireExplicitWorktreeForAgentDispatch`).
 */
async function requireSessionInCallerProject(sessionId: string, ctx: ActionContext) {
  const projectScope = ctx.projectId ?? ctx.scratchId;
  if (!projectScope) {
    // Both headless sources are refused, named explicitly rather than via
    // `!isForegroundDispatch`: that helper treats an ABSENT source as
    // non-foreground, which would reject the bare `run(args, {})` shape the
    // action unit tests use throughout. Same reasoning as
    // `requireExplicitWorktreeForAgentDispatch`.
    if (ctx.dispatchSource === "agent" || ctx.dispatchSource === "plugin") {
      throw new Error(
        "No project in scope — this call can't be checked against a project, so it is refused."
      );
    }
    return;
  }
  const records = await window.electron.agentSessionHistory.list(undefined, projectScope);
  if (!records.some((record) => record.sessionId === sessionId)) {
    // Deliberately the same wording whether the id is unknown or belongs to
    // another project: distinguishing them would confirm that a guessed id
    // exists somewhere, which is the probe this guard exists to stop.
    throw new Error("No session with that id in this project.");
  }
}

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
const readAgentPresetSources = async (
  agentId: string,
  projectId: string | undefined,
  scopeKnown: boolean
) => {
  const [{ useAgentSettingsStore }, { useCcrPresetsStore }, { useProjectPresetsStore }] =
    await Promise.all([
      import("@/store/agentSettingsStore"),
      import("@/store/ccrPresetsStore"),
      import("@/store/projectPresetsStore"),
    ]);

  const storeSettings = useAgentSettingsStore.getState().settings;
  // Only the store is certifiable. The launcher resolves a preset id against
  // that store, so a preset that exists solely in a client response is one
  // this listing would promise and the next launch would fail to find. The
  // fallback still runs, because naming presets before hydration is useful —
  // it just cannot be reported as settled.
  const settings =
    storeSettings ??
    (await withReadDeadline(agentSettingsClient.get(), "agentSettings").catch(() => null));
  const ccrState = useCcrPresetsStore.getState();
  const projectState = useProjectPresetsStore.getState();

  // `agentId` is caller-supplied and unconstrained, so an inherited key like
  // `__proto__` would otherwise resolve to `Object.prototype` and throw on
  // the first array operation. Own-key plus shape checks also keep a
  // corrupted persisted map from reaching the merge.
  const ownBucket = (
    byAgent: Record<string, AgentPreset[]>,
    id: string
  ): AgentPreset[] | undefined => {
    if (!Object.hasOwn(byAgent, id)) return undefined;
    const bucket = byAgent[id];
    return Array.isArray(bucket) ? bucket : undefined;
  };

  // A project in scope contributes presets only when the loaded snapshot
  // demonstrably belongs to it: the store is reused across project switches,
  // and serving another project's presets would hand back ids this project
  // cannot launch.
  const projectScoped = projectId !== undefined && projectState.hydratedProjectId === projectId;
  const agents = settings?.agents;
  const entry = agents && Object.hasOwn(agents, agentId) ? agents[agentId] : undefined;

  return {
    customPresets: entry?.customPresets,
    // Passed through exactly as stored: an absent key keeps the built-in
    // registry presets, while an own array — `[]` included — replaces them.
    ccrPresets: ownBucket(ccrState.ccrPresetsByAgent, agentId),
    projectPresets: projectScoped ? ownBucket(projectState.presetsByAgent, agentId) : undefined,
    presetsComplete:
      storeSettings != null &&
      ccrState.isInitialized &&
      // No project id has two meanings. A scratch workspace genuinely has no
      // repository presets, so nothing is missing there. A view that has not
      // resolved its workspace at all is simply unknown, and certifying that
      // as complete would report a project's presets as absent rather than
      // unread.
      (projectId !== undefined ? projectScoped : scopeKnown),
  };
};
/**
 * Plan and write one user-preset change (#16047) through the store and
 * `updateAgent` Settings uses, so a preset made from a chat is stored exactly
 * as one made by hand. Planned again here rather than reusing the preview's
 * plan: a patch applies to the preset as it stands now, and a preset removed
 * while the dialog was open is refused rather than written back.
 */
async function runPresetWrite(
  actionId: AgentPresetMutationActionId,
  args: unknown,
  ctx: ActionContext
): Promise<{ presetId: string; name: string; agentDefaultCleared?: boolean }> {
  const [{ useAgentSettingsStore }, { readPresetWriteSources }] = await Promise.all([
    import("@/store/agentSettingsStore"),
    import("./agentPresetSources"),
  ]);
  await useAgentSettingsStore.getState().initialize();
  const plan = planAgentPresetMutation(
    actionId,
    args,
    readPresetWriteSources(ctx.projectId),
    `user-${crypto.randomUUID()}`
  );
  if (!plan.ok) throw new UnactionableTargetError(plan.message);
  const { mutation } = plan;
  await useAgentSettingsStore
    .getState()
    .updateAgent(mutation.agentId, agentPresetMutationUpdates(mutation));
  const written = {
    presetId: mutation.preset.id,
    name: typeof mutation.preset.name === "string" ? mutation.preset.name : "",
  };
  return mutation.operation === "delete"
    ? { ...written, agentDefaultCleared: mutation.wasAgentDefault }
    : written;
}

/** Run for the per-agent shortcut actions (`agent.claude`, `agent.codex`, …). */
export async function launchAgentShortcut(
  id: string,
  args: unknown,
  callbacks: ActionCallbacks
): Promise<unknown> {
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
}

export const agentActionRuns = {
  "agent.launch": async (args: unknown, ctx: ActionContext, callbacks: ActionCallbacks) => {
    const {
      agentId,
      location,
      cwd,
      worktreeId,
      prompt,
      handback,
      notify,
      systemPrompt,
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
      location?: "grid" | "dock" | "overlay" | "background";
      cwd?: string;
      worktreeId?: string;
      prompt?: string;
      handback?: boolean;
      notify?: boolean;
      systemPrompt?: string;
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
    // A requested id asks for a NEW panel. One this view already holds is
    // refused here rather than handed to the launcher, whose in-place update
    // would overwrite the live panel's record while its spawn is refused with
    // the original process still running — and an MCP caller would then be
    // recorded as having created it (#12407). Checked against the store a
    // listing reads, so any id a caller could have learned is already in it.
    if (
      requestedId !== undefined &&
      Object.hasOwn(usePanelStore.getState().panelsById, requestedId)
    ) {
      throw new Error(
        `A panel with id '${requestedId}' already exists. Omit the requested id, or choose one no panel is using.`
      );
    }
    // Refused here, before anything launches: the launcher swallows its own
    // failures into `launched:false`, which a caller would read as a
    // transient miss rather than an instruction this agent can never take.
    const systemPromptArgs = resolveSystemPromptArgs(agentId, systemPrompt);
    if (!systemPromptArgs.ok) throw new UnactionableTargetError(systemPromptArgs.reason);
    if (systemPromptArgs.args.length > 0 && hasSystemPromptOverride(agentLaunchFlags, agentId)) {
      throw new UnactionableTargetError(
        "agentLaunchFlags already sets this agent's system-prompt instruction. Pass it in systemPrompt or agentLaunchFlags, not both."
      );
    }
    const modelRefusal = launchModelRefusal(agentId, {
      model,
      interactive,
      prompt,
      agentLaunchFlags,
    });
    if (modelRefusal) throw new UnactionableTargetError(modelRefusal);
    // The handback instruction rides the prompt, so there is nothing to attach
    // it to without one — and a blank prompt is dropped by the launcher
    // (#12488).
    if (handback === true && (prompt === undefined || prompt.trim() === "")) {
      throw new UnactionableTargetError(
        "handback asks the agent to mark the end of its reply to `prompt`, so it needs a non-empty `prompt`. Pass one, or launch without handback."
      );
    }
    // An id nothing registers is most often a misspelt agent ("anti-gravity"
    // for `antigravity`): say that, rather than blaming the handback or the
    // notice that came with it.
    if (
      (handback === true || notify === true) &&
      agentId !== "terminal" &&
      !HANDBACK_PANEL_LAUNCH_IDS.has(agentId) &&
      !isRegisteredAgent(agentId)
    ) {
      throw new UnactionableTargetError(unknownAgentIdMessage(agentId));
    }
    // A plain shell or a non-terminal panel has no agent to answer it. The
    // panel ids are checked by name: the launcher opens their panel even
    // when a registry entry happens to share the id.
    if (
      handback === true &&
      (HANDBACK_PANEL_LAUNCH_IDS.has(agentId) || !isRegisteredAgent(agentId))
    ) {
      throw new UnactionableTargetError(
        "handback needs an agent to answer it, and this id is not a registered agent: a plain shell or panel never prints the marker. Launch a registered agent, or launch without handback."
      );
    }
    // `notify` is acted on in main, which cannot see this registry; refusing
    // here is what cancels the notice it set up for a launch.
    if (
      notify === true &&
      (HANDBACK_PANEL_LAUNCH_IDS.has(agentId) || !isRegisteredAgent(agentId))
    ) {
      throw new UnactionableTargetError(
        "notify waits for an agent to stop working, and this id is not a registered agent: a plain shell or panel never reports working or idle. Launch a registered agent, or launch without notify."
      );
    }
    // The background list only shows terminal panes, so a parked browser or
    // dev preview would be running with no way back to it.
    if (location === "background" && HANDBACK_PANEL_LAUNCH_IDS.has(agentId)) {
      throw new UnactionableTargetError(
        `A ${agentId} panel can't be launched into the background. Launch it in the grid or dock instead.`
      );
    }
    const handbackCode = handback === true ? mintHandbackCode() : undefined;
    let decline: LaunchDecline | null = null;
    const result = await callbacks.onLaunchAgent(agentId, {
      location,
      cwd,
      worktreeId,
      prompt:
        handbackCode !== undefined && prompt !== undefined
          ? appendHandbackInstruction(
              prompt,
              handbackCode,
              // A scheduled run's agent can also say it needs the user (#15982).
              ctx?.scheduledRun !== undefined ? "run" : "handback"
            )
          : prompt,
      ...(handbackCode !== undefined ? { handbackCode, promptAsWritten: prompt } : {}),
      systemPromptArgs: systemPromptArgs.args.length > 0 ? systemPromptArgs.args : undefined,
      interactive,
      modelId: model,
      presetId,
      activateDockOnCreate,
      env,
      excludeFromPersistence,
      removeOnExit,
      agentLaunchFlags,
      spawnedBy,
      // Host-stamped, never an argument: only Daintree's own scheduled launch
      // makes a pane a scheduled run's (#15977).
      scheduledRun: ctx?.scheduledRun,
      // Host-stamped, never an argument: it is what lets the plugin hold this
      // pane on restart later, and only this plugin (#14017).
      launchedByPluginId: ctx?.dispatchSource === "plugin" ? ctx.callerPluginId : undefined,
      focusPolicy,
      requestedId,
      force,
      name,
      onDecline: (d) => {
        decline = d;
      },
    });
    // The launcher declined (the hard panel limit, a re-entrant launch of the
    // same agent, a caught spawn failure, Electron unavailable) and says why.
    // Still an object so the MCP output schema stays satisfiable —
    // `launched:false` is the honest discriminant, where a bare null read as a
    // success with no terminal. Genuine rejections (unknown id, unresolvable
    // worktree) throw out of the launcher and surface as ok:false instead.
    if (!result) {
      // Widened back: TS narrows a closure-assigned `let` to its initializer.
      const declined = decline as LaunchDecline | null;
      return {
        launched: false,
        terminalId: null,
        location: null,
        // A decline the launcher did not name is still a failure to start.
        spawnStatus: declined?.reason ?? "spawn-failed",
        worktreeId: null,
        worktreePath: null,
        branch: null,
        cwd: null,
        cwdOutsideWorktree: null,
        panelLimit: declined?.panelLimit ?? null,
        reply: null,
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
      cwdOutsideWorktree: result.cwdOutsideWorktree,
      panelLimit: null,
      reply: null,
    };
  },
  "agent.palette": async (_args: unknown, _ctx: ActionContext, callbacks: ActionCallbacks) => {
    callbacks.onOpenQuickSwitcher();
  },
  "agent.terminal": async (args: unknown, _ctx: ActionContext, callbacks: ActionCallbacks) => {
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
  "agent.browser": async (args: unknown, _ctx: ActionContext, callbacks: ActionCallbacks) => {
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
  "agent.focusNextWaiting": async () => {
    const state = usePanelStore.getState();
    const worktreeData = getCurrentViewStore().getState();
    const validWorktreeIds = new Set<string>();
    for (const [id, wt] of worktreeData.worktrees) {
      validWorktreeIds.add(id);
      if (wt.worktreeId) validWorktreeIds.add(wt.worktreeId);
    }
    state.focusNextWaiting(state.isInTrash, validWorktreeIds);
  },
  "agent.focusNextWaitingGlobal": async () => {
    const projectState = useProjectStore.getState();
    const stats = useProjectStatsStore.getState().stats;
    const projects = projectState.projects;
    if (projects.length === 0) return;

    const currentProjectId = projectState.currentProject?.id ?? null;
    const currentIdx = currentProjectId ? projects.findIndex((p) => p.id === currentProjectId) : -1;

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
  "agent.focusNextWorking": async () => {
    const state = usePanelStore.getState();
    const worktreeData = getCurrentViewStore().getState();
    const validWorktreeIds = new Set<string>();
    for (const [id, wt] of worktreeData.worktrees) {
      validWorktreeIds.add(id);
      if (wt.worktreeId) validWorktreeIds.add(wt.worktreeId);
    }
    state.focusNextWorking(state.isInTrash, validWorktreeIds);
  },
  "agent.focusNextAgent": async () => {
    const state = usePanelStore.getState();
    const worktreeData = getCurrentViewStore().getState();
    const validWorktreeIds = new Set<string>();
    for (const [id, wt] of worktreeData.worktrees) {
      validWorktreeIds.add(id);
      if (wt.worktreeId) validWorktreeIds.add(wt.worktreeId);
    }
    state.focusNextAgent(state.isInTrash, validWorktreeIds);
  },
  "dock.focusNextWaiting": async () => {
    const state = usePanelStore.getState();
    const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
    state.focusNextBlockedDock(activeWorktreeId ?? undefined, state.getPanelGroup);
  },
  "agent.getState": async (args: unknown) => {
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
  "agentSessionHistory.list": async (args: unknown, ctx: ActionContext) => {
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
    return pageAgentFacingSessions(sessions, offset, limit);
  },
  "agentSessionHistory.resume": async (args: unknown, ctx: ActionContext) => {
    const parsed = ResumeSessionArgsSchema.parse(args);
    const { sessionId } = parsed;
    // Fail closed when a headless caller omits the worktree: the resolver
    // below falls back to whatever is active, which a person can see and an
    // agent cannot (#11722). Reads the raw selectors, so it must run before
    // any resolution.
    requireExplicitWorktreeForAgentDispatch("agentSessionHistory.resume", parsed, ctx);
    // Throws for a bare path that matches no open worktree, and for no
    // selector at all, rather than retargeting the resume at the active one.
    const requestedWorktreeId = requireWorktreeId(parsed, ctx);
    // Fail closed rather than degrade: this action decides which DIRECTORY a
    // process launches in, and without the index there is no way to prove the
    // asserted worktree is open or where it lives. Other location-taking
    // actions degrade to the context project on a null index; here that would
    // mean launching somewhere unverified.
    const worktreeIndex = getWorktreePathIndex();
    if (!worktreeIndex) {
      throw new Error(
        "No worktree index available — can't verify where this session would resume."
      );
    }
    // An explicit `worktreeId` is passed through unvalidated by the resolver
    // (only a path is matched against the index), so prove it is open here.
    // Before the lookup, so naming a worktree that isn't open reports exactly
    // that instead of the scope mismatch it would otherwise trip on.
    const requestedWorktreePath = worktreeIndex.get(requestedWorktreeId);
    if (!requestedWorktreePath) {
      throw new Error("Unknown worktree — no worktree with that id is open in this project.");
    }

    // Scope the journal read before searching it. Project scope is the
    // privacy boundary, so it is preferred; with no project in context fall
    // back to the worktree the caller asserted. NEVER read unscoped — that
    // would search every project's history for the id and could resume a
    // session belonging to a workspace this call has no business touching.
    const projectScope = ctx.projectId ?? ctx.scratchId;
    // Deliberately NOT filtered by worktree at the IPC: that filter compares
    // `record.worktreeId` literally, so it can never match a record journaled
    // without one. Those records are re-homed by cwd below and would
    // otherwise be permanently unresumable. Scope is enforced after
    // resolution instead, which is strictly narrower — it compares the
    // worktree the session would actually LAUNCH in.
    const records = projectScope
      ? await window.electron.agentSessionHistory.list(undefined, projectScope)
      : await window.electron.agentSessionHistory.list(requestedWorktreeId, undefined);

    const record = records.find((candidate) => candidate.sessionId === sessionId);
    if (!record) {
      throw new Error(
        "No resumable session with that id — it may have aged out of history, or belong to another project."
      );
    }

    const worktreeList = [...worktreeIndex].map(([id, path]) => ({ id, path }));
    // The record's OWN cwd/worktree wins: the CLI locates a conversation from
    // the launch directory (#4781), so relaunching anywhere else produces a
    // fresh session wearing a resumed session's id. The requested worktree is
    // only the fallback for pre-migration records that recorded neither.
    // Containment, checked on the DIRECTORY rather than the worktree id.
    // Checking the id alone is not enough: `resolveResumeLaunchTarget` falls
    // back to the id we pass it when a record carries no resolvable worktree,
    // so a record whose `cwd` points outside every open worktree would inherit
    // the asserted id and pass an id-only check while launching somewhere the
    // caller never named. The cwd is what the CLI actually resolves the
    // conversation from (#4781), so it is what has to be inside the worktree.
    // An empty string is not a directory. `resolveResumeLaunchTarget` uses `??`,
    // so `""` is "present" and survives all the way to the spawn, where main
    // falls back to the project root or home — a different directory than the
    // one asserted, arrived at silently.
    const recordedCwd = record.cwd?.trim() ? record.cwd : undefined;
    if (recordedCwd) {
      // `inferWorktreeIdFromCwd` matches lexically, so a path that walks back
      // out through `..` still carries the worktree root as its prefix and
      // would be classified as inside it. Journal cwds come from terminals
      // Daintree itself spawned, so this is belt-and-braces rather than a live
      // attack path — but the cost of being wrong is launching an agent in a
      // directory nobody asked for.
      if (recordedCwd.split(/[\\/]/).includes("..")) {
        throw new Error(
          "That session's recorded directory can't be verified — it walks outside the worktree it was journaled under."
        );
      }
      if (inferWorktreeIdFromCwd(recordedCwd, worktreeList) !== requestedWorktreeId) {
        throw new Error(
          "That session was recorded in a different directory. Resume it from the worktree it belongs to — relaunching it elsewhere would start a new conversation, not continue this one."
        );
      }
    }
    const target = resolveResumeLaunchTarget(
      { worktreeId: record.worktreeId, cwd: recordedCwd },
      { defaultTerminalCwd: requestedWorktreePath, activeWorktreeId: requestedWorktreeId },
      worktreeList
    );

    // Scope isolation. The caller asserted a worktree; if the session would
    // launch in a different one, refuse rather than silently resuming it
    // there — the caller's next action would be aimed at the wrong tree.
    if ((target.worktreeId ?? null) !== requestedWorktreeId) {
      throw new Error(
        "That session was recorded in a different worktree. Resume it from the worktree it belongs to — it cannot be relaunched anywhere else."
      );
    }

    // Only a FOREGROUND dispatch gets `onBeforeSpawn`. An assistant- or
    // plugin-driven resume must not yank the user's worktree selection: the
    // pane opens in its own worktree — backgrounded when that isn't the active
    // one — and the caller addresses it by the id returned here. A keybinding
    // or menu pick does switch, matching every other human resume surface: the
    // person asked for this pane and expects to see it. `isForegroundDispatch`
    // rather than `!== "agent"`, so `"plugin"` and a missing source fall on the
    // don't-move-the-view side rather than the other way round.
    const resumed = await resumeSessionIntoPanel(record, target, {
      onBeforeSpawn: !isForegroundDispatch(ctx.dispatchSource)
        ? undefined
        : () => {
            const selection = useWorktreeSelectionStore.getState();
            if (target.worktreeId && target.worktreeId !== selection.activeWorktreeId) {
              selection.selectWorktree(target.worktreeId, { source: "user" });
            }
          },
    });

    return {
      terminalId: resumed.terminalId,
      sessionId: record.sessionId,
      worktreeId: resumed.worktreeId,
      outcome: resumed.outcome,
    };
  },
  "session.bookmarkAndClose": async (args: unknown) => {
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
  "session.bookmark.promote": async (args: unknown, ctx: ActionContext) => {
    const { sessionId, label } = BookmarkMutateArgsSchema.parse(args);
    await requireSessionInCallerProject(sessionId, ctx);
    return window.electron.agentSessionHistory.promoteBookmark({ sessionId, label });
  },
  "session.bookmark.rename": async (args: unknown, ctx: ActionContext) => {
    const { sessionId, label } = BookmarkMutateArgsSchema.parse(args);
    await requireSessionInCallerProject(sessionId, ctx);
    return window.electron.agentSessionHistory.renameBookmark({ sessionId, label });
  },
  "session.bookmark.delete": async (args: unknown, ctx: ActionContext) => {
    const { sessionId } = BookmarkDeleteArgsSchema.parse(args);
    await requireSessionInCallerProject(sessionId, ctx);
    await window.electron.agentSessionHistory.deleteBookmark({ sessionId });
  },
  "session.bookmarks.list": async (args: unknown, ctx: ActionContext) => {
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
  "agent.listToolbar": async () => {
    const { pins, availability } = await readAgentDiscoveryState();
    return {
      agents: BUILT_IN_AGENT_IDS.map((id) => {
        const pin = agentToolbarPin(pins, id);
        const state = availability[id];
        // Omit `pinned` unless it's an explicit boolean (tri-state): an
        // absent key means "follows CLI availability", distinct from an
        // explicit true/false pin/unpin.
        return {
          id,
          displayName: getAgentDisplayTitle(id),
          ...(pin !== undefined ? { pinned: pin } : {}),
          installed: isAgentInstalled(state),
          visible: isAgentToolbarVisible(pin, state),
        };
      }),
    };
  },
  "agent.listAvailable": async () => {
    const [{ pins, availability, availabilityLive }, registry, userRegistry] =
      await readAvailableAgentSources();
    return buildAvailableAgentListing({
      registry,
      userRegistry,
      pins,
      availability,
      availabilityLive,
    });
  },
  "agent.listPresets": async (args: unknown, ctx: ActionContext) => {
    const { agentId, projectId: requestedProjectId } = AgentListPresetsArgsSchema.parse(args ?? {});
    const projectId = requestedProjectId ?? ctx.projectId;
    // Either workspace pointer proves the view resolved its own scope; with
    // neither, "no project presets" is a gap rather than an answer.
    const scopeKnown = projectId !== undefined || ctx.scratchId !== undefined;
    const sources = await readAgentPresetSources(agentId, projectId, scopeKnown);

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
  "agent.createPreset": (args: unknown, ctx: ActionContext) =>
    runPresetWrite("agent.createPreset", args, ctx),
  "agent.updatePreset": (args: unknown, ctx: ActionContext) =>
    runPresetWrite("agent.updatePreset", args, ctx),
  "agent.deletePreset": (args: unknown, ctx: ActionContext) =>
    runPresetWrite("agent.deletePreset", args, ctx),
  "agent.listModels": async (args: unknown) => {
    const { agentId } = AgentListModelsArgsSchema.parse(args ?? {});
    const registry = await agentCapabilitiesClient.getRegistry();
    if (agentId !== undefined && !Object.hasOwn(registry, agentId)) {
      throw new UnactionableTargetError(unknownAgentIdMessage(agentId));
    }
    const ids = agentId !== undefined ? [agentId] : listedAgentIds(registry);
    const agents = await Promise.all(
      ids.map(async (id) => {
        const catalog = await agentCapabilitiesClient.getResolvedModelList(id);
        // Projected by hand: the catalog also carries context windows and
        // upgrade pointers, and a result schema filters nothing at runtime.
        return {
          agentId: id,
          models: (catalog?.models ?? []).map((m) => ({ id: m.id, name: m.name })),
        };
      })
    );
    return { agents };
  },
  "agent.focusPreviousAgent": async () => {
    const state = usePanelStore.getState();
    const worktreeData = getCurrentViewStore().getState();
    const validWorktreeIds = new Set<string>();
    for (const [id, wt] of worktreeData.worktrees) {
      validWorktreeIds.add(id);
      if (wt.worktreeId) validWorktreeIds.add(wt.worktreeId);
    }
    state.focusPreviousAgent(state.isInTrash, validWorktreeIds);
  },
} satisfies Record<
  string,
  (args: unknown, ctx: ActionContext, callbacks: ActionCallbacks) => Promise<unknown>
>;

export type AgentActionRunId = keyof typeof agentActionRuns;
