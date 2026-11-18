import type { PanelInstance } from "@shared/types/panel";
import { isPtyPanel } from "@shared/types/panel";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { terminalClient } from "@/clients/terminalClient";
import {
  cancelAgentRequests,
  deliverAgentRequest,
  promptReadiness,
} from "@/services/agentRequests";
import { getLastComposerSend } from "@/store/lastComposerSendStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import {
  useWakeContinueStore,
  type WakeContinueEntry,
  type WakeContinueOffer,
} from "@/store/wakeContinueStore";
import type { WakeCandidate } from "./wakeCandidate";

export const DEFAULT_CONTINUE_NOTE = "Please pick up where you left off.";

/**
 * Notes in flight at once. A resumed fleet told to continue all at once is the
 * burst #14382 hit on usage limits; a few at a time spreads the work out.
 */
export const WAKE_CONTINUE_MAX_IN_FLIGHT = 3;
/** The pause a slot takes after one note settles before it takes the next. */
export const WAKE_CONTINUE_SPACING_MS = 3_000;
/**
 * How long a prompt reading must hold, as this view saw it, before a note is
 * typed at it. A CLI that pauses while it loads its history reads as settled
 * for a moment before it can take input.
 */
export const WAKE_CONTINUE_PROMPT_SETTLE_MS = 2_000;
/** How long a resumed agent may take to reach its prompt; working extends it. */
export const WAKE_CONTINUE_READY_TIMEOUT_MS = 3 * 60_000;
const SCHEDULER_POLL_MS = 250;

const OWNER_PREFIX = "wake-continue:";

let nextOfferId = 0;
let unwatchProject: (() => void) | null = null;

const ownerKeyFor = (offerId: string, terminalId: string) =>
  `${OWNER_PREFIX}${offerId}:${terminalId}`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What a relaunched pane is now, read off the panel itself: its restore
 * provenance names the pass that rebuilt it, and every restart clears it, so a
 * pane restarted since — or replaced by something else — is no longer the
 * session the wake resumed. A pane held for the user becomes `resumed` when
 * they start it on its conversation.
 */
export type WakeLiveOutcome = WakeCandidate["outcome"] | "restarted" | "closed";

export function liveWakeOutcome(
  entry: Pick<WakeContinueEntry, "restoredAt">,
  panel: PanelInstance | undefined
): WakeLiveOutcome {
  if (!panel || panel.location === "trash" || !isPtyPanel(panel)) return "closed";
  // A hold is read off the hold itself: a live commit can drop a held pane's
  // provenance while the hold stands.
  if (panel.restoreRecovery !== undefined) return "held";
  const provenance = panel.restoreProvenance;
  if (!provenance || provenance.at !== entry.restoredAt) return "restarted";
  if (provenance.disposition === "held") return "held";
  return provenance.disposition === "resume" ? "resumed" : "fresh";
}

/**
 * Offer a continue note for the agents a restore just relaunched, replacing
 * any offer an earlier restore of this view made. Nothing is sent until the
 * user asks. A restore with nothing that can take a note (no agent resumed,
 * and none held only until the user starts it) clears the offer.
 */
export function publishWakeCandidates(
  projectId: string | null | undefined,
  candidates: readonly WakeCandidate[]
): void {
  const store = useWakeContinueStore.getState();
  const previous = store.offer;
  if (previous) cancelAgentRequests(`${OWNER_PREFIX}${previous.id}:`);
  const offerable = candidates.some(
    (candidate) =>
      candidate.outcome === "resumed" ||
      (candidate.outcome === "held" && candidate.holdReason === "resume-deferred")
  );
  if (!projectId || !offerable) {
    if (previous) store.setOffer(null);
    return;
  }
  watchProject();
  store.setOffer({
    id: `wake-${++nextOfferId}`,
    projectId,
    entries: candidates.map((candidate) => ({
      ...candidate,
      composerSendSeq: getLastComposerSend(candidate.terminalId)?.seq,
    })),
    phase: "offered",
  });
}

