import { useEffect, useRef, useState } from "react";
import { decisionsClient } from "@/clients/decisionsClient";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  DecisionsAnswerDestination,
  DecisionsAnswerOutcome,
  DecisionsAttentionItem,
} from "@shared/types/decisionsAttention";
import {
  RESUME_PENDING,
  aliasLabel,
  handledNeedsConfirm,
  outcomeSeverity,
  outcomeText,
  sameAttention,
  subjectOf,
} from "./decisionsAttentionModel";

export type AttentionBusy = "resume" | "reassign" | "handled";

export interface AttentionOutcome {
  message: string;
  severity: "success" | "warning";
  /** The token of the item the action was taken on. */
  token: string;
}

export interface PendingMove {
  item: DecisionsAttentionItem;
  destination: DecisionsAnswerDestination;
}

interface AttentionActionsOptions {
  /**
   * What an action belongs to: the opening, or the opening and the question
   * shown; null while closed. An outcome shows only in the scope its action
   * was taken in, and none outlives a close.
   */
  scope: string | null;
  /** What a confirmation belongs to, when not `scope`: it goes as this changes. */
  confirmScope?: string | null;
  /**
   * The items as the host lists them now, or null while that isn't known. A
   * confirmation goes once its item is no longer listed as it was asked about.
   */
  shown: readonly DecisionsAttentionItem[] | null;
  /** Reads the host's list again once an action settles. */
  refresh: () => unknown;
  /** A confirmation is about to ask about `item`. */
  onAsk?: (item: DecisionsAttentionItem) => void;
  /** An action on `item` was sent. */
  onStart?: (item: DecisionsAttentionItem, kind: AttentionBusy) => void;
  /**
   * An action on `item` settled: what main said, or null when it failed.
   * `current` is false once the scope it was sent in has ended.
   */
  onSettled?: (
    item: DecisionsAttentionItem,
    result: DecisionsAnswerOutcome | null,
    current: boolean
  ) => void;
}

export interface AttentionActions {
  busy: ReadonlyMap<string, AttentionBusy>;
  /** What the last action in this scope did. */
  outcome: AttentionOutcome | null;
  /**
   * Lets go of what the last action in `scope` did once something superseded
   * it, only while it is still the outcome of an action taken on `token`.
   */
  clearOutcome: (scope: string, token: string) => void;
  move: PendingMove | null;
  handling: DecisionsAttentionItem | null;
  resume: (item: DecisionsAttentionItem) => void;
  choose: (item: DecisionsAttentionItem, destination: DecisionsAnswerDestination) => void;
  handle: (item: DecisionsAttentionItem) => void;
  confirmMove: () => void;
  confirmHandled: () => void;
  cancelMove: () => void;
  cancelHandling: () => void;
}

/**
 * What a stalled answer's actions do, wherever they are shown (#16020,
 * #18027): Try resume, Choose destination after a confirmation naming both
 * panes, and Mark handled, which asks first while the answer can still be
 * resumed or sent on (#16638). Mark handled and the move carry the token the
 * item was read with, so main refuses one confirmed after the question asked
 * something else (#17944).
 */
export function useAttentionActions(options: AttentionActionsOptions): AttentionActions {
  const { scope, shown } = options;
  const confirmScope = options.confirmScope === undefined ? scope : options.confirmScope;
  const announce = useAnnouncerStore((state) => state.announce);
  const [busy, setBusy] = useState<ReadonlyMap<string, AttentionBusy>>(new Map());
  /** What the last action did, by the scope it was taken in, so coming back to that scope shows it. */
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, AttentionOutcome>>(new Map());
  const [move, setMove] = useState<PendingMove | null>(null);
  const [handling, setHandling] = useState<DecisionsAttentionItem | null>(null);

  // An action settles after the render that sent it: it reads the host as it is then.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  // A confirmation belongs to the scope it was asked in: a close, or another
  // question, takes it with it.
  useEffect(() => {
    setMove(null);
    setHandling(null);
  }, [confirmScope]);

  // Nothing said of a closed opening can show again: the next one is another scope.
  useEffect(() => {
    if (scope === null) setOutcomes(new Map());
  }, [scope]);

  // A confirmation asks about the item as it was read: once the host no longer
  // lists it so (handled in another window, its round replaced, delivered), it
  // goes rather than act on whatever the question holds now.
  useEffect(() => {
    if (shown === null) return;
    const stillShown = (asked: DecisionsAttentionItem) =>
      shown.some((item) => sameAttention(item, asked));
    if (handling !== null && !stillShown(handling)) setHandling(null);
    if (move !== null && !stillShown(move.item)) setMove(null);
  }, [shown, handling, move]);

  const run = async (
    item: DecisionsAttentionItem,
    kind: AttentionBusy,
    action: () => Promise<DecisionsAnswerOutcome>
  ) => {
    const startedIn = latest.current.scope;
    setBusy((current) => new Map(current).set(item.questionId, kind));
    if (kind === "resume")
      announce(`Resuming the agent for ${aliasLabel(item.alias)}. ${RESUME_PENDING}`);
    latest.current.onStart?.(item, kind);
    let result: DecisionsAnswerOutcome | null = null;
    let next: AttentionOutcome;
    try {
      result = await action();
      next = {
        message: outcomeText(item.alias, result, subjectOf(item)),
        severity: outcomeSeverity(result),
        token: item.token,
      };
    } catch (error) {
      next = {
        message: formatErrorMessage(
          error,
          `Couldn't change ${aliasLabel(item.alias)}'s ${subjectOf(item)}`
        ),
        severity: "warning",
        token: item.token,
      };
    }
    setBusy((current) => {
      const remaining = new Map(current);
      remaining.delete(item.questionId);
      return remaining;
    });
    const current = latest.current.scope === startedIn;
    if (startedIn !== null && latest.current.scope !== null) {
      setOutcomes((shown) => new Map(shown).set(startedIn, next));
    }
    // The person asked for it, so what came of it is said even once they've moved on,
    // naming the question when they have and the message doesn't.
    const alias = aliasLabel(item.alias);
    announce(current || next.message.includes(alias) ? next.message : `${alias}: ${next.message}`);
    latest.current.onSettled?.(item, result, current);
    await latest.current.refresh();
  };

  const markHandled = (item: DecisionsAttentionItem) =>
    void run(item, "handled", () => decisionsClient.markAnswerHandled(item.questionId, item.token));

  return {
    busy,
    outcome: scope === null ? null : (outcomes.get(scope) ?? null),
    clearOutcome: (cleared, token) =>
      setOutcomes((shown) => {
        // A later action's outcome in the same scope stays.
        if (shown.get(cleared)?.token !== token) return shown;
        const remaining = new Map(shown);
        remaining.delete(cleared);
        return remaining;
      }),
    move,
    handling,
    resume: (item) => void run(item, "resume", () => decisionsClient.resumeAnswer(item.questionId)),
    choose: (item, destination) => {
      latest.current.onAsk?.(item);
      setMove({ item, destination });
    },
    handle: (item) => {
      if (!handledNeedsConfirm(item)) {
        markHandled(item);
        return;
      }
      latest.current.onAsk?.(item);
      setHandling(item);
    },
    confirmMove: () => {
      if (move === null) return;
      const { item, destination } = move;
      setMove(null);
      void run(item, "reassign", () =>
        decisionsClient.reassignAnswer(item.questionId, destination, item.token)
      );
    },
    confirmHandled: () => {
      if (handling === null) return;
      const item = handling;
      setHandling(null);
      markHandled(item);
    },
    cancelMove: () => setMove(null),
    cancelHandling: () => setHandling(null),
  };
}
