import { useCallback, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";

type ClearLogsConfirmDialogProps = {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
};

/**
 * The D1 gate for `logs.clear`, shared by its two dispatch sites (Troubleshooting
 * settings and the Diagnostics dock) so both entry points confirm identically.
 * Owns the dispatch as well as the dialog: the confirm-wiring guard only counts
 * an action as wired when a ConfirmDialog and the dispatch live in one file.
 */
export function ClearLogsConfirmDialog({ isOpen, onOpenChange }: ClearLogsConfirmDialogProps) {
  const [isClearing, setIsClearing] = useState(false);

  const handleConfirm = useCallback(async () => {
    setIsClearing(true);
    try {
      const result = await actionService.dispatch("logs.clear", undefined, { source: "user" });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    } catch (error) {
      logError("Failed to clear logs", error);
      notify({
        type: "error",
        title: "Couldn't clear logs",
        message: "Your logs are unchanged. The log service may be busy — try again in a moment.",
        // Explicit priority is load-bearing: uiFeedback is a passive policy, and
        // letting it resolve would demote this to "low" — inbox-only, with the
        // onClick recovery stripped (only actionId actions survive the inbox).
        priority: "high",
        // Reopens the confirmation rather than re-dispatching: a toast that fires
        // a destructive action on click would bypass this gate.
        actions: [{ label: "Try again", variant: "primary", onClick: () => onOpenChange(true) }],
        context: { eventKind: "uiFeedback" },
      });
    } finally {
      setIsClearing(false);
      onOpenChange(false);
    }
  }, [onOpenChange]);

  return (
    <ConfirmDialog
      isOpen={isOpen}
      onClose={() => onOpenChange(false)}
      title="Clear logs?"
      description="Empties the log view and the in-memory buffer that diagnostic reports are built from. Doesn't delete the log file on disk."
      confirmLabel="Clear logs"
      variant="destructive"
      isConfirmLoading={isClearing}
      onConfirm={handleConfirm}
    />
  );
}
