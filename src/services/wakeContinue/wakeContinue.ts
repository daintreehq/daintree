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
  entry: Pick<WakeContinueEntry, "restoredAt" | "outcome" | "heldSessionId">,
  panel: PanelInstance | undefined
): WakeLiveOutcome {
  if (!panel || panel.location === "trash" || !isPtyPanel(panel)) return "closed";
  // A hold is read off the hold itself: a live commit can drop a held pane's
  // provenance while the hold stands.
  if (panel.restoreRecovery !== undefined) return "held";
  const provenance = panel.restoreProvenance;
  if (!provenance || provenance.at !== entry.restoredAt) return "restarted";
  if (provenance.disposition === "held") return "held";
  if (provenance.disposition !== "resume") return "fresh";
  // A pane the user started from its hold counts only on the conversation it
  // was held with; picking another one is a different session.
  if (
    entry.outcome === "held" &&
    (!entry.heldSessionId || panel.agentSessionId !== entry.heldSessionId)
  ) {
    return "restarted";
  }
  return "resumed";
}

/**
 * Why an offered pane won't get the note: its restore outcome, or something
 * done to it since that sending would refuse — a composer message, or a draft
 * waiting in its input. Raw typing in the pty is only readable at delivery.
 */
export type WakeSkipReason = Exclude<WakeLiveOutcome, "resumed"> | "messaged" | "drafted";
export type WakeRowOutcome = WakeLiveOutcome | "messaged" | "drafted";

/**
 * The one reading the dialog's preview, its count and sending all share. The
 * composer's last send and the pane's draft come in as arguments, so a caller
 * rendering it re-reads when either changes.
 */
export function wakeEntryOutcome(
  entry: Pick<WakeContinueEntry, "restoredAt" | "outcome" | "heldSessionId" | "composerSendSeq">,
  panel: PanelInstance | undefined,
  lastSendSeq: number | undefined,
  draft: string
): WakeRowOutcome {
  const live = liveWakeOutcome(entry, panel);
  if (live !== "resumed") return live;
  if (lastSendSeq !== entry.composerSendSeq) return "messaged";
  if (draft.trim() !== "") return "drafted";
  return "resumed";
}

function currentWakeOutcome(entry: WakeContinueEntry, projectId: string): WakeRowOutcome {
  return wakeEntryOutcome(
    entry,
    usePanelStore.getState().panelsById[entry.terminalId],
    getLastComposerSend(entry.terminalId)?.seq,
    useTerminalInputStore.getState().getDraftInput(entry.terminalId, projectId)
  );
}

/**
 * Offer a continue note for the agents a restore just relaunched that were last
 * seen working before they were stopped (#17886), replacing any offer an
 * earlier restore of this view made. One that was idle, waiting or done has
 * nothing to pick up, so it is left out altogether. Nothing is sent until the
 * user asks. A restore with nothing that can take a note (no such agent
 * resumed, and none held only until the user starts it) clears the offer.
 */
