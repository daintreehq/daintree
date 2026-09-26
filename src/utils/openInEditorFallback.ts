import type { SystemOpenInEditorFallback } from "@shared/types/ipc/system";
import { notify } from "@/lib/notify";

/**
 * In a window attached to a remote host, main copies the host path when no
 * editor on this machine can open the host's file. The notice is the only way
 * the person learns the click did that instead, so it names the host.
 */
export function announceOpenInEditorFallback(result: SystemOpenInEditorFallback | void): void {
  if (!result || result.outcome !== "copied-host-path") return;
  notify({
    type: "info",
    title: "Host path copied",
    message: `No editor on this computer can open files on ${result.hostName}. The file's path there is on your clipboard.`,
    priority: "high",
    duration: 6000,
    transient: true,
    context: { eventKind: "uiFeedback" },
  });
}
