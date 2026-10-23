import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CHANNELS } from "../../ipc/channels.js";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type { PanelSnapshot, Project } from "../../../shared/types/project.js";
import type { ResolvedModelCatalog } from "../../../shared/types/ipc/agentCapabilities.js";
import { LAUNCH_CONTEXT_AGENT_IDS } from "../../../shared/config/agentLaunchContext.js";
import {
  getEffectiveAgentConfig,
  getEffectiveRegistry,
  type AgentPreset,
  getUserRegistry,
  isEffectivelyRegisteredAgent,
} from "../../../shared/config/agentRegistry.js";
import {
  agentClipboardDirectory,
  type AgentSettings,
} from "../../../shared/types/agentSettings.js";
import { NotifyReplyLinesSchema } from "../../../shared/types/terminalNotify.js";
import { WaitForReplySchema, WaitSecondsSchema } from "../../../shared/types/replyWait.js";
import { isAgentLaunchable } from "../../../shared/utils/agentAvailability.js";
import { resolveAgentLaunchBaseCommandFor } from "../../../shared/utils/agentLaunchCommand.js";
import {
  buildAgentLaunchPlan,
  buildLaunchIdentity,
} from "../../../shared/utils/agentLaunchPlan.js";
import {
  resolveAgentLaunchKind,
  unknownAgentIdMessage,
} from "../../../shared/utils/agentLaunchValidation.js";
import { buildAvailableAgentListing, listedAgentIds } from "../../../shared/utils/agentListing.js";
import { getMergedPresetIdentities } from "../../../shared/utils/agentPresets.js";
import {
  hasSystemPromptOverride,
  resolveSystemPromptArgs,
  SYSTEM_PROMPT_MAX_LENGTH,
} from "../../../shared/utils/agentSystemPrompt.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { appendHandbackInstruction, mintHandbackCode } from "../../../shared/utils/handback.js";
import {
  buildPanelLimitSnapshot,
  computeHardwareDefaults,
} from "../../../shared/utils/panelLimit.js";
import {
  serializePtyPanel,
  type PtySnapshotSource,
} from "../../../shared/utils/ptyPanelSnapshot.js";
import {
  mergeTerminalLaunchEnv,
  spawnSourceForMcpOrigin,
} from "../../../shared/utils/terminalLaunchOptions.js";
import type { ViewlessActionRequest, ViewlessDeps } from "./ViewlessActionExecutor.js";
import { recordViewlessTerminal } from "./projectStateAuthoring.js";
import { countProjectPanels } from "./viewlessTerminals.js";
import { readProjectWorktrees } from "./viewlessWorktrees.js";
import { AgentListModelsArgsSchema, AgentListPresetsArgsSchema } from "./viewlessArgsSchemas.js";
import {
  viewlessFailure as failure,
  viewlessSuccess as success,
  viewlessValidationFailure as validationFailure,
} from "./viewlessResult.js";

/** The renderer action's arguments; the UI-only ones are accepted and have no effect here. */
const AgentLaunchArgsSchema = z.object({
  agentId: z.string().min(1),
  location: z.enum(["grid", "dock", "overlay", "background"]).optional(),
  cwd: z.string().optional(),
  worktreeId: z.string().optional(),
  prompt: z.string().optional(),
  handback: z.boolean().optional(),
  notify: z.boolean().optional(),
  replyLines: NotifyReplyLinesSchema,
  waitForReply: WaitForReplySchema,
  waitSeconds: WaitSecondsSchema,
  systemPrompt: z.string().max(SYSTEM_PROMPT_MAX_LENGTH).optional(),
  interactive: z.boolean().optional(),
  model: z.string().optional(),
  presetId: z.string().nullable().optional(),
  activateDockOnCreate: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  excludeFromPersistence: z.boolean().optional(),
  removeOnExit: z.boolean().optional(),
  agentLaunchFlags: z.array(z.string()).optional(),
  spawnedBy: z.unknown().optional(),
  focusPolicy: z.unknown().optional(),
  requestedId: z.string().optional(),
  force: z.boolean().optional(),
  name: z.string().max(200).optional(),
});

