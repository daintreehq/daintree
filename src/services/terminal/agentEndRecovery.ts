import type { AgentExitedPayload } from "@shared/types";
import { isPtyPanel, presetSwitchLaunchOf, type PtyPanelData } from "@shared/types/panel";
import { getAgentConfig } from "@/config/agents";
import { usePanelStore } from "@/store/panelStore";
import { saveNormalized } from "@/store/slices/panelRegistry/persistence";
import type { PresetRespawnResult } from "@/store/slices/panelRegistry/types";
import {
  isResumeSessionReserved,
  reserveResumeSession,
  siblingHeldSessionIds,
  type RestoreRecoveryLaunchResult,
} from "@/services/terminal/restoreRecoveryLaunch";
import { logInfo } from "@/utils/logger";

/** Agents whose sessions the in-pane "Find session" picker can list. */
const PICKER_AGENTS: ReadonlySet<string> = new Set(["codex"]);

/**
 * `(pane, agent, conversation)` triples already relaunched automatically. Lives
 * outside the panel so a relaunch — a new PTY generation with fresh panel
 * state — can't hand the same conversation a second automatic attempt: an
 * update that "succeeds" on every start would otherwise loop forever.
 */
const autoResumed = new Set<string>();

export function _resetAgentEndRecoveryForTests(): void {
  autoResumed.clear();
}

/**
 * The shell the run left behind is still idle: no agent, no recognised process
 * and no busy foreground job (`background` is what a busy plain shell reports).
 */
export function isIdleShell(panel: PtyPanelData): boolean {
  return (
    panel.detectedAgentId === undefined &&
    panel.detectedProcessId === undefined &&
    panel.activityType !== "background"
  );
}

/**
 * Restart `panel` into `sessionId` unless another pane holds or is already
 * reopening that conversation.
 */
async function reopenInPlace(
  panel: PtyPanelData,
  agentId: string,
  sessionId: string
): Promise<RestoreRecoveryLaunchResult> {
  const state = usePanelStore.getState();
  if (siblingHeldSessionIds(state.panelsById, panel.id, agentId).has(sessionId)) {
    return "held-elsewhere";
  }
  const release = reserveResumeSession(agentId, sessionId);
  if (!release) return "held-elsewhere";
  try {
    await state.restartTerminal(panel.id, { resumeSessionId: sessionId });
    return "launched";
  } finally {
    release();
  }
}

/**
 * Take a launched run's end as the answer to the preset switch that asked it to
 * reopen the pane's conversation (#16045), when the run ended on its CLI's own
 * refusal. The pane then offers both ways out; nothing starts by itself. Any
 * other end is left to the handling every launched run gets.
 *
 * `observedRestartKey` is the pane's restart count when the event arrived: a
 * switch made in between watches a run this end can't belong to.
 */
function takeRefusedPresetSwitch(
  payload: AgentExitedPayload,
  observedRestartKey: number | undefined
): boolean {
  const agentId = payload.agentType;
  if (!payload.agentEnd?.launchedRun || !payload.agentEnd.resumeRefused || !agentId) return false;

  const panel = usePanelStore.getState().panelsById[payload.terminalId];
  if (!panel || !isPtyPanel(panel)) return false;
  const attempt = panel.presetSwitchResume;
  if (!attempt || attempt.refused || attempt.agentId !== agentId) return false;
  if (panel.agentPresetId !== attempt.presetId) return false;
  if (observedRestartKey !== undefined && (panel.restartKey ?? 0) !== observedRestartKey) {
    return false;
  }

  logInfo("[agentEndRecovery] Conversation refused on the preset a switch moved it to", {
    terminalId: panel.id,
    agentId,
  });
  usePanelStore.setState((current) => {
    const latest = current.panelsById[panel.id];
    if (!latest || !isPtyPanel(latest) || latest.presetSwitchResume !== attempt) return current;
    return {
      panelsById: {
        ...current.panelsById,
        [panel.id]: {
          ...latest,
          presetSwitchResume: { ...attempt, refused: true },
          agentResumeOffer: undefined,
        },
      },
    };
  });
  return true;
}

/**
 * React to the run Daintree launched in a pane quitting to its shell (#13226).
 *
 * A successful self-update is the user's own "Update now", and the CLI exits
 * asking to be started again, so the conversation the pane was opened on is
 * relaunched in place — once. Every other end that left no resume hint behind
 * (a crash at boot, Ctrl-C at the update prompt, a failed update) gets an offer
 * in the pane instead, never an automatic retry. A conversation-keeping preset
 * switch the CLI refused gets its own offer (#16045), on a PTY exit too.
 */
