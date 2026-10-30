import { claudeClient } from "@/clients/claudeClient";
import { captureCopyFlash } from "@/lib/copyFlash";
import { copyWithToast } from "@/lib/copyWithToast";
import { remoteHostOfView } from "@/services/terminal/remoteLoopbackLinks";
import {
  REPLY_SPAN_SELECTION_MAX_CHARS,
  REPLY_SPAN_WAIT_MS,
} from "@shared/config/replySpanLimits";

// The latest clean copy asked for. One still waiting on the host when another
// is asked for writes nothing.
let latest = 0;

/**
 * Copies a selection cleaned: the text rebuilt from the screen, or for a
 * Claude Code pane on this machine the stretch of a recent reply it shows, as
 * the agent wrote it (#15527).
 *
 * `selection` and `cleaned` are read before anything is awaited, so what is
 * copied is what was selected when the copy was asked for, whatever the pane
 * does meanwhile. The clipboard is written once either way: with the reply's
 * text when the host finds it within the wait, otherwise with `cleaned`, and
 * nothing tells the two apart but the text. `claudeTerminalId` is null for any
 * other pane, which copies `cleaned` straight away.
 */
export function copyCleanSelection(
  selection: string,
  cleaned: string,
  claudeTerminalId: string | null
): void {
  const gesture = ++latest;
  if (!cleaned) return;
  if (
    claudeTerminalId === null ||
    remoteHostOfView() !== null ||
    selection.length > REPLY_SPAN_SELECTION_MAX_CHARS
  ) {
    copyWithToast("Selection", cleaned);
    return;
  }
  const flash = captureCopyFlash();
  let settled = false;
  const settle = (span: string | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (gesture !== latest) return;
    const text = span && selection.includes("\r\n") ? span.replace(/\n/g, "\r\n") : span;
    copyWithToast("Selection", text || cleaned, { flash });
  };
  const timer = setTimeout(() => settle(null), REPLY_SPAN_WAIT_MS);
  void Promise.resolve()
    .then(() => claudeClient.findReplySpan({ terminalId: claudeTerminalId, selection }))
    .then(settle, () => settle(null));
}
