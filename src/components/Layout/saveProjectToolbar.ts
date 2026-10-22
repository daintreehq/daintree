import { notify } from "@/lib/notify";

/**
 * Make one write to this project's toolbar (#13783) from a toolbar surface —
 * the empty-space menu, a button's own menu, the plugin tray. Those close as
 * the click lands, so nothing on screen would otherwise say the change didn't
 * stick; a failure raises a toast that retries the same write.
 */
export function saveProjectToolbar(save: () => Promise<boolean>): void {
  void save().then((saved) => {
    if (saved) return;
    notify({
      type: "error",
      title: "Couldn't save this project's toolbar",
      message: "The change wasn't recorded, so the toolbar is as it was.",
      // `uiFeedback` alone resolves to inbox-only, leaving the Retry unseen.
      priority: "high",
      context: { eventKind: "uiFeedback" },
      action: { label: "Retry", onClick: () => saveProjectToolbar(save) },
    });
  });
}