/** Launch ids the launcher always turns into a panel, never an agent. */
const PANEL_LAUNCH_IDS: ReadonlySet<string> = new Set(["browser", "dev-preview"]);

/** A launch that started nothing, in the shape the action's output schema requires. */
function declined(
  spawnStatus: "missing-cli" | "panel-limit" | "spawn-failed",
  panelLimit: ReturnType<typeof buildPanelLimitSnapshot> | null = null,
  identity?: ReturnType<typeof buildLaunchIdentity>
): ActionDispatchResult {
  return success({
    launched: false,
    terminalId: null,
    location: null,
    spawnStatus,
    worktreeId: identity?.worktreeId ?? null,
    worktreePath: identity?.worktreePath ?? null,
    branch: identity?.branch ?? null,
    cwd: identity?.cwd ?? null,
    cwdOutsideWorktree: identity?.cwdOutsideWorktree ?? null,
    panelLimit,
    reply: null,
  });
}

/** One agent's bucket of a by-agent preset map, own keys only, so `__proto__` is no agent. */
function ownBucket(
  byAgent: Record<string, AgentPreset[]>,
  agentId: string
): AgentPreset[] | undefined {
  if (!Object.hasOwn(byAgent, agentId)) return undefined;
  const bucket = byAgent[agentId];
  return Array.isArray(bucket) ? bucket : undefined;
}

/**
 * The preset sources a launch with no view resolves a preset id against, read
 * once for the launch and the listing alike, so `agent.listPresets` names
 * exactly the presets `agent.launch` accepts (#14139). A source that fails to
 * read is launched without, and makes the read incomplete.
 */
async function readPresetSources(
  agentId: string,
  projectPath: string | undefined,
  deps: ViewlessDeps
): Promise<{
  settings: AgentSettings | null;
  ccrPresets: AgentPreset[] | undefined;
  projectPresets: AgentPreset[] | undefined;
  complete: boolean;
}> {
  let complete = true;
  const missing = <T>(fallback: T) => {
    complete = false;
    return fallback;
  };
  const [settings, ccrPresets, projectPresets] = await Promise.all([
    deps.agents.getSettings().catch(() => missing(null)),
    deps.agents.getCcrPresets(agentId).catch(() => missing(undefined)),
    projectPath === undefined
      ? Promise.resolve(undefined)
      : deps.agents
          .getProjectPresets(projectPath)
          .then((byAgent) => ownBucket(byAgent, agentId))
          .catch(() => missing(undefined)),
  ]);
  return { settings, ccrPresets, projectPresets, complete };
}

/**
 * Start an agent, or a plain shell, in a project with no frontend attached
 * (#13495): the same validation the view's action applies, the same launch
 * plan its launcher builds, spawned through the same handler, and recorded in
 * the saved layout exactly as the view's persistence would record it, so the
 * next frontend to attach hydrates the panel rather than adopting a stranger.
 *
 * What only a view can draw is refused rather than reinterpreted: a browser or
 * dev-preview panel, an overlay, and the two panel lifetimes (`removeOnExit`,
 * `excludeFromPersistence`) that a view's panel record enforces.
 */