export function handleAgentEnd(payload: AgentExitedPayload, observedRestartKey?: number): void {
  if (takeRefusedPresetSwitch(payload, observedRestartKey)) return;
  const end = payload.agentEnd;
  const agentId = payload.agentType;
  if (!end?.launchedRun || payload.exitKind !== "subcommand" || !agentId) return;

  const state = usePanelStore.getState();
  const panel = state.panelsById[payload.terminalId];
  if (!panel || !isPtyPanel(panel) || panel.launchAgentId !== agentId) return;
  if (panel.location !== "grid" && panel.location !== "dock") return;
  if (panel.restoreRecovery || panel.isRestarting || !isIdleShell(panel)) return;
  if (getAgentConfig(agentId)?.resume?.kind !== "session-id") return;

  const sessionId = panel.agentSessionId;
  if (end.selfUpdateSucceeded && sessionId) {
    const key = `${panel.id}\u0000${agentId}\u0000${sessionId}`;
    const heldElsewhere =
      isResumeSessionReserved(agentId, sessionId) ||
      siblingHeldSessionIds(state.panelsById, panel.id, agentId).has(sessionId);
    if (!autoResumed.has(key) && !heldElsewhere) {
      autoResumed.add(key);
      logInfo("[agentEndRecovery] Relaunching conversation after agent self-update", {
        terminalId: panel.id,
        agentId,
      });
      void reopenInPlace(panel, agentId, sessionId);
      return;
    }
  }

  if (end.resumeHintSeen) return;
  if (!sessionId && !PICKER_AGENTS.has(agentId)) return;

  usePanelStore.setState((current) => {
    const latest = current.panelsById[panel.id];
    if (!latest || !isPtyPanel(latest)) return current;
    return {
      panelsById: {
        ...current.panelsById,
        [panel.id]: {
          ...latest,
          agentResumeOffer: { agentId, ...(sessionId ? { sessionId } : {}) },
        },
      },
    };
  });
}

/**
 * Reopen `sessionId` in this pane from its resume offer, the user's own pick.
 * Refused when another pane already holds the conversation, so one transcript
 * never gets two writers (#11461).
 */
export async function resumeFromAgentEndOffer(
  panelId: string,
  sessionId: string
): Promise<RestoreRecoveryLaunchResult> {
  const panel = usePanelStore.getState().panelsById[panelId];
  if (!panel || !isPtyPanel(panel) || !panel.launchAgentId || panel.isRestarting) {
    return "unavailable";
  }
  return reopenInPlace(panel, panel.launchAgentId, sessionId);
}

export function dismissAgentResumeOffer(panelId: string): void {
  usePanelStore.setState((state) => {
    const panel = state.panelsById[panelId];
    if (!panel || !isPtyPanel(panel) || panel.agentResumeOffer === undefined) return state;
    return {
      panelsById: { ...state.panelsById, [panelId]: { ...panel, agentResumeOffer: undefined } },
    };
  });
}

/** The refused switch on `panelId`, while its pane is still the shell the refusal left. */
function refusedSwitchAt(panelId: string) {
  const panel = usePanelStore.getState().panelsById[panelId];
  if (!panel || !isPtyPanel(panel) || panel.isRestarting || !isIdleShell(panel)) return null;
  const attempt = panel.presetSwitchResume;
  return attempt?.refused ? { panel, attempt } : null;
}

/**
 * "Start new" after a refused switch (#16045): a new conversation on the preset
 * the CLI couldn't find the old one on, the user's own pick.
 */
export async function startNewAfterRefusedSwitch(panelId: string): Promise<PresetRespawnResult> {
  const refused = refusedSwitchAt(panelId);
  if (!refused) return { success: false, error: "unavailable" };
  return usePanelStore.getState().restartTerminalOnPreset(panelId, refused.attempt.presetId);
}

/**
 * "Back" after a refused switch (#16045): the launch the pane ran before the
 * switch, put back as it was, reopening the same conversation there. Refused
 * like any reopen when another pane holds the conversation (#11461).
 */
export async function returnAfterRefusedSwitch(
  panelId: string
): Promise<RestoreRecoveryLaunchResult> {
  const refused = refusedSwitchAt(panelId);
  if (!refused) return "unavailable";
  const { panel: refusedPane, attempt } = refused;
  const state = usePanelStore.getState();
  if (siblingHeldSessionIds(state.panelsById, panelId, attempt.agentId).has(attempt.sessionId)) {
    return "held-elsewhere";
  }
  // Held before the pane changes: a reopen elsewhere that hasn't published its
  // id yet must leave the offer standing, not a pane relabelled for nothing.
  const release = reserveResumeSession(attempt.agentId, attempt.sessionId);
  if (!release) return "held-elsewhere";
  try {
    let restored = false;
    usePanelStore.setState((current) => {
      const latest = current.panelsById[panelId];
      if (!latest || !isPtyPanel(latest) || latest.presetSwitchResume !== attempt) return current;
      restored = true;
      const panelsById = {
        ...current.panelsById,
        [panelId]: { ...latest, ...attempt.prior, presetSwitchResume: undefined },
      };
      saveNormalized(panelsById, current.panelIds);
      return { panelsById };
    });
    if (!restored) return "unavailable";
    const restartKey = refusedPane.restartKey ?? 0;
    await usePanelStore.getState().restartTerminal(panelId, { resumeSessionId: attempt.sessionId });
    // A restart refused before its spawn (the shell moved on, the folder
    // failed validation) leaves the count alone: put the pane back on the
    // preset that refused, offer and all, rather than relabelled for nothing.
    let started = true;
    usePanelStore.setState((current) => {
      const latest = current.panelsById[panelId];
      if (!latest || !isPtyPanel(latest) || (latest.restartKey ?? 0) !== restartKey) {
        return current;
      }
      started = false;
      const panelsById = {
        ...current.panelsById,
        [panelId]: { ...latest, ...presetSwitchLaunchOf(refusedPane), presetSwitchResume: attempt },
      };
      saveNormalized(panelsById, current.panelIds);
      return { panelsById };
    });
    return started ? "launched" : "unavailable";
  } finally {
    release();
  }
}

export function dismissRefusedPresetSwitch(panelId: string): void {
  usePanelStore.setState((state) => {
    const panel = state.panelsById[panelId];
    if (!panel || !isPtyPanel(panel) || panel.presetSwitchResume === undefined) return state;
    return {
      panelsById: { ...state.panelsById, [panelId]: { ...panel, presetSwitchResume: undefined } },
    };
  });
}
