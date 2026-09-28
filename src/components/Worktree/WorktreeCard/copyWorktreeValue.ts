import { notify } from "@/lib/notify";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies one of the card's plain-text values (its path, its branch name) and
 * confirms it with a toast, since the menu row that triggered it has already
 * closed. Mirrors the project pill's Copy path: the toast's own live region
 * speaks, and only a copy whose toast was held back (window unfocused, quiet
 * hours) is announced here instead.
 */
export function copyWorktreeValue(label: "Path" | "Branch name", value: string): void {
  const noun = label.toLowerCase();
  // Retry re-enters the whole gesture, so a write that only succeeds on the
  // second attempt still confirms.
  const attempt = () => {
    void writeClipboard(value).then((copied) => {
      if (copied) {
        const toastId = notify({
          type: "info",
          title: `${label} copied`,
          message: value,
          transient: true,
        });
        if (!toastId) useAnnouncerStore.getState().announce(`${label} copied`, "polite");
        return;
      }
      // A silent failure leaves the previous clipboard contents in place, and
      // the user's next paste would be the wrong value.
      const failureTitle = `Couldn't copy ${noun}`;
      const failureToastId = notify({
        type: "error",
        title: failureTitle,
        message: "The clipboard rejected the write.",
        // uiFeedback is passive and would resolve to "low", which is inbox-only
        // and strips the Retry this toast exists for.
        priority: "high",
        context: { eventKind: "uiFeedback" },
        action: { label: "Retry", onClick: attempt },
        // Keyed by value: coalescing swaps in the latest Retry, so two cards
        // failing inside one window would otherwise share a toast whose Retry
        // copies whichever value came last.
        coalesce: {
          key: `copy-${noun.replace(/ /g, "-")}-failed:${value}`,
          buildMessage: () => "The clipboard rejected the write.",
        },
      });
      if (!failureToastId) useAnnouncerStore.getState().announce(failureTitle, "assertive");
    });
  };
  attempt();
}
