import type { AgentDirectorySubject } from "@shared/types/agentDirectory";
import type { CanopyTerminalApi } from "@/components/Canopy/canopyHostSource";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { useProjectStore } from "@/store/projectStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";

/**
 * The live pane and composer, pointed at one Daintree Assistant (#14162). The
 * pane asks to watch by terminal id; this watches by the exact subject instead,
 * so main checks the lane (or global session) and launch generation itself.
 * Input, keys, submit and resize ride the same stream id, and main refuses
 * them once that session has ended or been replaced. Answer buttons read
 * Canopy's cards of workers, so an assistant has none.
 */
export function assistantTerminalApi(subject: AgentDirectorySubject): CanopyTerminalApi {
  const canopy = window.electron.canopy;
  return {
    holdsSize: true,
    watchTerminal: () => canopy.watchAssistantTerminal(subject),
    unwatchTerminal: (...args) => canopy.unwatchTerminal(...args),
    terminalInput: (...args) => canopy.terminalInput(...args),
    terminalResize: (...args) => canopy.terminalResize(...args),
    terminalSubmit: (...args) => canopy.terminalSubmit(...args),
    terminalSendKey: (...args) => canopy.terminalSendKey(...args),
    answer: () => Promise.reject(new Error("An assistant has no card answers.")),
    onTerminalData: (callback) => canopy.onTerminalData(callback),
    onResync: () => () => {},
  };
}

export type OpenInAssistantResult =
  | { ok: true }
  /**
   * `ended`: the session stopped or was replaced, so there is nothing to open;
   * resuming or starting one is the person's own separate choice.
   * `unsupported`: the global session has no panel in this view to land in.
   * `not-attached`: it runs, but this view hasn't taken it over; the lane is
   * left as it was rather than opened empty, where it could start another.
   */
  | { ok: false; reason: "ended" | "unsupported" | "not-attached" };

/**
 * "Open in Assistant": land on the subject's own lane, moving to its project
 * only now that the person asked. Nothing is launched, resumed or reselected —
 * a session gone by the time the lane would show refuses rather than leaving a
 * fresh lane to start in its place.
 */
export async function openInAssistant(
  subject: AgentDirectorySubject
): Promise<OpenInAssistantResult> {
  const destination = await window.electron.canopy.resolveAssistant(subject);
  if (!destination) return { ok: false, reason: "ended" };
  if (destination.scope === "global") return { ok: false, reason: "unsupported" };
  if (destination.projectId === getViewWorkspaceId()) return activateAssistantLane(subject);
  await useProjectStore.getState().switchProject(destination.projectId, {
    focusIntent: { intent: "open-assistant", subject },
  });
  return { ok: true };
}

/** How long an arriving view is given to take the lane's running session over. */
const ATTACH_WAIT_MS = 5_000;

/**
 * Show the subject's lane in this view's Assistant panel, checked against main
 * once more at arrival: a project switch takes long enough for the session to
 * end, and its successor in the lane is not the one the person chose. Only a
 * lane this view already shows that terminal in is selected; an empty one is
 * never made, since an empty lane is one the panel may launch into.
 */
export async function activateAssistantLane(
  subject: AgentDirectorySubject
): Promise<OpenInAssistantResult> {
  const destination = await window.electron.canopy.resolveAssistant(subject);
  if (!destination) return { ok: false, reason: "ended" };
  if (destination.scope === "global") return { ok: false, reason: "unsupported" };
  if (destination.projectId !== getViewWorkspaceId()) return { ok: false, reason: "ended" };
  if (!(await laneShows(destination.lane, destination.terminalId))) {
    return { ok: false, reason: "not-attached" };
  }
  // The wait may have outlived the session the person chose.
  if (!(await window.electron.canopy.resolveAssistant(subject))) {
    return { ok: false, reason: "ended" };
  }
  const panel = useHelpPanelStore.getState();
  if (panel.sessions[destination.lane]?.terminalId !== destination.terminalId) {
    return { ok: false, reason: "not-attached" };
  }
  panel.setActiveSlot(destination.lane);
  panel.setOpen(true);
  panel.requestFocus();
  return { ok: true };
}

function laneShows(lane: number, terminalId: string): Promise<boolean> {
  const shows = (state: ReturnType<typeof useHelpPanelStore.getState>) =>
    state.sessions[lane]?.terminalId === terminalId;
  if (shows(useHelpPanelStore.getState())) return Promise.resolve(true);
  return new Promise((resolve) => {
    const settle = (value: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const timer = setTimeout(() => settle(false), ATTACH_WAIT_MS);
    const unsubscribe = useHelpPanelStore.subscribe((state) => {
      if (shows(state)) settle(true);
    });
  });
}
