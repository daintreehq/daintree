import type { SystemOpenInEditorFallback } from "@shared/types/ipc/system";
import { notify } from "@/lib/notify";

const EDITOR_SETTINGS_TARGET = { tab: "integrations", sectionId: "editor-external" } as const;

/**
 * Main answers with a fallback when the click did something other than open an
 * editor. The notice is the only way the person learns that, so every caller
 * passes the result through here.
 *
 * - `copied-host-path`: in a window attached to a remote host, no editor on this
 *   machine can open the host's file, so its path went to the clipboard. The
 *   notice names the host.
 * - `needs-terminal`: the chosen editor only runs in a terminal, so nothing was
 *   launched. The notice says how to run it through a terminal app instead.
 */
export function announceOpenInEditorFallback(result: SystemOpenInEditorFallback | void): void {
  if (!result) return;
  if (result.outcome === "copied-host-path") {
    notify({
      type: "info",
      title: "Host path copied",
      message: `No editor on this computer can open files on ${result.hostName}. The file's path there is on your clipboard.`,
      priority: "high",
      duration: 6000,
      transient: true,
      context: { eventKind: "uiFeedback" },
    });
    return;
  }
  notify({
    type: "warning",
    title: `Couldn't open ${result.editorName}`,
    message: `${result.editorName} runs in a terminal, so Daintree can't open it directly. In editor settings, choose Custom… with your terminal app as the command, like kitty, and "${result.command} {file}" as the arguments.`,
    priority: "high",
    context: { eventKind: "uiFeedback" },
    action: {
      label: "Open settings",
      // The inbox keeps an action's id and args, never its callback.
      actionId: "app.settings.openTab",
      actionArgs: EDITOR_SETTINGS_TARGET,
      onClick: () => {
        // Lazy: ActionService loads the action definitions, which import the
        // system client that imports this module.
        void import("@/services/ActionService").then(({ actionService }) =>
          actionService.dispatch("app.settings.openTab", EDITOR_SETTINGS_TARGET, {
            source: "user",
          })
        );
      },
    },
  });
}
