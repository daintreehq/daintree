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

export function goBackBrowserHistory(history: BrowserHistory): BrowserHistory {
  const past = normalizeEntryList(history.past);
  if (past.length === 0) {
    return history;
  }

  const present = history.present;
  const previousUrl = past[past.length - 1];
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
    present: nextUrl,
    future: restFuture,
  };
}
