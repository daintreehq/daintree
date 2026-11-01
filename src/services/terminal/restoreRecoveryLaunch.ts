import { usePanelStore } from "@/store/panelStore";
import { buildResumeCommand } from "@shared/types";
import { supportsCrossDirectoryResume } from "@shared/types/agentSettings";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import { isPtyPanel, type PanelInstance, type PtyPanelData } from "@shared/types/panel";
import { getAgentConfig } from "@/config/agents";
import { reconcileResumeLaunchFlags } from "@/services/agentResume";
import {
  getCurrentLaunchCliDetail,
  resolveAgentLaunchBaseCommand,
} from "@/utils/agentLaunchCommand";
import { logError } from "@/utils/logger";
import { reconcileMovedPanel } from "@/services/terminal/crossWorktreeMove";

export type RestoreRecoveryChoice = { kind: "resume"; sessionId: string } | { kind: "fresh" };

export type RestoreRecoveryLaunchResult =
  /** The held pane was replaced by a launch. */
  | "launched"
  /** Another pane already holds that conversation; nothing was launched. */
  | "held-elsewhere"
  /** The pane is gone, no longer held, has no destination yet, or couldn't build a command. */
  | "unavailable";

/**
 * Session ids of `agentId` already held by a pane other than `panelId`. A
 * sibling can claim a conversation while a picker sits open, so every resume
 * checks this at the moment it launches, not only when the list loaded (#11461).
 */
export function siblingHeldSessionIds(
  panelsById: Record<string, PanelInstance>,
  panelId: string,
  agentId: string
): Set<string> {
  const held = new Set<string>();
  for (const panel of Object.values(panelsById)) {
    if (panel.id === panelId || !isPtyPanel(panel)) continue;
    const heldAgentId = panel.runtimeIdentity?.agentId ?? panel.launchAgentId;
    if (heldAgentId === agentId && panel.agentSessionId) held.add(panel.agentSessionId);
  }
  return held;
}

export interface RestoreRecoveryLaunchCommandInputs {
  /** The pane's captured launch flags, reconciled against the current settings, for a resume. */
  flags: string[] | undefined;
  /** The executable restore itself would launch — the probed CLI path when there is one. */
  baseCommand: string | undefined;
}

/**
 * The launch that replaces a pane held for recovery (#12434), under the same
 * id — so its title, tab group, position and launch settings stay exactly as
 * they were, and only the process is new.
 *
 * Runs in the pane's `cwd`, which is its destination. A resumed conversation
 * keeps pointing lookups at the folder it began in; a fresh one begins here.
 * A resume is built the way every picker resume is; a fresh start runs the
 * command restore built when it held the pane, which already carries the
 * pane's preset overrides (a preset can switch bypass off where the agent
 * settings switch it on, and the flag reconciliation here can't see that).
 */
export function buildRestoreRecoveryLaunchOptions(
  panel: PtyPanelData,
  choice: RestoreRecoveryChoice,
  inputs: RestoreRecoveryLaunchCommandInputs
): AddPanelOptions | null {
  const agentId = panel.launchAgentId;
  const recovery = panel.restoreRecovery;
  if (!agentId || !recovery || recovery.awaitingDestination) return null;
  if (panel.location !== "grid" && panel.location !== "dock") return null;

  const resuming = choice.kind === "resume";
  const command = resuming
    ? buildResumeCommand(agentId, choice.sessionId, inputs.flags, inputs.baseCommand)
    : panel.command;
  if (!command) return null;

  return {
    kind: "terminal",
    requestedId: panel.id,
    replacesRestoreRecovery: true,
    launchAgentId: agentId,
    title: panel.title,
    titleMode: panel.titleMode,
    // An agent that reopens a conversation only where it began resumes there;
    // a fresh start runs where the pane now lives (#13509).
    cwd:
      resuming && !supportsCrossDirectoryResume(agentId)
        ? panel.conversationCwd || panel.cwd
        : panel.cwd,
    worktreeId: panel.worktreeId,
    location: panel.location,
    command,
    agentSessionId: resuming ? choice.sessionId : undefined,
    conversationCwd:
      resuming && supportsCrossDirectoryResume(agentId) ? panel.conversationCwd : undefined,
    isInputLocked: panel.isInputLocked,
    agentLaunchFlags: panel.agentLaunchFlags,
    callerLaunchFlags: panel.callerLaunchFlags,
    agentModelId: panel.agentModelId,
    agentPresetId: panel.agentPresetId,
    agentPresetColor: panel.agentPresetColor,
    originalPresetId: panel.originalPresetId,
    isUsingFallback: panel.isUsingFallback,
    fallbackChainIndex: panel.fallbackChainIndex,
    // The launch env was captured when the pane first ran (#10922) and carries
    // any redirected CODEX_HOME — the profile its conversations live under.
    env: panel.env,
    extensionState: panel.extensionState,
    extensionStateVersion: panel.extensionStateVersion,
    pluginId: panel.pluginId,
    spawnedBy: panel.spawnedBy,
    scheduledRun: panel.scheduledRun,
    // The pane leaves its hold the way the user chose, still the pane restore
    // brought back, with what was last seen before it (#14017).
    restoreProvenance: panel.restoreProvenance && {
      ...panel.restoreProvenance,
      disposition: resuming ? "resume" : "fresh",
    },
    lastAgentObservation: panel.lastAgentObservation,
    // Resuming the conversation the pane was held with carries on the run its
    // first prompt belongs to; another picked conversation, or a fresh start
    // running the held command, was never handed it (#14592).
    firstPrompt:
      choice.kind === "resume" && choice.sessionId === recovery.sessionId
        ? panel.firstPrompt
        : undefined,
    launchedByPluginId: panel.launchedByPluginId,
    // The user's choice to start the pane outranks the plugin's standing request
    // to hold it; the plugin can ask again (#14017).
    holdOnRestart: undefined,
    excludeFromPersistence: panel.excludeFromPersistence,
    removeOnExit: panel.removeOnExit,
    lastActiveAt: panel.lastActiveAt,
    // The user is acting inside this pane; leaving fullscreen for it would move
    // the very view they clicked in.
    preserveMaximize: true,
  };
}