export async function runAgentLaunch(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = AgentLaunchArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const args = parsed.data;
  const { agentId } = args;

  if (PANEL_LAUNCH_IDS.has(agentId)) {
    return failure(
      "VALIDATION_ERROR",
      `'${agentId}' opens a panel only a Daintree frontend can draw, and none is attached to this project.`
    );
  }
  if (args.location === "overlay") {
    return failure(
      "VALIDATION_ERROR",
      "An overlay is drawn by a Daintree frontend, and none is attached to this project. Launch to the grid or dock."
    );
  }
  if (args.excludeFromPersistence === true || args.removeOnExit === true) {
    return failure(
      "VALIDATION_ERROR",
      "excludeFromPersistence and removeOnExit are kept by a frontend's panel, and none is attached to this project. Launch without them."
    );
  }

  const pty = deps.getPtyReader();
  const state = await deps.getProjectState(project.id).catch(() => null);
  if (args.requestedId !== undefined) {
    const taken =
      (state?.terminals ?? []).some((terminal) => terminal.id === args.requestedId) ||
      (pty !== null && pty.getTerminalProjectId(args.requestedId) !== null);
    if (taken) {
      return failure(
        "EXECUTION_ERROR",
        `A panel with id '${args.requestedId}' already exists. Omit the requested id, or choose one no panel is using.`
      );
    }
  }

  // The view's refusals, in its order and words, before anything launches.
  const systemPromptArgs = resolveSystemPromptArgs(
    agentId,
    args.systemPrompt,
    deps.hostPlatform.shellDialect
  );
  if (!systemPromptArgs.ok) return failure("VALIDATION_ERROR", systemPromptArgs.reason);
  if (systemPromptArgs.args.length > 0 && hasSystemPromptOverride(args.agentLaunchFlags, agentId)) {
    return failure(
      "VALIDATION_ERROR",
      "agentLaunchFlags already sets this agent's system-prompt instruction. Pass it in systemPrompt or agentLaunchFlags, not both."
    );
  }
  if (args.handback === true && (args.prompt === undefined || args.prompt.trim() === "")) {
    return failure(
      "VALIDATION_ERROR",
      "handback asks the agent to mark the end of its reply to `prompt`, so it needs a non-empty `prompt`. Pass one, or launch without handback."
    );
  }
  const registered = isEffectivelyRegisteredAgent(agentId);
  if ((args.handback === true || args.notify === true) && agentId !== "terminal" && !registered) {
    return failure("VALIDATION_ERROR", unknownAgentIdMessage(agentId));
  }
  if (args.handback === true && !registered) {
    return failure(
      "VALIDATION_ERROR",
      "handback needs an agent to answer it, and this id is not a registered agent: a plain shell or panel never prints the marker. Launch a registered agent, or launch without handback."
    );
  }
  if (args.notify === true && !registered) {
    return failure(
      "VALIDATION_ERROR",
      "notify waits for an agent to stop working, and this id is not a registered agent: a plain shell or panel never reports working or idle. Launch a registered agent, or launch without notify."
    );
  }

  let isAgent: boolean;
  try {
    isAgent = resolveAgentLaunchKind(agentId, registered) === "agent";
  } catch (err) {
    return failure("EXECUTION_ERROR", formatErrorMessage(err, "Unknown agent"));
  }

  // The worktree the launch files under: the one named, else the one this
  // call's own context names, else the layout's last active worktree.
  let worktrees: Awaited<ReturnType<typeof readProjectWorktrees>>;
  try {
    worktrees = await readProjectWorktrees(project, deps);
  } catch (err) {
    return failure("EXECUTION_ERROR", formatErrorMessage(err, "Failed to read worktrees"));
  }
  const contextWorktreeId =
    request.context?.projectId === undefined || request.context.projectId === project.id
      ? request.context?.activeWorktreeId
      : undefined;
  let worktreeId: string | null;
  let worktree: { path?: string; branch?: string; gitDir?: string } | null;
  if (args.worktreeId !== undefined) {
    const match = worktrees?.find((candidate) => candidate.id === args.worktreeId) ?? null;
    if (args.worktreeId && worktrees !== null && !match) {
      const available = worktrees.map((candidate) => candidate.id);
      return failure(
        "EXECUTION_ERROR",
        `Worktree '${args.worktreeId}' not found. Available worktree IDs: ${available.length > 0 ? available.join(", ") : "none"}`
      );
    }
    worktreeId = args.worktreeId || null;
    worktree = match;
  } else {
    const inherited = contextWorktreeId ?? state?.activeWorktreeId ?? null;
    const match = inherited
      ? (worktrees?.find((candidate) => candidate.id === inherited) ?? null)
      : null;
    // A stale inherited id is dropped rather than filed against, as a view drops it.
    worktreeId = match ? inherited : null;
    worktree = match;
  }
  const cwd = args.cwd ?? worktree?.path ?? project.path;
  const identity = buildLaunchIdentity(worktreeId, worktree, cwd, {
    caseInsensitive: process.platform === "darwin" || process.platform === "win32",
  });

  // The hard limit a fresh view would hold the launch to, counted over what a
  // view would hydrate: the saved layout and the live terminals, by the same
  // rule the listing counts with.
  const defaults = computeHardwareDefaults(deps.hostPlatform.totalMemoryBytes);
  const panelLimit = buildPanelLimitSnapshot(await countProjectPanels(project, deps), {
    softWarningLimit: defaults.soft,
    confirmationLimit: defaults.confirm,
    hardLimit: defaults.hard,
  });
  if (panelLimit.tier === "hard") return declined("panel-limit", panelLimit);

  const handbackCode = args.handback === true ? mintHandbackCode() : undefined;
  const agentConfig = getEffectiveAgentConfig(agentId);
  const { settings, ccrPresets, projectPresets } = await readPresetSources(
    agentId,
    project.path,
    deps
  );
  const plan = await buildAgentLaunchPlan({
    agentId,
    agentConfig,
    isAgent,
    worktreeId,
    settings,
    ccrPresets,
    projectPresets,
    options: {
      presetId: args.presetId,
      env: args.env,
      prompt:
        handbackCode !== undefined && args.prompt !== undefined
          ? appendHandbackInstruction(args.prompt, handbackCode)
          : args.prompt,
      interactive: args.interactive,
      modelId: args.model,
      systemPromptArgs: systemPromptArgs.args.length > 0 ? systemPromptArgs.args : undefined,
      agentLaunchFlags: args.agentLaunchFlags,
      name: args.name,
    },
    shellDialect: deps.hostPlatform.shellDialect,
    // This is the host's own launch, as a local window's is: a leading `~` is
    // left for the host's shell to expand.
    resolveBaseCommand: (registryCommand, detail) =>
      resolveAgentLaunchBaseCommandFor(
        registryCommand,
        detail,
        deps.hostPlatform.shellDialect,
        undefined
      ),
    getCliDetail: (id) => deps.agents.getCliDetail(id),
    getClipboardDirectory: async () => agentClipboardDirectory(deps.hostPlatform.tmpDir, false),
    // No `onStalePreset`: a saved preset that no longer exists is still fallen
    // back from here, and clearing it is left to the next launch from a view,
    // whose settings store owns that write and tells every window about it.
  });
  if (isAgent && !plan.command) return declined("spawn-failed", null, identity);
  // A CLI that cannot launch would only start and fail. A view opens its setup
  // diagnostic panel instead; with no view, the result says why nothing ran.
  if (
    isAgent &&
    args.force !== true &&
    plan.cliDetail &&
    !isAgentLaunchable(plan.cliDetail.state)
  ) {
    return declined("missing-cli", null, identity);
  }

  const id = args.requestedId || `terminal-${randomUUID()}`;
  const location =
    args.location === "dock" ? "dock" : args.location === "background" ? "background" : "grid";
  const spawnedBy = spawnSourceForMcpOrigin(request.sessionOrigin);
  const layers = await deps.getLaunchEnvLayers(project.id).catch((err: unknown) => {
    console.warn("[Viewless] Could not read environment variables for a launch:", err);
    return null;
  });
  const env = mergeTerminalLaunchEnv(layers?.global, layers?.project, plan.env);
  const launchAgentId = isAgent ? agentId : undefined;
  // The launch-time context an agent pane's MCP session replays (#12486),
  // pointed at the pane itself, as a view captures it.
  const actionContext =
    launchAgentId !== undefined && LAUNCH_CONTEXT_AGENT_IDS.has(launchAgentId)
      ? {
          projectId: project.id,
          ...(worktreeId !== null
            ? { activeWorktreeId: worktreeId, focusedWorktreeId: worktreeId }
            : {}),
          focusedTerminalId: id,
          focusedTerminalKind: "terminal" as const,
          focusedTerminalTitle: plan.title,
        }
      : undefined;

  try {
    await deps.invoke<string>(project.id, CHANNELS.TERMINAL_SPAWN, [
      {
        id,
        kind: "terminal",
        projectId: project.id,
        cwd,
        cols: 80,
        rows: 24,
        title: plan.title,
        ...(plan.titleMode !== undefined ? { titleMode: plan.titleMode } : {}),
        ...(plan.command !== undefined ? { command: plan.command } : {}),
        ...(env !== undefined ? { env } : {}),
        ...(worktreeId !== null ? { worktreeId } : {}),
        ...(launchAgentId !== undefined
          ? {
              launchAgentId,
              agentLaunchFlags: plan.launchFlags,
              agentModelId: args.model,
              agentSessionId: plan.assignedSessionId,
              agentPresetId: plan.preset?.id,
              agentPresetColor: plan.preset?.color,
              originalAgentPresetId: plan.preset?.id,
            }
          : {}),
        ...(handbackCode !== undefined ? { handbackCode } : {}),
        ...(actionContext !== undefined ? { actionContext } : {}),
      },
    ]);
  } catch (err) {
    console.warn("[Viewless] Agent launch failed:", formatErrorMessage(err, "unknown"));
    return declined("spawn-failed", null, identity);
  }

  // What a view's persistence would write for this panel the moment it was
  // added: the shared base fields, then the PTY fragment through the same
  // serializer. Never fatal — the agent is running either way, and hydration
  // still finds it through the pty-host.
  const panel: PtySnapshotSource = {
    cwd,
    launchAgentId,
    command: plan.command,
    agentSessionId: plan.assignedSessionId,
    agentLaunchFlags: plan.launchFlags,
    callerLaunchFlags: plan.callerLaunchFlags,
    agentModelId: args.model,
    agentPresetId: plan.preset?.id,
    agentPresetColor: plan.preset?.color,
    originalPresetId: plan.preset?.id,
    env: plan.env,
    spawnedBy,
  };
  const snapshot: PanelSnapshot = {
    id,
    kind: "terminal",
    title: plan.title,
    ...(plan.titleMode !== undefined ? { titleMode: plan.titleMode } : {}),
    ...(worktreeId !== null ? { worktreeId } : {}),
    // The stable handle restore follows a `git worktree move` by, as a view's
    // persistence records it (#11388).
    ...(worktree?.gitDir ? { worktreeGitDir: worktree.gitDir } : {}),
    location,
    // Recorded as a view's persistence records a parked panel, so the view
    // that later opens this project rebuilds its restore entry.
    ...(location === "background" ? { backgroundRestoreLocation: "grid" as const } : {}),
    ...serializePtyPanel(panel),
  };
  try {
    await recordViewlessTerminal(deps.stateWriter, project.id, snapshot);
  } catch (err) {
    console.warn(`[Viewless] Could not record agent ${id.slice(0, 8)} in project state:`, err);
  }

  return success({
    launched: true,
    terminalId: id,
    location,
    spawnStatus: null,
    ...identity,
    panelLimit: null,
    reply: null,
  });
}

