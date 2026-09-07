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
