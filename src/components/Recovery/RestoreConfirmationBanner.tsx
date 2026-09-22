import { useRestoreConfirmationStore } from "@/store/restoreConfirmationStore";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { RESTORE_CONFIRMATION_TITLE, getRestoreConfirmationDescription } from "./recoveryCopy";

const AUTO_DISMISS_MS = 10_000;

export function RestoreConfirmationBanner() {
  const visible = useRestoreConfirmationStore((s) => s.visible);
  const suspectCount = useRestoreConfirmationStore((s) => s.suspectCount);
  const dismiss = useRestoreConfirmationStore((s) => s.dismiss);

  if (!visible) return null;

  // A clean recovery is news, not a problem: it says so in the info tier and
  // leaves on its own. Once panels are implicated it is a warning that stands
  // until the user has read it.
  const description = getRestoreConfirmationDescription(suspectCount);
  return (
    <InlineStatusBanner
      title={RESTORE_CONFIRMATION_TITLE}
      description={description}
      severity={description ? "warning" : "info"}
      role="status"
      actions={[]}
      onClose={dismiss}
      closeAriaLabel="Dismiss recovery confirmation"
      autoDismissAfter={description ? undefined : AUTO_DISMISS_MS}
    />
  );
}