const launchingPanelIds = new Set<string>();
const resumingSessionKeys = new Set<string>();

/** Whether a launch of this held pane is in flight, from any surface. */
export function isRestoreRecoveryLaunching(panelId: string): boolean {
  return launchingPanelIds.has(panelId);
}

/**
 * Conversations being reopened right now by any in-place resume, held from the
 * pick until the launch settles: the replacement publishes its `agentSessionId`
 * only once it spawns, so a sibling check alone lets two picks both through.
 * Shared with the ended-launch resume (#13226) so the two surfaces can't each
 * open the same conversation.
 */
export function reserveResumeSession(agentId: string, sessionId: string): (() => void) | null {
  const key = `${agentId}\u0000${sessionId}`;
  if (resumingSessionKeys.has(key)) return null;
  resumingSessionKeys.add(key);
  return () => resumingSessionKeys.delete(key);
}

export function isResumeSessionReserved(agentId: string, sessionId: string): boolean {
  return resumingSessionKeys.has(`${agentId}\u0000${sessionId}`);
}

/**
 * Launch a held pane in place, on the user's choice (#12434).
 *
 * A pane launches at most once at a time, and a conversation is reserved from
 * the moment it is chosen until the launch settles, so two panes picked in the
 * same instant can't both open it. `addPanel` re-checks the hold after its own
 * await, which covers the pane being closed while this was in flight.
 */
export async function launchFromRestoreRecovery(
  panelId: string,
  choice: RestoreRecoveryChoice
): Promise<RestoreRecoveryLaunchResult> {
  if (launchingPanelIds.has(panelId)) return "unavailable";
  const state = usePanelStore.getState();
  const panel = state.panelsById[panelId];
  if (!panel || !isPtyPanel(panel) || !panel.restoreRecovery || !panel.launchAgentId) {
    return "unavailable";
  }
  const agentId = panel.launchAgentId;
  let sessionKey: string | undefined;
  if (choice.kind === "resume") {
    sessionKey = `${agentId}\u0000${choice.sessionId}`;
    if (
      resumingSessionKeys.has(sessionKey) ||
      siblingHeldSessionIds(state.panelsById, panelId, agentId).has(choice.sessionId)
    ) {
      return "held-elsewhere";
    }
  }

  launchingPanelIds.add(panelId);
  if (sessionKey) resumingSessionKeys.add(sessionKey);
  try {
    const baseCommand = await resolveLaunchBaseCommand(agentId);
    // Re-read: the pane may have been moved or closed while the CLI was probed.
    const latest = usePanelStore.getState();
    const current = latest.panelsById[panelId];
    if (!current || !isPtyPanel(current)) return "unavailable";
    if (
      choice.kind === "resume" &&
      siblingHeldSessionIds(latest.panelsById, panelId, agentId).has(choice.sessionId)
    ) {
      return "held-elsewhere";
    }
    const options = buildRestoreRecoveryLaunchOptions(current, choice, {
      flags: reconcileResumeLaunchFlags({
        agentId,
        agentLaunchFlags: current.agentLaunchFlags,
        callerLaunchFlags: current.callerLaunchFlags,
      }),
      baseCommand,
    });
    if (!options) return "unavailable";
    const launchedId = await latest.addPanel(options);
    if (launchedId === null) return "unavailable";
    // A conversation resumed in the folder it began in, while the pane is filed
    // under another worktree, gets the same notice a live pane moved there gets.
    if (options.cwd !== current.cwd && options.worktreeId) {
      reconcileMovedPanel(launchedId, options.worktreeId);
    }
    return "launched";
  } catch (error) {
    logError("[restoreRecovery] Failed to launch held pane", error);
    return "unavailable";
  } finally {
    launchingPanelIds.delete(panelId);
    if (sessionKey) resumingSessionKeys.delete(sessionKey);
  }
}