export function publishWakeCandidates(
  projectId: string | null | undefined,
  allCandidates: readonly WakeCandidate[]
): void {
  const store = useWakeContinueStore.getState();
  const previous = store.offer;
  if (previous) cancelAgentRequests(`${OWNER_PREFIX}${previous.id}:`);
  const candidates = allCandidates.filter(
    (candidate) => candidate.lastSeen?.agentState === "working"
  );
  const offerable = candidates.some(
    (candidate) =>
      candidate.outcome === "resumed" ||
      (candidate.outcome === "held" &&
        candidate.holdReason === "resume-deferred" &&
        candidate.heldSessionId !== undefined)
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
  /**
   * Pinned on the first attempt and held across retries: the agent that
   * attempt found in the pty, and what had been typed into it by then.
   */
  pinned?: { incarnation: number | undefined; typedAt: number | undefined | "unread" };
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
  // The panes the dialog counted, by the same reading; the rest keep the
  // reason they were left out, so the report doesn't drift as panes change.
  const skipped: Record<string, WakeSkipReason> = {};
  const waiting: Waiting[] = [];
  for (const entry of offer.entries) {
    const outcome = currentWakeOutcome(entry, offer.projectId);
    if (outcome === "resumed") {
      waiting.push({ entry, deadline: startedAt + WAKE_CONTINUE_READY_TIMEOUT_MS });
    } else {
      skipped[entry.terminalId] = outcome;
    }
  }
  store.markSkipped(offer.id, skipped);
  const slots = Array.from({ length: WAKE_CONTINUE_MAX_IN_FLIGHT }, () => ({
    busy: false,
    freeAt: 0,
  }));

  while (owned() && (waiting.length > 0 || slots.some((slot) => slot.busy))) {
    const now = Date.now();
    // In offer order, so the panes go out in the order the grid shows them.
    for (const item of [...waiting]) {
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
        if (!slot) {
          // At its prompt with every slot busy or cooling: waiting its turn, not its prompt.
          const shown = useWakeContinueStore
            .getState()
            .offer?.entries.find((entry) => entry.terminalId === item.entry.terminalId)
            ?.delivery?.status;
          if (shown !== "queued") {
            setDelivery(offer.id, item.entry.terminalId, { status: "queued" });
          }
          continue;
        }
        waiting.splice(waiting.indexOf(item), 1);
        const panel = panelOf(item.entry.terminalId);
        const incarnation = panel && isPtyPanel(panel) ? panel.agentIncarnation : undefined;
        item.pinned ??= { incarnation, typedAt: "unread" };
        if (item.pinned.incarnation !== incarnation) {
          // Another agent took the pty over between attempts: not the session
          // the wake resumed.
          setDelivery(offer.id, item.entry.terminalId, {
            status: "failed",
            message: `${item.entry.title} was restarted after it resumed — no note sent`,
          });
          continue;
        }
        slot.busy = true;
        const admitted: Admission = {
          generation: startedAtOf(panel),
          settledAt: panel && isPtyPanel(panel) ? panel.lastStateChange : undefined,
          pinned: item.pinned,
        };
        void deliverNote(offer, item.entry, text, admitted, owned).then((outcome) => {
          slot.busy = false;
          if (outcome === "lapsed") {
            // Nothing went in: the pane left its prompt, so it waits for the
            // next settle like any other, and the slot is free at once.
            item.promptSince = undefined;
            if (owned()) waiting.push(item);
            return;
          }
          slot.freeAt = Date.now() + WAKE_CONTINUE_SPACING_MS;
        });
        continue;
      }
      waiting.splice(waiting.indexOf(item), 1);
      if (typeof verdict === "object" && "failed" in verdict) {
        setDelivery(offer.id, item.entry.terminalId, {
          status: "failed",
          message: verdict.failed,
        });
      }
    }
    await wait(SCHEDULER_POLL_MS);
  }
  if (!owned()) return;
  useWakeContinueStore.getState().setPhase(offer.id, "done");
  clearWhenEveryNoteWent(offer.id);
}

/**
 * A finished send with every note in has nothing left to look at, so the offer
 * goes by itself. Anything that needs a look (a failure, an unconfirmed write,
 * an agent asking first) or no note at all keeps it up with its report. A
 * review dialog the user has open keeps the report in front of them until it
 * closes.
 */
function clearWhenEveryNoteWent(offerId: string): void {
  const settledClean = () => {
    const offer = useWakeContinueStore.getState().offer;
    if (offer?.id !== offerId) return false;
    const delivered = offer.entries.filter((entry) => entry.delivery !== undefined);
    return delivered.length > 0 && delivered.every((entry) => entry.delivery?.status === "sent");
  };
  if (!settledClean()) return;
  if (!useWakeContinueStore.getState().dialogOpen) {
    dismissWakeContinue();
    return;
  }
  const unsubscribe = useWakeContinueStore.subscribe((state) => {
    if (state.offer?.id !== offerId) return unsubscribe();
    if (state.dialogOpen) return;
    unsubscribe();
    dismissWakeContinue();
  });
}

const startedAtOf = (panel: PanelInstance | undefined) =>
  panel && isPtyPanel(panel) ? panel.startedAt : undefined;

/** Whether a waiting pane takes its note now, waits on, or is out. */
function assess(
  item: Waiting,
  panel: PanelInstance | undefined,
  now: number
): "admit" | { wait: "starting" | "needs-you" } | { failed: string } {
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
  if (now >= item.deadline) {
    // Keep what held it up: a pane still asking the user is worth opening.
    return {
      failed:
        readiness === "needs-you"
          ? `${entry.title} was still waiting on you — no note sent`
          : `${entry.title} didn't reach its prompt`,
    };
  }
  return { wait: readiness === "needs-you" ? "needs-you" : "starting" };
}