/**
 * A view that drops to the picker (Sleep) keeps its renderer, and its store
 * with it. The offer belongs to the wake that made it, so it goes with the
 * project rather than coming back when the view is reused.
 */
function watchProject(): void {
  if (unwatchProject) return;
  unwatchProject = useProjectStore.subscribe((state, prev) => {
    const offer = useWakeContinueStore.getState().offer;
    if (!offer) return;
    const now = state.currentProject?.id;
    if (now !== prev.currentProject?.id && now !== offer.projectId) dismissWakeContinue();
  });
}

/** Withdraw the offer, and stop any note that hasn't gone in yet. */
export function dismissWakeContinue(): void {
  const store = useWakeContinueStore.getState();
  const offer = store.offer;
  if (!offer) return;
  cancelAgentRequests(`${OWNER_PREFIX}${offer.id}:`);
  store.setOffer(null);
}

interface Waiting {
  entry: WakeContinueEntry;
  deadline: number;
  /** The prompt reading being timed, and when this view first saw it. */
  promptSince?: { lastStateChange: number; seenAt: number };
}

/**
 * Send `note` to every agent in the current offer that is running the session
 * the wake resumed, a few at a time, each once it is observed settled at its
 * prompt. Panes that started fresh, are still held, or were restarted since
 * get nothing. Resolves when every note has settled or the offer has gone.
 */
export async function sendWakeContinueNotes(note: string): Promise<void> {
  const store = useWakeContinueStore.getState();
  const offer = store.offer;
  const text = note.trim();
  if (!offer || offer.phase !== "offered" || text === "") return;
  store.setPhase(offer.id, "sending");

  const owned = () =>
    useWakeContinueStore.getState().offer?.id === offer.id &&
    useProjectStore.getState().currentProject?.id === offer.projectId;
  const panelOf = (id: string) => usePanelStore.getState().panelsById[id];
  const setDelivery = useWakeContinueStore.getState().setDelivery;

  const startedAt = Date.now();
  const waiting: Waiting[] = offer.entries
    .filter((entry) => liveWakeOutcome(entry, panelOf(entry.terminalId)) === "resumed")
    .map((entry) => ({ entry, deadline: startedAt + WAKE_CONTINUE_READY_TIMEOUT_MS }));
  const slots = Array.from({ length: WAKE_CONTINUE_MAX_IN_FLIGHT }, () => ({
    busy: false,
    freeAt: 0,
  }));

  while (owned() && (waiting.length > 0 || slots.some((slot) => slot.busy))) {
    const now = Date.now();
    for (let i = waiting.length - 1; i >= 0; i--) {
      const item = waiting[i]!;
      const verdict = assess(item, panelOf(item.entry.terminalId), now);
      if (typeof verdict === "object" && "wait" in verdict) {
        const shown = useWakeContinueStore
          .getState()
          .offer?.entries.find((entry) => entry.terminalId === item.entry.terminalId)
          ?.delivery?.status;
        if (shown !== verdict.wait) {
          setDelivery(offer.id, item.entry.terminalId, { status: verdict.wait });
        }
        continue;
      }
      if (verdict === "admit") {
        const slot = slots.find((candidate) => !candidate.busy && candidate.freeAt <= now);
        if (!slot) continue;
        waiting.splice(i, 1);
        slot.busy = true;
        const generation = startedAtOf(panelOf(item.entry.terminalId));
        void deliverNote(offer, item.entry, text, generation, owned).finally(() => {
          slot.busy = false;
          slot.freeAt = Date.now() + WAKE_CONTINUE_SPACING_MS;
        });
        continue;
      }
      waiting.splice(i, 1);
      if (typeof verdict === "object" && "failed" in verdict) {
        setDelivery(offer.id, item.entry.terminalId, {
          status: "failed",
          message: verdict.failed,
        });
      }
    }
    await wait(SCHEDULER_POLL_MS);
  }
  useWakeContinueStore.getState().setPhase(offer.id, "done");
}

const startedAtOf = (panel: PanelInstance | undefined) =>
  panel && isPtyPanel(panel) ? panel.startedAt : undefined;