async function resolveLaunchBaseCommand(agentId: string): Promise<string | undefined> {
  try {
    const detail = await getCurrentLaunchCliDetail(agentId);
    return resolveAgentLaunchBaseCommand(getAgentConfig(agentId)?.command ?? agentId, detail);
  } catch {
    // The registry command is still a launch; the spawn surfaces a missing CLI.
    return undefined;
  }
}

/**
 * Panes held because an unclean end of the app cut their run short (#14382)
 * that can be resumed without a choice: each carries its conversation and a
 * place to run. In the view's own order, so a bulk resume starts them as laid out.
 */
export function heldForHostEndIds(
  panelsById: Record<string, PanelInstance>,
  panelIds: readonly string[]
): string[] {
  const ids: string[] = [];
  for (const id of panelIds) {
    const panel = panelsById[id];
    if (!panel || !isPtyPanel(panel) || !panel.launchAgentId) continue;
    if (panel.location !== "grid" && panel.location !== "dock") continue;
    const recovery = panel.restoreRecovery;
    if (recovery?.reason !== "host-ended-uncleanly") continue;
    if (recovery.awaitingDestination || recovery.sessionId === undefined) continue;
    ids.push(id);
  }
  return ids;
}

/**
 * Resume every pane {@link heldForHostEndIds} names, one launch after another,
 * on the user's say-so. Each goes through the same checks a single resume does,
 * so a conversation another pane opened meanwhile is left alone.
 */
let resumingAllHeldForHostEnd = false;

// What "Resume all" left behind on each pane it couldn't start, shown on that
// pane's own gate: the one pressed has usually been replaced by then.
const bulkOutcomes = new Map<string, RestoreRecoveryLaunchResult>();
const bulkOutcomeListeners = new Set<() => void>();

function setBulkOutcome(panelId: string, result: RestoreRecoveryLaunchResult | undefined): void {
  if (bulkOutcomes.get(panelId) === result) return;
  if (result === undefined) bulkOutcomes.delete(panelId);
  else bulkOutcomes.set(panelId, result);
  for (const listener of bulkOutcomeListeners) listener();
}

export function getBulkResumeOutcome(panelId: string): RestoreRecoveryLaunchResult | undefined {
  return bulkOutcomes.get(panelId);
}

export function subscribeBulkResumeOutcomes(listener: () => void): () => void {
  bulkOutcomeListeners.add(listener);
  return () => bulkOutcomeListeners.delete(listener);
}

export function clearBulkResumeOutcome(panelId: string): void {
  setBulkOutcome(panelId, undefined);
}

export async function resumeAllHeldForHostEnd(): Promise<RestoreRecoveryLaunchResult[]> {
  // Offered on every held pane, so a press on a second one joins nothing.
  if (resumingAllHeldForHostEnd) return [];
  resumingAllHeldForHostEnd = true;
  try {
    return await resumeEachHeldForHostEnd();
  } finally {
    resumingAllHeldForHostEnd = false;
  }
}

async function resumeEachHeldForHostEnd(): Promise<RestoreRecoveryLaunchResult[]> {
  const { panelsById, panelIds } = usePanelStore.getState();
  const results: RestoreRecoveryLaunchResult[] = [];
  for (const id of heldForHostEndIds(panelsById, panelIds)) {
    // Read again per pane: the previous launch replaced its own pane, and the
    // user may have resumed or closed this one in the meantime.
    const panel = usePanelStore.getState().panelsById[id];
    const sessionId =
      panel && isPtyPanel(panel) && panel.restoreRecovery?.reason === "host-ended-uncleanly"
        ? panel.restoreRecovery.sessionId
        : undefined;
    if (sessionId === undefined) continue;
    const result = await launchFromRestoreRecovery(id, { kind: "resume", sessionId });
    setBulkOutcome(id, result === "launched" ? undefined : result);
    results.push(result);
  }
  return results;
}
