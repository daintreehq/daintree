import type { BrowserHistory } from "@shared/types/browser";

export const MAX_BROWSER_HISTORY_ENTRIES = 200;

function trimPast(entries: readonly string[]): string[] {
  if (entries.length <= MAX_BROWSER_HISTORY_ENTRIES) {
    return [...entries];
  }
  return entries.slice(entries.length - MAX_BROWSER_HISTORY_ENTRIES);
}

function trimFuture(entries: readonly string[]): string[] {
  if (entries.length <= MAX_BROWSER_HISTORY_ENTRIES) {
    return [...entries];
  }
  return entries.slice(0, MAX_BROWSER_HISTORY_ENTRIES);
}

function normalizeEntryList(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export function initializeBrowserHistory(
  saved: BrowserHistory | null | undefined,
  fallbackPresent = ""
): BrowserHistory {
  if (
    saved &&
    Array.isArray(saved.past) &&
    Array.isArray(saved.future) &&
    typeof saved.present === "string"
  ) {
    return {
      past: trimPast(normalizeEntryList(saved.past)),
      present: saved.present || fallbackPresent,
      future: trimFuture(normalizeEntryList(saved.future)),
    };
  }

  return {
    past: [],
    present: fallbackPresent,
    future: [],
  };
}

export function pushBrowserHistory(history: BrowserHistory, nextUrl: string): BrowserHistory {
  const normalizedUrl = nextUrl.trim();
  if (!normalizedUrl || normalizedUrl === history.present) {
    return history;
  }

  const nextPast = history.present
    ? trimPast([...normalizeEntryList(history.past), history.present])
    : trimPast(normalizeEntryList(history.past));

  return {
    past: nextPast,
    present: normalizedUrl,
    future: [],
  };
}

/**
 * Retarget the current entry in place, keeping `past` and `future` intact.
 *
 * Distinct from `pushBrowserHistory`: an origin migration is a correction of *where
 * we already are* (the dev-preview pane moving a route onto its stable proxy origin),
 * not a new stop. Pushing one would strand the pre-migration URL in the back stack
 * and drop every forward entry (#12297).
 */
export function replaceBrowserHistoryPresent(
  history: BrowserHistory,
  nextUrl: string
): BrowserHistory {
  const normalizedUrl = nextUrl.trim();
  if (!normalizedUrl || normalizedUrl === history.present) {
    return history;
  }
  return { ...history, present: normalizedUrl };
}

export function goBackBrowserHistory(history: BrowserHistory): BrowserHistory {
  const past = normalizeEntryList(history.past);
  if (past.length === 0) {
    return history;
  }

  const present = history.present;
  const previousUrl = past[past.length - 1]!;
  const nextPast = past.slice(0, -1);
  const nextFuture = present ? trimFuture([present, ...normalizeEntryList(history.future)]) : [];

  return {
    past: nextPast,
    present: previousUrl,
    future: nextFuture,
  };
}

export function goForwardBrowserHistory(history: BrowserHistory): BrowserHistory {
  const future = normalizeEntryList(history.future);
  if (future.length === 0) {
    return history;
  }

  const [nextUrl, ...restFuture] = future;
  const nextPast = history.present
    ? trimPast([...normalizeEntryList(history.past), history.present])
    : trimPast(normalizeEntryList(history.past));

  return {
    past: nextPast,
    present: nextUrl!,
    future: restFuture,
  };
}

/** Moves `offset` entries through the history; a step that runs off either end is refused. */
export function stepBrowserHistory(history: BrowserHistory, offset: number): BrowserHistory {
  if (!Number.isInteger(offset) || offset === 0) return history;
  const past = normalizeEntryList(history.past);
  const future = normalizeEntryList(history.future);
  const entries = [...past, history.present, ...future];
  const target = past.length + offset;
  if (target < 0 || target >= entries.length) return history;
  return {
    past: trimPast(entries.slice(0, target)),
    present: entries[target]!,
    future: trimFuture(entries.slice(target + 1)),
  };
}

function entryAtOffset(history: BrowserHistory, offset: number): string | undefined {
  if (offset < 0) return history.past[history.past.length + offset];
  if (offset > 0) return history.future[offset - 1];
  return history.present;
}

export interface GuestCommit {
  /**
   * The step the host asked the guest to take (Back, Forward, a history-menu
   * jump). Trusted only while the entry it lands on is the committed URL.
   */
  offset?: number | null;
  /**
   * The guest still has entries ahead of the one it committed. A fresh entry
   * always drops them, so this commit moved through the guest's own history.
   */
  traversed: boolean;
}

/**
 * Follows a live guest to `url`, the entry it just committed, so the history
 * keeps mirroring the guest's own session history: a step through it moves
 * the history, and only a fresh entry pushes one. A guest traversal the host
 * didn't ask for lands on the nearest matching entry, a step back winning a tie.
 */
export function followGuestCommit(
  history: BrowserHistory,
  url: string,
  { offset, traversed }: GuestCommit
): BrowserHistory {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) return history;

  // Ahead of the same-URL check: a jump between two entries for one URL moves
  // the guest all the same.
  if (offset && entryAtOffset(history, offset) === normalizedUrl) {
    return stepBrowserHistory(history, offset);
  }
  if (normalizedUrl === history.present) return history;

  if (traversed) {
    const reach = Math.max(history.past.length, history.future.length);
    for (let distance = 1; distance <= reach; distance++) {
      if (entryAtOffset(history, -distance) === normalizedUrl) {
        return stepBrowserHistory(history, -distance);
      }
      if (entryAtOffset(history, distance) === normalizedUrl) {
        return stepBrowserHistory(history, distance);
      }
    }
    return pushBrowserHistory(history, normalizedUrl);
  }

  // Nothing is left ahead of the guest, so landing on the last entry ahead is a
  // step forward to the end of its history (`history.go(n)`). Pushing would drop
  // the entries it stepped over; for a single step the two agree anyway.
  if (history.future.length > 0 && history.future[history.future.length - 1] === normalizedUrl) {
    return stepBrowserHistory(history, history.future.length);
  }

  return pushBrowserHistory(history, normalizedUrl);
}