/** Whether a waiting pane takes its note now, waits on, or is out. */
function assess(
  item: Waiting,
  panel: PanelInstance | undefined,
  now: number
): "admit" | { wait: "queued" | "needs-you" } | { failed: string } {
  const { entry } = item;
  const outcome = liveWakeOutcome(entry, panel);
  if (outcome === "closed") return { failed: `${entry.title} was closed — no note sent` };
  if (outcome !== "resumed" || !panel || !isPtyPanel(panel)) {
    return { failed: `${entry.title} was restarted after it resumed — no note sent` };
  }
  if (panel.agentState === "working" || panel.agentState === "directing") {
    item.deadline = Math.max(item.deadline, now + WAKE_CONTINUE_READY_TIMEOUT_MS);
  }
  const readiness = promptReadiness({
    agentState: panel.agentState,
    waitingReason: panel.waitingReason,
    lastTransitionAt: panel.lastStateChange,
  });
  if (readiness === "ready" && panel.lastStateChange !== undefined) {
    if (item.promptSince?.lastStateChange !== panel.lastStateChange) {
      item.promptSince = { lastStateChange: panel.lastStateChange, seenAt: now };
    }
    if (now - item.promptSince.seenAt >= WAKE_CONTINUE_PROMPT_SETTLE_MS) return "admit";
  } else {
    item.promptSince = undefined;
  }
  if (now >= item.deadline) return { failed: `${entry.title} didn't reach its prompt` };
  return { wait: readiness === "needs-you" ? "needs-you" : "queued" };
}

async function deliverNote(
  offer: WakeContinueOffer,
  entry: WakeContinueEntry,
  note: string,
  generation: number | undefined,
  owned: () => boolean
): Promise<void> {
  const setDelivery = useWakeContinueStore.getState().setDelivery;
  const panel = usePanelStore.getState().panelsById[entry.terminalId];
  try {
    await deliverAgentRequest({
      ownerKey: ownerKeyFor(offer.id, entry.terminalId),
      destination: { kind: "terminal", terminalId: entry.terminalId, title: entry.title },
      worktreeId: panel?.worktreeId ?? null,
      stillOwned: owned,
      onState: (delivery) => setDelivery(offer.id, entry.terminalId, delivery.state),
      buildPrompt: async () => note,
      readiness: promptReadiness,
      verify: () => untouchedSinceWake(entry, offer.projectId, generation),
    });
  } catch (error) {
    setDelivery(offer.id, entry.terminalId, {
      status: "failed",
      message: formatErrorMessage(error, "Couldn't send the note"),
    });
  }
}

/**
 * Whether the pane is still the session the wake resumed and nobody has
 * written in it since: the note would be appended to their draft, or follow a
 * turn they started themselves.
 */
async function untouchedSinceWake(
  entry: WakeContinueEntry,
  projectId: string,
  generation: number | undefined
): Promise<string | null> {
  const panel = usePanelStore.getState().panelsById[entry.terminalId];
  if (liveWakeOutcome(entry, panel) !== "resumed" || startedAtOf(panel) !== generation) {
    return `${entry.title} was restarted after it resumed — no note sent`;
  }
  const draft = useTerminalInputStore.getState().getDraftInput(entry.terminalId, projectId);
  if (draft.trim() !== "") return `${entry.title} has a draft in its input — no note sent`;
  if (getLastComposerSend(entry.terminalId)?.seq !== entry.composerSendSeq) {
    return `${entry.title} was sent a message after it resumed — no note sent`;
  }
  // The resumed process is a new pty, whose record starts with nothing typed:
  // any typing on it at all is someone's.
  const activity = await terminalClient
    .getOutputActivity([entry.terminalId])
    .then((lookups) => lookups[entry.terminalId])
    .catch(() => undefined);
  if (activity?.status !== "read") {
    return `Couldn't tell whether ${entry.title} was typed in — no note sent`;
  }
  return activity.lastTypedInputAt !== undefined
    ? `${entry.title} was typed in after it resumed — no note sent`
    : null;
}
