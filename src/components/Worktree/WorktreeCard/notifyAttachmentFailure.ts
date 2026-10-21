import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";

const FAILURE_TITLE: Record<"attach" | "detach" | "status", string> = {
  attach: "Attach failed",
  detach: "Detach failed",
  status: "Status check failed",
};

/** The toast for an attachment command the user asked for that failed or was refused. */
export function notifyAttachmentFailure(
  err: unknown,
  name: string,
  action: "attach" | "detach" | "status",
  worktreeId: string
): void {
  const message = formatErrorMessage(err, "The command failed.");
  // eslint-disable-next-line no-restricted-syntax -- notify-event-kind: ok
  notify({
    type: "error",
    priority: "high",
    title: FAILURE_TITLE[action],
    message: `${name}: ${message}`,
    context: { worktreeId },
    action: {
      label: "Copy details",
      successLabel: "Copied",
      // A failed clipboard write is non-critical.
      onClick: () => navigator.clipboard.writeText(message).catch(() => {}),
    },
  });
}
