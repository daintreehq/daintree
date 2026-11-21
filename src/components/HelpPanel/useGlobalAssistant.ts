import { useCallback, useEffect, useRef, useState } from "react";
import {
  GLOBAL_ASSISTANT_SLOT,
  type GlobalAssistantSlot,
} from "@shared/config/globalAssistantSessions";
import type { GlobalAssistantView } from "@shared/types/ipc/help";
import { clientErrorCode, isClientAppError } from "@/utils/clientAppError";
import { logWarn } from "@/utils/logger";

export interface GlobalAssistantHandle {
  /** The session as main last told this view; null until it has. */
  view: GlobalAssistantView | null;
  /** This view's reader on it while the pane is shown; null otherwise. */
  attachmentId: string | null;
  /** Why the last attach or explicit action failed, in words; null when it didn't. */
  error: string | null;
  clearError: () => void;
  /** Start the global run, or resume the conversation it last left. Only ever on a click. */
  start: () => Promise<boolean>;
  /** Take its input for this view, explicitly. True once main has handed it over. */
  claimInput: () => Promise<boolean>;
  /** End the run the person confirmed and start a new conversation. */
  restart: (generation: number) => Promise<boolean>;
  /**
   * End the session the person confirmed and forget its conversation.
   * `running` is whether it ran when they were asked.
   */
  discard: (generation: number, running?: boolean) => Promise<boolean>;
  /** Stop the launch the person watched start; the conversation it was picking up is kept. */
  cancelLaunch: (generation: number) => Promise<boolean>;
  /**
   * Start a new session on the agent the person chose (#18142), in the first
   * the machine has free. `onClaimed` hears which, before its launch is joined.
   */
  startNew: (agentId: string, onClaimed: (slot: GlobalAssistantSlot) => void) => Promise<boolean>;
  /** Hand coordination to the session at `to`, as the person asked (#18143). */
  handCoordination: (to: GlobalAssistantSlot) => Promise<boolean>;
}

/**
 * This view's own attachments, oldest first: input one of them holds is still
 * this window's, wherever in it the person now types.
 */
const viewAttachments = new Set<string>();

/** Whether the attachment is one of this view's own. */
export function isViewGlobalAttachment(attachmentId: string | null): boolean {
  return attachmentId !== null && viewAttachments.has(attachmentId);
}

/** The exact run a view shows: its lifecycle, terminal and PTY launch. Null while none runs. */
function runOf(view: GlobalAssistantView | null): string | null {
  if (view?.phase !== "running" || !view.subject) return null;
  return `${view.generation}:${view.subject.terminalId}:${view.subject.incarnation}`;
}

function messageOf(error: unknown, fallback: string): string {
  // A refusal from main arrives packed into its message; decoding it puts its words back.
  if (isClientAppError(error) && error.userMessage) return error.userMessage;
  if (
    typeof error === "object" &&
    error !== null &&
    "userMessage" in error &&
    typeof error.userMessage === "string" &&
    error.userMessage
  ) {
    return error.userMessage;
  }
  return fallback;
}

/**
 * This view's attachment to the installation's global assistant (#14454),
 * held only while `active`: the pane is shown in a visible panel of a live
 * view. Attaching reads; nothing here starts a run except `start`, which only
 * a person's click calls. Dropping the attachment — a project tab, a hidden
 * panel, a cached view, an unmount — leaves the run alive.
 *
 * `canType` says whether the pane, showing `view`, could type to the run.
 * Main is told on attach and at every change, so input nobody holds is only
 * ever handed to a view that can use it (#16098). An attach asks as for a
 * view not seen yet (`null`): what was shown before it may since have changed.
 *
 * `slot` names the session (#18142). Everything here is that session's: a
 * change of it lets go of the last one and attaches to the new one, and what
 * was heard of the last one is never shown as the new one's.
 */
