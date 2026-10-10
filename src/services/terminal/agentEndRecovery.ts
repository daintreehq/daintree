import type { AgentExitedPayload } from "@shared/types";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import { getAgentConfig } from "@/config/agents";
import { usePanelStore } from "@/store/panelStore";
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
 * React to the run Daintree launched in a pane quitting to its shell (#13226).
 *
 * A successful self-update is the user's own "Update now", and the CLI exits
 * asking to be started again, so the conversation the pane was opened on is
 * relaunched in place — once. Every other end that left no resume hint behind
 * (a crash at boot, Ctrl-C at the update prompt, a failed update) gets an offer
 * in the pane instead, never an automatic retry.
 */
export function handleAgentEnd(payload: AgentExitedPayload): void {
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