/**
 * Spawn the host's own assistant with no view (#13511): the agent's launch
 * plan as a view's launcher builds it, in the assistant's session folder,
 * through the same spawn handler, which binds the PTY to its help session by
 * the bearer in `env`. Never recorded in the saved layout: an assistant is no
 * project panel, and the view that takes it over shows it in its own tab.
 * False when nothing was started.
 */
export async function spawnHostAssistant(
  project: Pick<Project, "id" | "path">,
  spec: {
    terminalId: string;
    agentId: string;
    cwd: string;
    env: Record<string, string>;
    prompt: string;
    agentLaunchFlags: string[];
  },
  deps: ViewlessDeps
): Promise<boolean> {
  const { agentId } = spec;
  const { settings, ccrPresets, projectPresets } = await readPresetSources(
    agentId,
    project.path,
    deps
  );
  const plan = await buildAgentLaunchPlan({
    agentId,
    agentConfig: getEffectiveAgentConfig(agentId),
    isAgent: true,
    worktreeId: null,
    settings,
    ccrPresets,
    projectPresets,
    options: {
      env: spec.env,
      prompt: spec.prompt,
      ...(spec.agentLaunchFlags.length > 0 ? { agentLaunchFlags: spec.agentLaunchFlags } : {}),
    },
    shellDialect: deps.hostPlatform.shellDialect,
    resolveBaseCommand: (registryCommand, detail) =>
      resolveAgentLaunchBaseCommandFor(
        registryCommand,
        detail,
        deps.hostPlatform.shellDialect,
        undefined
      ),
    getCliDetail: (id) => deps.agents.getCliDetail(id),
    getClipboardDirectory: async () => agentClipboardDirectory(deps.hostPlatform.tmpDir, false),
  });
  if (!plan.command) return false;
  if (plan.cliDetail && !isAgentLaunchable(plan.cliDetail.state)) return false;
  const layers = await deps.getLaunchEnvLayers(project.id).catch((err: unknown) => {
    console.warn("[Viewless] Could not read environment variables for an assistant:", err);
    return null;
  });
  const env = mergeTerminalLaunchEnv(layers?.global, layers?.project, plan.env);
  try {
    await deps.invoke<string>(project.id, CHANNELS.TERMINAL_SPAWN, [
      {
        id: spec.terminalId,
        kind: "terminal",
        projectId: project.id,
        cwd: spec.cwd,
        cols: 80,
        rows: 24,
        title: plan.title,
        ...(plan.titleMode !== undefined ? { titleMode: plan.titleMode } : {}),
        command: plan.command,
        ...(env !== undefined ? { env } : {}),
        launchAgentId: agentId,
        agentLaunchFlags: plan.launchFlags,
        agentSessionId: plan.assignedSessionId,
        agentPresetId: plan.preset?.id,
        agentPresetColor: plan.preset?.color,
        originalAgentPresetId: plan.preset?.id,
      },
    ]);
    return true;
  } catch (err) {
    console.warn("[Viewless] Assistant launch failed:", formatErrorMessage(err, "unknown"));
    return false;
  }
}