export function useGlobalAssistant(
  active: boolean,
  canType: (view: GlobalAssistantView | null) => boolean = () => true,
  /**
   * Input another surface of this same view holds comes here, and goes back
   * to that surface when this lets go: it moves within the window and never
   * to another. For a surface shown over the one that holds it (Canopy over
   * the Assistant panel), whose holder can't type meanwhile. Main moves it
   * only while the surface it moves from still holds it, so a window that
   * took it meanwhile keeps it.
   */
  keepsViewInput = false,
  slot: GlobalAssistantSlot = GLOBAL_ASSISTANT_SLOT
): GlobalAssistantHandle {
  // Each session's last state, kept apart: a late answer about one never
  // stands in for the other's.
  const [heard, setViewState] = useState<Readonly<Record<number, GlobalAssistantView>>>({});
  // The run last heard of, kept as each state arrives rather than once it
  // renders: a teardown in the same commit as the news must already know it.
  const runRef = useRef<Record<number, string | null>>({});
  const setView = useCallback((next: GlobalAssistantView) => {
    runRef.current = { ...runRef.current, [next.slot]: runOf(next) };
    setViewState((current) => ({ ...current, [next.slot]: next }));
  }, []);
  // Read at the moment of asking: a teardown wants the latest, not the one it closed over.
  const lastRunOf = useCallback((at: number) => runRef.current[at] ?? null, []);
  const view = heard[slot] ?? null;
  const [attached, setAttachmentId] = useState<{ slot: number; id: string } | null>(null);
  const attachmentId = attached?.slot === slot ? attached.id : null;
  const [failed, setFailed] = useState<{ slot: number; message: string } | null>(null);
  const error = failed?.slot === slot ? failed.message : null;
  const setError = useCallback(
    (message: string | null, at: number = slot) =>
      setFailed(message === null ? null : { slot: at, message }),
    [slot]
  );
  const eligible = canType(view);
  // Read by the attach below without re-attaching when it changes; kept
  // current ahead of it, since effects run in the order they are declared.
  const canTypeRef = useRef(canType);
  useEffect(() => {
    canTypeRef.current = canType;
  }, [canType]);
  /** What main was last told of an attachment's eligibility. */
  const reportedRef = useRef<{ attachmentId: string; eligible: boolean } | null>(null);
  // The surface of this view input was taken from, and the exact run it was
  // taken for, to go back to on teardown: a loan for a run since replaced,
  // or respawned, is over.
  const lenderRef = useRef<{ attachmentId: string; run: string } | null>(null);

  useEffect(() => {
    if (!active) return;
    const help = window.electron.help;
    let disposed = false;
    let attached: string | null = null;
    const asked = canTypeRef.current(null);
    lenderRef.current = null;
    // Subscribed before attaching: the attach answer is newer than any change
    // sent before it, and every change after it arrives here.
    // Every session's news is kept, each apart, so none is stale once shown.
    const off = help.onGlobalAssistantChanged((state) => {
      if (!disposed) setView(state);
    });
    help.attachGlobalAssistant(asked, slot).then(
      (attachment) => {
        if (disposed) {
          // Torn down while attaching: the reader is let go at once, not leaked.
          void help.detachGlobalAssistant(attachment.attachmentId, slot).catch(() => {});
          return;
        }
        attached = attachment.attachmentId;
        viewAttachments.add(attachment.attachmentId);
        reportedRef.current = { attachmentId: attachment.attachmentId, eligible: asked };
        setAttachmentId({ slot, id: attachment.attachmentId });
        setView(attachment.state);
      },
      (err: unknown) => {
        if (disposed) return;
        logWarn("[GlobalAssistant] attach failed", { error: err });
        setError(messageOf(err, "Daintree couldn't show the global assistant."));
      }
    );
    return () => {
      disposed = true;
      off();
      if (attached !== null) {
        viewAttachments.delete(attached);
        // Handed back before letting go, so main has no vacancy to fill from
        // another window. Sent even with a take still unanswered: main moves
        // it only if this one holds it by then.
        const lender = keepsViewInput ? lenderRef.current : null;
        if (
          lender !== null &&
          lender.run === lastRunOf(slot) &&
          viewAttachments.has(lender.attachmentId)
        ) {
          void help.claimGlobalAssistantInput(lender.attachmentId, attached, slot).catch(() => {});
        }
        void help.detachGlobalAssistant(attached, slot).catch(() => {});
      }
      setAttachmentId(null);
    };
  }, [active, keepsViewInput, setView, slot, setError, lastRunOf]);

  // A change while the attach was on its way is told once it has answered;
  // an attachment being let go in this same commit is told nothing.
  useEffect(() => {
    if (!active || attachmentId === null) return;
    const reported = reportedRef.current;
    if (reported?.attachmentId === attachmentId && reported.eligible === eligible) return;
    reportedRef.current = { attachmentId, eligible };
    let current = true;
    window.electron.help
      .setGlobalAssistantInputEligible(attachmentId, eligible, slot)
      .catch((err: unknown) => {
        if (current) logWarn("[GlobalAssistant] input eligibility update failed", { error: err });
      });
    return () => {
      current = false;
    };
  }, [active, attachmentId, eligible, slot]);

  const run = useCallback(
    async (action: () => Promise<GlobalAssistantView>, fallback: string): Promise<boolean> => {
      setError(null);
      try {
        setView(await action());
        return true;
      } catch (err) {
        // Stopped while starting, by a person here or in another window, or by
        // quitting: nothing went wrong, and the state main sends says so.
        if (clientErrorCode(err) === "CANCELLED") return false;
        logWarn("[GlobalAssistant] action failed", { error: err });
        setError(messageOf(err, fallback));
        return false;
      }
    },
    [setView, setError]
  );

  const start = useCallback(
    () =>
      run(
        () => window.electron.help.ensureGlobalAssistant(slot),
        "The global assistant didn't start."
      ),
    [run, slot]
  );

  const claimInput = useCallback(async () => {
    if (attachmentId === null) return false;
    return run(
      () => window.electron.help.claimGlobalAssistantInput(attachmentId, undefined, slot),
      "Daintree couldn't take the global assistant's input."
    );
  }, [attachmentId, run, slot]);

  const restart = useCallback(
    (generation: number) =>
      run(
        () => window.electron.help.restartGlobalAssistant(generation, slot),
        "Daintree couldn't clear the global assistant's conversation."
      ),
    [run, slot]
  );

  const discard = useCallback(
    (generation: number, running?: boolean) =>
      run(
        () => window.electron.help.discardGlobalAssistant(generation, slot, running),
        "Daintree couldn't end the global assistant."
      ),
    [run, slot]
  );

  const cancelLaunch = useCallback(
    (generation: number) =>
      run(
        () => window.electron.help.cancelGlobalAssistantLaunch(generation, slot),
        "Daintree couldn't stop the global assistant from starting."
      ),
    [run, slot]
  );

  const startNew = useCallback(
    async (agentId: string, onClaimed: (claimed: GlobalAssistantSlot) => void) => {
      setError(null);
      let claimed: GlobalAssistantSlot | null = null;
      try {
        const begun = await window.electron.help.startNewGlobalAssistant(agentId);
        claimed = begun.slot;
        // Known as claimed before it is shown, so nothing older stands in for it.
        setView(begun);
        onClaimed(claimed);
        // Joins the launch the claim began, never another, so a failure is said
        // here as a Start's is.
        await window.electron.help.ensureGlobalAssistant(claimed, begun.generation);
        return true;
      } catch (err) {
        if (clientErrorCode(err) === "CANCELLED") return false;
        logWarn("[GlobalAssistant] new session failed", { error: err });
        setError(messageOf(err, "The new global assistant session didn't start."), claimed ?? slot);
        return false;
      }
    },
    [setError, setView, slot]
  );

  const handCoordination = useCallback(
    (to: GlobalAssistantSlot) =>
      run(async () => {
        const views = await window.electron.help.setGlobalAssistantCoordinator(to);
        const shown = views.find((candidate) => candidate.slot === slot);
        if (!shown) throw new Error("The global assistant session wasn't listed.");
        return shown;
      }, "Daintree couldn't hand coordination over."),
    [run, slot]
  );

  // Held by another surface of this view, it is this window's already: taken
  // without asking, as typing here is all the person can do in it now.
  const inputOwner = view?.inputOwner ?? null;
  const shownRun = runOf(view);
  useEffect(() => {
    if (!keepsViewInput || !active || attachmentId === null || shownRun === null) return;
    if (inputOwner === null || inputOwner === attachmentId) return;
    if (!isViewGlobalAttachment(inputOwner)) return;
    lenderRef.current = { attachmentId: inputOwner, run: shownRun };
    void run(
      () => window.electron.help.claimGlobalAssistantInput(attachmentId, inputOwner, slot),
      "Daintree couldn't take the global assistant's input."
    );
  }, [keepsViewInput, active, attachmentId, inputOwner, shownRun, run, slot]);

  const clearError = useCallback(() => setError(null), [setError]);

  return {
    view,
    attachmentId,
    error,
    clearError,
    start,
    claimInput,
    restart,
    discard,
    cancelLaunch,
    startNew,
    handCoordination,
  };
}
