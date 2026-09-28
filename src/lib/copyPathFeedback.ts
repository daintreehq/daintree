import { notify } from "@/lib/notify";

/**
 * Copies a workspace path and confirms it with a toast. Shared by every "Copy
 * path" row that closes its menu on select, since nothing on screen is left to
 * show the result. `copy` is `useCopyWithFeedback`'s, so the announcement still
 * comes from the hook.
 */
export function copyPathWithFeedback(copy: (text: string) => Promise<boolean>, path: string): void {
  // Retry re-enters the whole gesture, so a write that only succeeds on the
  // second attempt still confirms.
  const attempt = () => {
    void copy(path).then((copied) => {
      if (copied) {
        notify({ type: "info", title: "Path copied", message: path, transient: true });
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
      });
    });
  };
  attempt();
}