/** What the scheduler saw when it let a note go: the process, and the prompt it timed. */
interface Admission {
  generation: number | undefined;
  settledAt: number | undefined;
  pinned: NonNullable<Waiting["pinned"]>;
}

/**
 * One note through the request lane. `lapsed` when the pane stopped being at
 * the prompt the scheduler timed before anything was typed: the lane would
 * otherwise wait on it in its slot, and take the next prompt untimed.
 */
async function deliverNote(
  offer: WakeContinueOffer,
  entry: WakeContinueEntry,
  note: string,
  admitted: Admission,
  owned: () => boolean
): Promise<"settled" | "lapsed"> {
  const setDelivery = useWakeContinueStore.getState().setDelivery;
  const panel = usePanelStore.getState().panelsById[entry.terminalId];
  let lapsed = false;
  try {
    await deliverAgentRequest({
      ownerKey: ownerKeyFor(offer.id, entry.terminalId),
      destination: { kind: "terminal", terminalId: entry.terminalId, title: entry.title },
      worktreeId: panel?.worktreeId ?? null,
      // Once lapsed, the lane's next look ends the run before it types.
      stillOwned: () => owned() && !lapsed,
      onState: (delivery) => {
        if (lapsed) return;
        const { status } = delivery.state;
        if (status === "queued" || status === "needs-you") {
          lapsed = true;
          return;
        }
        setDelivery(offer.id, entry.terminalId, delivery.state);
      },
      buildPrompt: async () => note,
      // Only the prompt the scheduler timed: one that replaced it is untimed.
      readiness: (status) => {
        const readiness = promptReadiness(status);
        return readiness === "ready" && status.lastTransitionAt !== admitted.settledAt
          ? "not-yet"
          : readiness;
      },
      verify: async () => {
        const panelNow = usePanelStore.getState().panelsById[entry.terminalId];
        const settledAt = panelNow && isPtyPanel(panelNow) ? panelNow.lastStateChange : undefined;
        if (settledAt !== admitted.settledAt) {
          lapsed = true;
          return "left its prompt";
        }
        return untouchedSinceWake(entry, offer.projectId, admitted);
      },
    });
  } catch (error) {
    if (lapsed) return "lapsed";
    setDelivery(offer.id, entry.terminalId, {
      status: "failed",
      message: formatErrorMessage(error, "Couldn't send the note"),
    });
  }
  return lapsed ? "lapsed" : "settled";
}

/**
 * Whether the pane is still the session the wake resumed and nobody has
 * written in it since: the note would be appended to their draft, or follow a
 * turn they started themselves.
 */
async function untouchedSinceWake(
  entry: WakeContinueEntry,
  projectId: string,
  admitted: Admission
): Promise<string | null> {
  const panel = usePanelStore.getState().panelsById[entry.terminalId];
  if (liveWakeOutcome(entry, panel) !== "resumed" || startedAtOf(panel) !== admitted.generation) {
    return `${entry.title} was restarted after it resumed — no note sent`;
  }
  const draft = useTerminalInputStore.getState().getDraftInput(entry.terminalId, projectId);
  if (draft.trim() !== "") return `${entry.title} has a draft in its input — no note sent`;
  if (getLastComposerSend(entry.terminalId)?.seq !== entry.composerSendSeq) {
    return `${entry.title} was sent a message after it resumed — no note sent`;
  }
  const activity = await terminalClient
    .getOutputActivity([entry.terminalId])
    .then((lookups) => lookups[entry.terminalId])
    .catch(() => undefined);
  if (activity?.status !== "read") {
    return `Couldn't tell whether ${entry.title} was typed in — no note sent`;
  }
  // Read against the prompt the note goes in at, as the wake gate does: a
  // launch that types its own command (a shell without the startup wrapper)
  // stamps the pty before the agent ever settles, and is no one's draft.
  const typedAt = activity.lastTypedInputAt;
  // And against what the first attempt read: a prompt timestamp the renderer
  // stamped itself can't be ordered against the host's, but a change can.
  if (admitted.pinned.typedAt === "unread") admitted.pinned.typedAt = typedAt;
  const typedSince =
    typedAt !== admitted.pinned.typedAt ||
    (typedAt !== undefined && (admitted.settledAt === undefined || typedAt >= admitted.settledAt));
  return typedSince ? `${entry.title} was typed in after it resumed — no note sent` : null;
}
