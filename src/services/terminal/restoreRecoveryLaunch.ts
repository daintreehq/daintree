import { usePanelStore } from "@/store/panelStore";
import { buildResumeCommand } from "@shared/types";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import { isPtyPanel, type PanelInstance, type PtyPanelData } from "@shared/types/panel";
import { getAgentConfig } from "@/config/agents";
import { reconcileResumeLaunchFlags } from "@/services/agentResume";
import {
  getCurrentLaunchCliDetail,
  resolveAgentLaunchBaseCommand,
} from "@/utils/agentLaunchCommand";
import { logError } from "@/utils/logger";

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
    cwd: panel.cwd,
    worktreeId: panel.worktreeId,
    location: panel.location,
    command,
    agentSessionId: resuming ? choice.sessionId : undefined,
    conversationCwd: resuming ? panel.conversationCwd : undefined,
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
    return launchedId === null ? "unavailable" : "launched";
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
