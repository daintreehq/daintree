import { hostScopedKey } from "@/hooks/useHostPlatform";
import { createSafeStringStorage, type SafeStringStorage } from "@/store/persistence/safeStorage";
import { logError, logWarn } from "@/utils/logger";
import { QUICK_RUN_HISTORY_KEY_PREFIX } from "./quickRunStorageKeys";

export interface HistoryItem {
  command: string;
  timestamp: number;
}

const MAX_HISTORY = 10;

/**
 * Normalize a command string for comparison.
 * Removes quotes around tokens that don't contain spaces.
 * e.g., `npm run "test"` -> `npm run test`
 * but keeps `npm run "test with spaces"` as is.
 */
export function normalizeCommand(cmd: string): string {
  return cmd
    .trim()
    .replace(/\s+/g, " ")
    .replace(/"([^"\s]+)"/g, "$1")
    .replace(/'([^'\s]+)'/g, "$1");
}

export function historyStorageKey(projectId: string): string {
  return `${QUICK_RUN_HISTORY_KEY_PREFIX}${hostScopedKey(projectId)}`;
}

/** The list with `command` first. A command that differs only by quoting replaces its earlier entry. */
export function appendHistory(
  previous: readonly HistoryItem[],
  command: string,
  timestamp: number
): HistoryItem[] {
  const normalized = normalizeCommand(command);
  return [
    { command, timestamp },
    ...previous.filter((item) => normalizeCommand(item.command) !== normalized),
  ].slice(0, MAX_HISTORY);
}

function isHistoryItem(item: unknown): item is HistoryItem {
  if (item === null || typeof item !== "object") return false;
  const { command, timestamp } = item as Partial<HistoryItem>;
  return typeof command === "string" && typeof timestamp === "number";
}

// Created on first use, so it binds whichever localStorage is in place then. A
// structural failure leaves it in memory for the rest of the session.
let storage: SafeStringStorage | null = null;

// Lists the quota refused. The panel unmounts on collapse, so without this a
// command that couldn't be saved would vanish from the session's history then.
const unsaved = new Map<string, string>();

function getStorage(): SafeStringStorage {
  return (storage ??= createSafeStringStorage());
}

export function resetQuickRunHistoryForTests(): void {
  storage = null;
  unsaved.clear();
}

/** Never throws: an unreadable or malformed history is an empty one. */
export function loadHistory(key: string): HistoryItem[] {
  const store = getStorage();
  const raw = unsaved.get(key) ?? store.getItem(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(isHistoryItem)) return parsed;
    logWarn("Invalid command history format, resetting");
  } catch (error) {
    logError("Failed to parse command history", error);
  }
  store.removeItem(key);
  return [];
}

/**
 * Puts `command` at the front of the stored list and persists the result.
 * Never throws, and a list that can't be persisted is still returned and kept
 * for the session. Storage is read again because a panel reopened while this
 * launch was pending may have recorded since; `previous`, the list on screen,
 * stands in when storage yields nothing, as it does once reads start failing.
 */
export function recordHistory(
  key: string,
  command: string,
  previous: readonly HistoryItem[]
): HistoryItem[] {
  const stored = loadHistory(key);
  const next = appendHistory(stored.length > 0 ? stored : previous, command, Date.now());
  const serialized = JSON.stringify(next);
  if (getStorage().setItem(key, serialized) === "quota") unsaved.set(key, serialized);
  else unsaved.delete(key);
  return next;
}