export async function runAgentListAvailable(
  _request: ViewlessActionRequest,
  _project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  try {
    const [settings, { availability, live }] = await Promise.all([
      deps.agents.getSettings(),
      deps.agents.getAvailability(),
    ]);
    return success(
      buildAvailableAgentListing({
        registry: getEffectiveRegistry(),
        userRegistry: getUserRegistry(),
        settings,
        availability,
        availabilityLive: live,
      })
    );
  } catch (err) {
    return failure("EXECUTION_ERROR", formatErrorMessage(err, "Failed to list agents"));
  }
}

/**
 * One agent's launchable presets with no view (#14139), from the sources a
 * launch here resolves against, and none for an agent it would refuse. Another project's repository presets are
 * left out and the listing marked incomplete, as a view's listing does.
 */
export async function runAgentListPresets(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = AgentListPresetsArgsSchema.safeParse(request.args ?? {});
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const { agentId, projectId } = parsed.data;
  // A launch here refuses an id the registry doesn't have, so none of the
  // presets saved under it would launch.
  if (!isEffectivelyRegisteredAgent(agentId)) {
    return success({ presetsComplete: true, presets: [] });
  }
  const ownProject = projectId === undefined || projectId === project.id;
  const sources = await readPresetSources(agentId, ownProject ? project.path : undefined, deps);
  const entry =
    sources.settings?.agents && Object.hasOwn(sources.settings.agents, agentId)
      ? sources.settings.agents[agentId]
      : undefined;
  return success({
    presetsComplete: sources.complete && ownProject,
    presets: getMergedPresetIdentities(
      agentId,
      entry?.customPresets,
      sources.ccrPresets,
      sources.projectPresets
    ),
  });
}

/** Each listed agent's model ids and names with no view (#14139), from the host's model catalog. */
export async function runAgentListModels(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = AgentListModelsArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const agentId = parsed.data?.agentId;
  const registry = getEffectiveRegistry();
  if (agentId !== undefined && !Object.hasOwn(registry, agentId)) {
    return failure("VALIDATION_ERROR", unknownAgentIdMessage(agentId));
  }
  const ids = agentId !== undefined ? [agentId] : listedAgentIds(registry);
  try {
    const agents = await Promise.all(
      ids.map(async (id) => {
        const catalog = await deps.invoke<ResolvedModelCatalog | null>(
          project.id,
          CHANNELS.AGENT_CAPABILITIES_GET_RESOLVED_MODEL_LIST,
          [id]
        );
        // Projected by hand, as a view projects it: the catalog also carries
        // context windows and upgrade pointers.
        return {
          agentId: id,
          models: (catalog?.models ?? []).map((m) => ({ id: m.id, name: m.name })),
        };
      })
    );
    return success({ agents });
  } catch (err) {
    return failure("EXECUTION_ERROR", formatErrorMessage(err, "Failed to list models"));
  }
}
