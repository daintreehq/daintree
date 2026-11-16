import { decisionsClient } from "@/clients/decisionsClient";
import { isOtherHostDraftKey } from "@/lib/draftKey";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { DisposableStore, toDisposable } from "@/utils/disposable";

/** How soon a report that failed is sent again. */
export const COMPOSER_DRAFT_RETRY_MS = 5_000;
/**
 * How often a view holding drafts says so again: main forgets a view whose
 * endpoint closed, as a remote view's does when its link reconnects.
 */
export const COMPOSER_DRAFT_REFRESH_MS = 30_000;

/**
 * The draft keys whose text is more than whitespace, in a stable order. A
 * draft for another host's terminal is left out: this view's calls reach its
 * own host, which has no such terminal.
 */
export function draftKeysWithText(drafts: ReadonlyMap<string, string>): string[] {
  const keys: string[] = [];
  for (const [key, value] of drafts) {
    if (holdsText(value) && !isOtherHostDraftKey(key)) keys.push(key);
  }
  return keys.sort();
}

/** Stops at the first character that isn't whitespace, so a long draft costs no more than a short one. */
function holdsText(value: string): boolean {
  return /\S/.test(value);
}

/**
 * Whether `next` can hold text in a different set of drafts than `prev`. A
 * keystroke inside a draft that held text and still does changes nothing, so
 * typing never derives the whole set again.
 */
export function draftsWithTextMayDiffer(
  next: ReadonlyMap<string, string>,
  prev: ReadonlyMap<string, string>
): boolean {
  if (next.size !== prev.size) return true;
  for (const [key, value] of next) {
    const before = prev.get(key);
    if (before === value) continue;
    if (before === undefined || holdsText(before) !== holdsText(value)) return true;
  }
  return false;
}

/**
 * Tell main which terminals this view's hybrid input holds a draft for
 * (#16282), so a Decisions answer waits for the person writing there. Sent
 * whole, once at the start (a reload replaces what the view said before) and
 * again when a draft appears or empties, never per keystroke. A report that
 * failed is sent again, and a view holding drafts repeats them now and then.
 */
export function setupComposerDraftListeners(): DisposableStore {
  const d = new DisposableStore();
  let sent: string | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const report = (force = false) => {
    const keys = draftKeysWithText(useTerminalInputStore.getState().draftInputs);
    const signature = JSON.stringify(keys);
    if (!force && signature === sent) return;
    sent = signature;
    if (retry !== null) clearTimeout(retry);
    retry = null;
    let request: Promise<void>;
    try {
      request = decisionsClient.reportComposerDrafts(keys);
    } catch (error) {
      // A call that throws before it is sent fails like one that was refused.
      request = Promise.reject(error);
    }
    request.catch(() => {
      if (sent !== signature || stopped) return;
      sent = null;
      retry = setTimeout(() => {
        retry = null;
        report();
      }, COMPOSER_DRAFT_RETRY_MS);
    });
  };
  d.add(
    toDisposable(
      useTerminalInputStore.subscribe((next, prev) => {
        if (
          next.draftInputs !== prev.draftInputs &&
          draftsWithTextMayDiffer(next.draftInputs, prev.draftInputs)
        ) {
          report();
        }
      })
    )
  );
  const refresh = setInterval(() => {
    if (sent !== null && sent !== "[]") report(true);
  }, COMPOSER_DRAFT_REFRESH_MS);
  d.add(
    toDisposable(() => {
      stopped = true;
      clearInterval(refresh);
      if (retry !== null) clearTimeout(retry);
    })
  );
  report();
  return d;
}
