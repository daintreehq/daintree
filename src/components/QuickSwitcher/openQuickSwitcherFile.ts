import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { basename } from "@shared/utils/path";

/**
 * Open a file picked in the quick switcher's file scope (#17329): the read-only
 * viewer through `file.openPanel`, which reuses a panel already showing the
 * file, or with the platform modifier the external editor — the same split as
 * a click and a modified click on a path in terminal output.
 */
export function openQuickSwitcherFile(absolutePath: string, inEditor: boolean): void {
  void actionService
    .dispatch(
      inEditor ? "file.openInEditor" : "file.openPanel",
      { path: absolutePath },
      {
        source: "user",
      }
    )
    .then((result) => {
      if (result.ok) return;
      if (!inEditor) {
        // No toast: the realistic failure is the panel ceiling, and `addPanel`
        // already reports that itself.
        logError("[QuickSwitcher] Failed to open file panel", result.error);
        return;
      }
      logError("[QuickSwitcher] Failed to open file in editor", result.error);
      notify({
        type: "error",
        title: "Couldn't open in editor",
        message: `${result.error.message} (${basename(absolutePath) || absolutePath})`,
        priority: "high",
        context: { eventKind: "uiFeedback" },
        action: { label: "Retry", onClick: () => openQuickSwitcherFile(absolutePath, true) },
      });
    })
    .catch((error) => logError("[QuickSwitcher] Failed to open file", error));
}
