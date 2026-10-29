import type { AgentDirectorySubject } from "@shared/types/agentDirectory";
import type { AssistantOpenDestination } from "@shared/types/ipc/canopy";
import type { GlobalAssistantInputStamp } from "@shared/types/ipc/help";
import { LOCAL_HOST_ID, isLocalHostId, type HostId } from "@shared/types/remoteHosts";
import type { CanopyTerminalApi } from "@/components/Canopy/canopyHostSource";
import { canopyHostClient } from "@/clients/canopyHostClient";
import { getViewHostId } from "@/hooks/useHostConnection";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { useProjectStore } from "@/store/projectStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";

/** The live pane's api for one assistant, and the end of its viewer when the pane lets it go. */
export interface AssistantTerminalApi extends CanopyTerminalApi {
  dispose(): void;
}

/** The host this view runs on, as this Shell names it. */
function viewHost(): HostId {
  return getViewHostId() ?? LOCAL_HOST_ID;
}

/**
 * Whether this view watches the subject's assistant itself: one of this
 * machine's windows and one of this machine's assistants. Anything else is
 * read through a viewer the assistant's own host serves (#14163).
 */
function watchedHere(subject: AgentDirectorySubject): boolean {
  return isLocalHostId(subject.hostId) && getViewHostId() === null;
}

let nextConsumer = 0;

/** A consumer id for one pane's viewer: its viewer on the host is its alone. */
function newConsumer(): string {
  return `assistant-${Date.now().toString(36)}-${(++nextConsumer).toString(36)}`;
}

const NO_CLEANUP = () => {};

/**
 * The live pane and composer, pointed at one Daintree Assistant (#14162). The
 * pane asks to watch by terminal id; this watches by the exact subject instead,
 * so main checks the lane (or global session) and launch generation itself.
 * Input, keys, submit and resize ride the same stream id, and main refuses
 * them once that session has ended or been replaced. Answer buttons read
 * Canopy's cards of workers, so an assistant has none.
 *
 * An assistant on another host, or on This Mac from a window bound elsewhere,
 * is read through a viewer that host serves for this pane alone: only its
 * terminal is watched there, no project is attached and no lease is taken.
 * It never sizes the terminal, and typing whose answer the link lost is said
 * as unknown rather than sent again.
 */
export function assistantTerminalApi(
  subject: AgentDirectorySubject,
  /**
   * The global session's input ownership this pane types under. Without it the
   * pane only reads; with it, input is refused once that ownership moves.
   */
  inputStamp?: GlobalAssistantInputStamp
): AssistantTerminalApi {
  if (watchedHere(subject)) {
    const canopy = window.electron.canopy;
    return {
      holdsSize: true,
      hostOf: () => subject.hostId,
      watchTerminal: () =>
        inputStamp
          ? canopy.watchAssistantTerminal(subject, inputStamp)
          : canopy.watchAssistantTerminal(subject),
      unwatchTerminal: (...args) => canopy.unwatchTerminal(...args),
      terminalInput: (...args) => canopy.terminalInput(...args),
      terminalResize: (...args) => canopy.terminalResize(...args),
      terminalSubmit: (...args) => canopy.terminalSubmit(...args),
      terminalSendKey: (...args) => canopy.terminalSendKey(...args),
      answer: () => Promise.reject(new Error("An assistant has no card answers.")),
      onTerminalData: (callback) => canopy.onTerminalData(callback),
      onResync: () => NO_CLEANUP,
      dispose: NO_CLEANUP,
    };
  }
  const consumer = newConsumer();
  const host = canopyHostClient;
  return {
    holdsSize: false,
    hostOf: () => subject.hostId,
    watchTerminal: () => host.watchAssistant(consumer, subject),
    unwatchTerminal: (...args) =>
      host.assistantInvoke(consumer, "canopy:unwatch-terminal", ...args),
    terminalInput: (...args) => host.assistantInvoke(consumer, "canopy:terminal-input", ...args),
    // The window showing it on its own host sizes it; this pane reads at that size.
    terminalResize: () => Promise.resolve(),
    terminalSubmit: (...args) => host.assistantInvoke(consumer, "canopy:terminal-submit", ...args),
    terminalSendKey: (...args) =>
      host.assistantInvoke(consumer, "canopy:terminal-send-key", ...args),
    answer: () => Promise.reject(new Error("An assistant has no card answers.")),
    onTerminalData: (callback) =>
      host.onEvent((event) => {
        if (event.kind === "assistant-terminal-data" && event.consumer === consumer) {
          callback(event.chunk);
        }
      }),
    onResync: (callback) =>
      host.onEvent((event) => {
        if (event.kind === "assistant-resync" && event.consumer === consumer) callback();
      }),
    dispose: () => {
      void host.releaseAssistant(consumer).catch(() => {});
    },
  };
}

