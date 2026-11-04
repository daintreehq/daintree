import type { WebContents } from "electron";
import { CHANNELS } from "../ipc/channels.js";
import type { MainProcessToastPayload } from "../../shared/types/ipc/maps.js";

/**
 * Toast copy for a renderer that died and was reloaded. A `killed` renderer
 * Daintree didn't terminate itself was signalled from outside (a stray
 * `pkill`), so calling it a crash would point users and bug reports at
 * Daintree for something it didn't do.
 */
export function rendererReloadNotice(
  subject: string,
  reason: string,
  intent: string | null = null
): string {
  if (reason === "killed") {
    return intent
      ? `${subject} was restarted.`
      : `${subject} was stopped from outside Daintree and was reloaded.`;
  }
  return `${subject} crashed and was automatically reloaded.`;
}

interface HeldNotice {
  payload: MainProcessToastPayload;
  forget: () => void;
}

// A renderer that died can't be sent the notice explaining its reload, and the
// page that replaces it has no toast listener until it reports first-interactive.
// So the notice waits, keyed by the WebContents that reloads (its id survives
// the reload), for that view's own report. A second death before then replaces
// the first notice rather than stacking another.
const heldNotices = new Map<number, HeldNotice>();

export function holdReloadNotice(
  wc: WebContents,
  message: string,
  type: "warning" | "info" = "warning"
): void {
  const id = wc.id;
  heldNotices.get(id)?.forget();
  const onDestroyed = () => heldNotices.delete(id);
  wc.once("destroyed", onDestroyed);
  heldNotices.set(id, {
    // Urgent: the reloaded page starts a fresh startup quiet period, and a
    // notice about why the view just went blank is pointless once it is late.
    payload: { type, message, urgent: true },
    forget: () => wc.removeListener("destroyed", onDestroyed),
  });
}

/**
 * The view died again before its reload reported in. Whatever recovery is
 * chosen this time holds its own notice, if any; a crash loop that ends on the
 * recovery page must not leave an "automatically reloaded" notice for the next
 * document the view loads.
 */
export function dropReloadNotice(wc: WebContents): void {
  heldNotices.get(wc.id)?.forget();
  heldNotices.delete(wc.id);
}

/** The view reported first-interactive: show it the notice held for its reload. */
export function releaseReloadNotice(wc: WebContents): void {
  const held = heldNotices.get(wc.id);
  if (!held || wc.isDestroyed()) return;
  try {
    wc.send(CHANNELS.NOTIFICATION_SHOW_TOAST, held.payload);
  } catch {
    // Torn down mid-send; `destroyed` drops the entry.
    return;
  }
  held.forget();
  heldNotices.delete(wc.id);
}

/** Test-only: a fresh session. */
export function resetReloadNoticesForTest(): void {
  for (const held of heldNotices.values()) held.forget();
  heldNotices.clear();
}
