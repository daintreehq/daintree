import { useCallback, useEffect, useRef, useState } from "react";
import type { GlobalAssistantView } from "@shared/types/ipc/help";
import { logWarn } from "@/utils/logger";

export interface GlobalAssistantHandle {
  /** The global assistant as main last told this view; null until it has. */
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
  /** End the run the person confirmed and forget its conversation. */
  discard: (generation: number) => Promise<boolean>;
}

function messageOf(error: unknown, fallback: string): string {
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
 */
export function useGlobalAssistant(
  active: boolean,
  canType: (view: GlobalAssistantView | null) => boolean = () => true
): GlobalAssistantHandle {
  const [view, setView] = useState<GlobalAssistantView | null>(null);
  const [attachmentId, setAttachmentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const eligible = canType(view);
  // Read by the attach below without re-attaching when it changes; kept
  // current ahead of it, since effects run in the order they are declared.
  const canTypeRef = useRef(canType);
  useEffect(() => {
    canTypeRef.current = canType;
  }, [canType]);
  /** What main was last told of an attachment's eligibility. */
  const reportedRef = useRef<{ attachmentId: string; eligible: boolean } | null>(null);

  useEffect(() => {
    if (!active) return;
    const help = window.electron.help;
    let disposed = false;
    let attached: string | null = null;
    const asked = canTypeRef.current(null);
    // Subscribed before attaching: the attach answer is newer than any change
    // sent before it, and every change after it arrives here.
    const off = help.onGlobalAssistantChanged((state) => {
      if (!disposed) setView(state);
    });
    help.attachGlobalAssistant(asked).then(
      (attachment) => {
        if (disposed) {
          // Torn down while attaching: the reader is let go at once, not leaked.
          void help.detachGlobalAssistant(attachment.attachmentId).catch(() => {});
          return;
        }
        attached = attachment.attachmentId;
        reportedRef.current = { attachmentId: attachment.attachmentId, eligible: asked };
        setAttachmentId(attachment.attachmentId);
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
        void help.detachGlobalAssistant(attached).catch(() => {});
      }
      setAttachmentId(null);
    };
  }, [active]);

  // A change while the attach was on its way is told once it has answered;
  // an attachment being let go in this same commit is told nothing.
  useEffect(() => {
    if (!active || attachmentId === null) return;
    const reported = reportedRef.current;
    if (reported?.attachmentId === attachmentId && reported.eligible === eligible) return;
    reportedRef.current = { attachmentId, eligible };
    let current = true;
    window.electron.help
      .setGlobalAssistantInputEligible(attachmentId, eligible)
      .catch((err: unknown) => {
        if (current) logWarn("[GlobalAssistant] input eligibility update failed", { error: err });
      });
    return () => {
      current = false;
    };
  }, [active, attachmentId, eligible]);

  const run = useCallback(
    async (action: () => Promise<GlobalAssistantView>, fallback: string): Promise<boolean> => {
      setError(null);
      try {
        setView(await action());
        return true;
      } catch (err) {
        logWarn("[GlobalAssistant] action failed", { error: err });
        setError(messageOf(err, fallback));
        return false;
      }
    },
    []
  );

  const start = useCallback(
    () =>
      run(() => window.electron.help.ensureGlobalAssistant(), "The global assistant didn't start."),
    [run]
  );

  const claimInput = useCallback(async () => {
    if (attachmentId === null) return false;
    return run(
      () => window.electron.help.claimGlobalAssistantInput(attachmentId),
      "Daintree couldn't take the global assistant's input."
    );
  }, [attachmentId, run]);

  const restart = useCallback(
    (generation: number) =>
      run(
        () => window.electron.help.restartGlobalAssistant(generation),
        "The global assistant didn't restart."
      ),
    [run]
  );

  const discard = useCallback(
    (generation: number) =>
      run(
        () => window.electron.help.discardGlobalAssistant(generation),
        "Daintree couldn't end the global assistant."
      ),
    [run]
  );

  const clearError = useCallback(() => setError(null), []);

  return { view, attachmentId, error, clearError, start, claimInput, restart, discard };
}
