import { terminalClient } from "@/clients";
import { logWarn } from "@/utils/logger";

/**
 * Submits a pane's composer text and says whether the terminal accepted it,
 * which is when a terminal-first user gets the keyboard back (#14692). submit
 * rejects when the PTY is gone (#8706); the single-pane path has no recovery
 * UI for that, so it is logged. Banners/agent-state surface the dead pane.
 */
export function submitComposerText(
  id: string,
  text: string,
  imagePaths: string[] | undefined
): Promise<boolean> {
  const submission =
    imagePaths !== undefined && imagePaths.length > 0
      ? terminalClient.submitWithImages(id, text, imagePaths)
      : terminalClient.submit(id, text);
  return submission.then(
    () => true,
    (err: unknown) => {
      logWarn("[TerminalPane] submit failed", { id, error: err });
      return false;
    }
  );
}
