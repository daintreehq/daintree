import { notify } from "@/lib/notify";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

/**
 * Copies a workspace path and confirms it with a toast. Shared by every "Copy
 * path" row that closes its menu on select, since nothing on screen is left to
 * show the result. `copy` is `useCopyWithFeedback`'s with its announcement off:
 * the toast's own live region speaks, and only a copy whose toast was held back
 * (window unfocused, quiet hours) is announced here instead.
 */
export function copyPathWithFeedback(copy: (text: string) => Promise<boolean>, path: string): void {
  // Retry re-enters the whole gesture, so a write that only succeeds on the
  // second attempt still confirms.
  const attempt = () => {
    void copy(path).then((copied) => {
      if (copied) {
        const toastId = notify({
          type: "info",
          title: "Path copied",
          message: path,
          transient: true,
        });
        if (!toastId) useAnnouncerStore.getState().announce("Path copied", "polite");
        return;
      }
      // A silent failure leaves the previous clipboard contents in place, and
      // the user's next paste would be the wrong value.
      notify({
        type: "error",
        title: "Couldn't copy path",
        message: "The clipboard rejected the write.",
        // uiFeedback is passive and would resolve to "low", which is inbox-only
        // and strips the Retry this toast exists for.
        priority: "high",
        context: { eventKind: "uiFeedback" },
        action: { label: "Retry", onClick: attempt },
        // Coalesced toasts skip the shared per-type rate limit, so unrelated
        // errors can't turn a failed retry into an inbox row with no Retry.
        coalesce: {
          key: "copy-path-failed",
          buildMessage: () => "The clipboard rejected the write.",
        },
      });
    });
  };
  attempt();
}
