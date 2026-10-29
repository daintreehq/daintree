import { terminalClient } from "@/clients";
import { logWarn } from "@/utils/logger";

/**
 * Submits a pane's composer text and says whether the terminal accepted it,
 * which is when a terminal-first user gets the keyboard back (#14692). submit
 * rejects when the PTY is gone (#8706), input is blocked, or main refuses an
 * attachment: the composer then keeps the draft and says it wasn't sent
 * (#14945), and the reason is logged here.
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
