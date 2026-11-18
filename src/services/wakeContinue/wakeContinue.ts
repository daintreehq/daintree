import type { TerminalStatusResult } from "@shared/types/terminalStatus";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { actionService } from "@/services/ActionService";
import {
  cancelAgentRequests,
  deliverAgentRequest,
  promptReadiness,
} from "@/services/agentRequests";
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
/** The pause a lane takes after one note before it starts on the next. */
export const WAKE_CONTINUE_SPACING_MS = 3_000;

const OWNER_PREFIX = "wake-continue:";

let nextOfferId = 0;

const ownerKeyFor = (offerId: string, terminalId: string) =>
  `${OWNER_PREFIX}${offerId}:${terminalId}`;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Offer a continue note for the agents a restore just resumed, replacing any
 * offer an earlier restore of this view made. Nothing is sent until the user
 * asks; a restore that resumed no agent clears the offer.
 */
export function publishWakeCandidates(
  projectId: string | null | undefined,
  candidates: readonly WakeCandidate[]
): void {
  const store = useWakeContinueStore.getState();
  const previous = store.offer;
  if (previous) cancelAgentRequests(`${OWNER_PREFIX}${previous.id}:`);
  if (!projectId || !candidates.some((candidate) => candidate.outcome === "resumed")) {
    if (previous) store.setOffer(null);
    return;
  }
  store.setOffer({
    id: `wake-${++nextOfferId}`,
    projectId,
    entries: candidates.map((candidate) => ({ ...candidate })),
    phase: "offered",
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

/**
 * Send `note` to every resumed agent in the current offer, a few at a time,
 * each once its session is observed waiting at its prompt. Panes that started
 * fresh or are held get nothing. Resolves when every note has settled or the
 * offer has gone.
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
  const targets = offer.entries.filter((entry) => entry.outcome === "resumed");
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < targets.length && owned()) {
      const entry = targets[next++]!;
      await deliverNote(offer, entry, text, owned);
      if (next < targets.length) await wait(WAKE_CONTINUE_SPACING_MS);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(WAKE_CONTINUE_MAX_IN_FLIGHT, targets.length) }, lane)
  );
  useWakeContinueStore.getState().setPhase(offer.id, "done");
}

async function deliverNote(
  offer: WakeContinueOffer,
  entry: WakeContinueEntry,
  note: string,
  owned: () => boolean
): Promise<void> {
  const setDelivery = useWakeContinueStore.getState().setDelivery;
  const panel = usePanelStore.getState().panelsById[entry.terminalId];
  if (!panel || panel.location === "trash") {
    setDelivery(offer.id, entry.terminalId, {
      status: "failed",
      message: `${entry.title} was closed — no note sent`,
    });
    return;
  }
  try {
    await deliverAgentRequest({
      ownerKey: ownerKeyFor(offer.id, entry.terminalId),
      destination: { kind: "terminal", terminalId: entry.terminalId, title: entry.title },
      worktreeId: panel.worktreeId ?? null,
      stillOwned: owned,
      onState: (delivery) => setDelivery(offer.id, entry.terminalId, delivery.state),
      buildPrompt: async () => note,
      readiness: promptReadiness,
      verify: () => untouchedSinceWake(entry, offer.projectId),
    });
  } catch (error) {
    setDelivery(offer.id, entry.terminalId, {
      status: "failed",
      message: formatErrorMessage(error, "Couldn't send the note"),
    });
  }
}

/**
 * A pane someone has written in since it resumed is theirs: the note would be
 * appended to their draft, or follow a turn they started themselves.
 */
async function untouchedSinceWake(
  entry: WakeContinueEntry,
  projectId: string
): Promise<string | null> {
  const draft = useTerminalInputStore.getState().getDraftInput(entry.terminalId, projectId);
  if (draft.trim() !== "") return `${entry.title} has a draft in its input — no note sent`;
  const status = await actionService.dispatch<TerminalStatusResult>(
    "terminal.getStatus",
    { terminalIds: [entry.terminalId] },
    { source: "user" }
  );
  if (!status.ok) return null;
  const typedAt = status.result.terminals.find(
    (terminal) => terminal.terminalId === entry.terminalId
  )?.lastTypedInputAt;
  return typedAt !== undefined && typedAt >= entry.restoredAt
    ? `${entry.title} was typed in after it resumed — no note sent`
    : null;
}