/** Where the subject's assistant would open, asked of the host it runs on; null once it ended. */
async function resolveDestination(
  subject: AgentDirectorySubject
): Promise<AssistantOpenDestination | null> {
  if (watchedHere(subject)) return window.electron.canopy.resolveAssistant(subject);
  const consumer = newConsumer();
  try {
    return await canopyHostClient.resolveAssistant(consumer, subject);
  } finally {
    void canopyHostClient.releaseAssistant(consumer).catch(() => {});
  }
}

export type OpenInAssistantResult =
  | { ok: true }
  /**
   * `ended`: the session stopped or was replaced, so there is nothing to open;
   * resuming or starting one is the person's own separate choice.
   * `unsupported`: the global session runs on another machine, or this window
   * is bound to another host; it opens from a window on its own machine.
   * `not-attached`: it runs, but this view hasn't taken it over; the lane is
   * left as it was rather than opened empty, where it could start another.
   * `not-switched`: it runs on another host, and this window didn't move
   * there (the switch was overtaken, or the host asked which project).
   */
  | { ok: false; reason: "ended" | "unsupported" | "not-attached" | "not-switched" };

/**
 * "Open in Assistant": land on the subject's own lane, moving to its project
 * only now that the person asked. Nothing is launched, resumed or reselected —
 * a session gone by the time the lane would show refuses rather than leaving a
 * fresh lane to start in its place.
 */
export async function openInAssistant(
  subject: AgentDirectorySubject
): Promise<OpenInAssistantResult> {
  const destination = await resolveDestination(subject);
  if (!destination) return { ok: false, reason: "ended" };
  if (destination.scope === "global") return showGlobalAssistant(subject, destination);
  const onThisHost = sameHost(destination.hostId, viewHost());
  if (onThisHost && destination.projectId === getViewWorkspaceId()) {
    return activateAssistantLane(subject);
  }
  if (onThisHost) {
    await useProjectStore.getState().switchProject(destination.projectId, {
      focusIntent: { intent: "open-assistant", subject },
    });
    return { ok: true };
  }
  // Another host's lane: this window moves there, as choosing that host's
  // project would move it, and the lane is checked again once it arrives.
  const result = await window.electron.remoteHosts.switchWindowHost({
    hostId: destination.hostId,
    newWindow: false,
    projectId: destination.projectId,
    focusIntent: { intent: "open-assistant", subject },
  });
  return result.outcome === "switched" || result.outcome === "focused-elsewhere"
    ? { ok: true }
    : { ok: false, reason: "not-switched" };
}

/**
 * Show the global session in this view's Assistant panel, pinned to the exact
 * run main just confirmed: no project moves, nothing starts, and if that run is
 * replaced before the pane reads it, the pane says it ended rather than showing
 * its successor.
 */
function showGlobalAssistant(
  subject: AgentDirectorySubject,
  destination: Extract<AssistantOpenDestination, { scope: "global" }>
): OpenInAssistantResult {
  // Its input and lifecycle belong to windows of the machine it runs on.
  if (!watchedHere(subject)) return { ok: false, reason: "unsupported" };
  const panel = useHelpPanelStore.getState();
  panel.selectGlobal({
    hostId: destination.hostId,
    scope: { kind: "global" },
    terminalId: destination.terminalId,
    incarnation: destination.incarnation,
  });
  panel.setOpen(true);
  panel.requestFocus();
  return { ok: true };
}

function sameHost(a: string, b: string): boolean {
  return (isLocalHostId(a) ? LOCAL_HOST_ID : a) === (isLocalHostId(b) ? LOCAL_HOST_ID : b);
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
  const destination = await resolveDestination(subject);
  if (!destination) return { ok: false, reason: "ended" };
  if (destination.scope === "global") return showGlobalAssistant(subject, destination);
  if (!sameHost(destination.hostId, viewHost()) || destination.projectId !== getViewWorkspaceId()) {
    return { ok: false, reason: "ended" };
  }
  if (!(await laneShows(destination.lane, destination.terminalId))) {
    return { ok: false, reason: "not-attached" };
  }
  // The wait may have outlived the session the person chose.
  if (!(await resolveDestination(subject))) {
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
