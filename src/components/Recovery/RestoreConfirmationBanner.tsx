import { AlertTriangle } from "lucide-react";
import { useRestoreConfirmationStore } from "@/store/restoreConfirmationStore";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { getRestoreConfirmationTitle } from "./recoveryCopy";

const AUTO_DISMISS_MS = 10_000;

export function RestoreConfirmationBanner() {
  const visible = useRestoreConfirmationStore((s) => s.visible);
  const suspectCount = useRestoreConfirmationStore((s) => s.suspectCount);
  const dismiss = useRestoreConfirmationStore((s) => s.dismiss);

  if (!visible) return null;

  return (
    <InlineStatusBanner
      icon={AlertTriangle}
      title={getRestoreConfirmationTitle(suspectCount)}
      severity="warning"
      role="status"
      actions={[]}
      onClose={dismiss}
      closeAriaLabel="Dismiss recovery confirmation"
      autoDismissAfter={suspectCount > 0 ? undefined : AUTO_DISMISS_MS}
    />
  );
}
