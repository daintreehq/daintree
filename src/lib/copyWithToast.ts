import { notify } from "@/lib/notify";
import { captureCopyFlash, showCopyFlash, type CopyFlashTicket } from "@/lib/copyFlash";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface CopyWithToastOptions {
  /**
   * Where the gesture started, for a caller that does async work (a file read)
   * between the select and the copy: by then the menu has closed and the view
   * may have been switched away and back. Applies to the first attempt only;
   * a Retry is its own gesture.
   */
  flash?: CopyFlashTicket;
  /** The clipboard write. Defaults to `navigator.clipboard.writeText`. */
  write?: (text: string) => Promise<boolean>;
}

/**
 * What keys a failure toast: the value itself, or for a payload too large to
 * sit in a key (a file's contents) its length plus a digest. Length and digest
 * together still separate any two payloads a user copies within one window.
 */
function coalesceId(text: string): string {
  if (text.length <= 512) return text;
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/** "Path" → "path", "File name" → "file name", "URL" stays "URL". */
function lowerNoun(label: string): string {
  return /^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * The copy gesture for a menu row. The row closes on select, so nothing on
 * screen is left to show the result. Success is an acknowledgement, not a
 * notification: a brief "Copied" flash beside where the copy was asked for,
 * plus one polite announcement naming what was copied ("Path copied") that
 * does not depend on the flash being drawn. A refused write is an error toast
 * whose Retry re-runs the whole gesture, because a silent failure leaves the
 * old clipboard contents for the next paste.
 *
 * `label` is the capitalised noun ("Path", "Branch name", "URL"): it names the
 * announcement and titles the failure toast, "Couldn't copy path".
 */
export function copyWithToast(label: string, value: string, options: CopyWithToastOptions = {}) {
  const { write = writeClipboard } = options;
  let initialFlash = options.flash;
  const noun = lowerNoun(label);
  const successTitle = `${label} copied`;
  const failureTitle = `Couldn't copy ${noun}`;
  // Retry re-enters the whole gesture, so a write that only succeeds on the
  // second attempt still confirms.
  const attempt = () => {
    // Where the user is acting, read before the menu's close moves focus.
    const flash = initialFlash ?? captureCopyFlash();
    initialFlash = undefined;
    // Started synchronously, inside the gesture that asked for it. A caller's
    // write that throws or rejects is a refusal like any other.
    let written: Promise<boolean>;
    try {
      written = Promise.resolve(write(value)).catch(() => false);
    } catch {
      written = Promise.resolve(false);
    }
    void written.then((copied) => {
      if (copied) {
        useAnnouncerStore.getState().announce(successTitle, "polite");
        showCopyFlash(flash);
        return;
      }
      // A silent failure leaves the previous clipboard contents in place, and
      // the user's next paste would be the wrong value.
      const failureToastId = notify({
        type: "error",
        title: failureTitle,
        message: "The clipboard rejected the write.",
        // uiFeedback is passive and would resolve to "low", which is inbox-only
        // and strips the Retry this toast exists for.
        priority: "high",
        context: { eventKind: "uiFeedback" },
        action: { label: "Retry", onClick: attempt },
        // Keyed by the value itself: coalescing swaps in the latest Retry, so two rows
        // failing inside one window would otherwise share a toast whose Retry
        // copies whichever value came last. Coalesced toasts also skip the
        // shared per-type rate limit, so unrelated errors can't turn a failed
        // retry into an inbox row with no Retry.
        coalesce: {
          key: `copy-${noun.toLowerCase().replace(/ /g, "-")}-failed:${coalesceId(value)}`,
          buildMessage: () => "The clipboard rejected the write.",
        },
      });
      if (!failureToastId) useAnnouncerStore.getState().announce(failureTitle, "assertive");
    });
  };
  attempt();
}
