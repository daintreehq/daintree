import { create, type StateCreator } from "zustand";
import type { LogEntry, LogFilterOptions, LogLevel } from "@/types";
import { safeStringify } from "@/lib/safeStringify";

const KNOWN_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export interface DisplayEntry {
  entry: LogEntry;
  count: number;
}

interface ParsedSearch {
  levels: LogLevel[];
  sources: string[];
  contextMatchers: { path: string[]; value: string }[];
  text: string;
}

// Keys are `\w+` only (alphanumerics + underscore). Hyphenated keys like `request-id`
// won't be captured — `context.request-id:val` would parse as `id:val` and fall through
// the unknown-key branch, leaving the full token in the remainder text.
const TOKEN_REGEX = /(\w+(?:\.\w+)*):("[^"]*"|\S+)/g;

function parseSearchTokens(search: string): ParsedSearch {
  const levels: LogLevel[] = [];
  const sources: string[] = [];
  const contextMatchers: { path: string[]; value: string }[] = [];
  let text = search;

  const matches = [...search.matchAll(TOKEN_REGEX)];
  for (const match of matches) {
    const key = match[1];
    let value = match[2];
    if (!key || value === undefined) continue;
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value === "") continue;

    if (key === "level") {
      const lower = value.toLowerCase() as LogLevel;
      if (KNOWN_LEVELS.includes(lower) && !levels.includes(lower)) levels.push(lower);
    } else if (key === "source") {
      if (!sources.includes(value)) sources.push(value);
    } else if (key.startsWith("context.")) {
      const path = key.slice("context.".length).split(".").filter(Boolean);
      if (path.length > 0) contextMatchers.push({ path, value });
    } else {
      continue;
    }
    text = text.replace(match[0], "");
  }

  return {
    levels,
    sources,
    contextMatchers,
    text: text.replace(/\s+/g, " ").trim(),
  };
}

function resolveContextPath(context: unknown, path: string[]): unknown {
  let current: unknown = context;
  for (const segment of path) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

interface LogsState {
  logs: LogEntry[];
  isOpen: boolean;
  filters: LogFilterOptions;
  autoScroll: boolean;
  expandedIds: Set<string>;

  addLog: (entry: LogEntry) => void;
  addLogs: (entries: LogEntry[]) => void;
  setLogs: (logs: LogEntry[]) => void;
  clearLogs: () => void;
  togglePanel: () => void;
  setOpen: (open: boolean) => void;
  setFilters: (filters: Partial<LogFilterOptions>) => void;
  clearFilters: () => void;
  setAutoScroll: (autoScroll: boolean) => void;
  toggleExpanded: (id: string) => void;
  collapseAll: () => void;
  reset: () => void;
}

const MAX_LOGS = 500;

const createLogsStore: StateCreator<LogsState> = (set) => ({
  logs: [],
  isOpen: false,
  filters: {},
  autoScroll: true,
  expandedIds: new Set(),

  addLog: (entry) =>
    set((state) => {
      const newLogs = [...state.logs, entry];
      if (newLogs.length > MAX_LOGS) {
        const trimmedLogs = newLogs.slice(-MAX_LOGS);
        const keepIds = new Set(trimmedLogs.map((l) => l.id));
        const expandedIds = new Set([...state.expandedIds].filter((id) => keepIds.has(id)));
        return { logs: trimmedLogs, expandedIds };
      }
      return { logs: newLogs };
    }),

  addLogs: (entries) =>
    set((state) => {
      if (!Array.isArray(entries) || entries.length === 0) return {};
      const newLogs = [...state.logs, ...entries];
      if (newLogs.length > MAX_LOGS) {
        const trimmedLogs = newLogs.slice(-MAX_LOGS);
        const keepIds = new Set(trimmedLogs.map((l) => l.id));
        const expandedIds = new Set([...state.expandedIds].filter((id) => keepIds.has(id)));
        return { logs: trimmedLogs, expandedIds };
      }
      return { logs: newLogs };
    }),

  setLogs: (logs) =>
    set((state) => {
      const clamped = logs.length > MAX_LOGS ? logs.slice(-MAX_LOGS) : logs;
      const keepIds = new Set(clamped.map((l) => l.id));
      const expandedIds = new Set([...state.expandedIds].filter((id) => keepIds.has(id)));
      return { logs: clamped, expandedIds };
    }),

  clearLogs: () => set({ logs: [], expandedIds: new Set() }),

  togglePanel: () => set((state) => ({ isOpen: !state.isOpen })),

  setOpen: (isOpen) => set({ isOpen }),

  setFilters: (newFilters) =>
    set((state) => ({
      filters: { ...state.filters, ...newFilters },
    })),

  clearFilters: () => set({ filters: {} }),

  setAutoScroll: (autoScroll) => set({ autoScroll }),

  toggleExpanded: (id) =>
    set((state) => {
      const newSet = new Set(state.expandedIds);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return { expandedIds: newSet };
    }),

  collapseAll: () => set({ expandedIds: new Set() }),

  reset: () =>
    set({
      logs: [],
      isOpen: false,
      filters: {},
      autoScroll: true,
      expandedIds: new Set(),
    }),
});

export const useLogsStore = create<LogsState>()(createLogsStore);

export function filterLogs(logs: LogEntry[], filters: LogFilterOptions): LogEntry[] {
  const parsed = filters.search ? parseSearchTokens(filters.search) : null;

  const effectiveLevels = [...(filters.levels ?? []), ...(parsed?.levels ?? [])];
  const effectiveSources = [...(filters.sources ?? []), ...(parsed?.sources ?? [])];

  let filtered = logs;

  if (effectiveLevels.length > 0) {
    const levelSet = new Set(effectiveLevels);
    filtered = filtered.filter((log) => levelSet.has(log.level));
  }

  if (effectiveSources.length > 0) {
    const sourceSet = new Set(effectiveSources);
    filtered = filtered.filter((log) => !!log.source && sourceSet.has(log.source));
  }

  if (parsed && parsed.contextMatchers.length > 0) {
    filtered = filtered.filter((log) =>
      parsed.contextMatchers.every((matcher) => {
        const resolved = resolveContextPath(log.context, matcher.path);
        if (resolved === undefined || resolved === null) return false;
        const serialized = typeof resolved === "string" ? resolved : safeStringify(resolved);
        return serialized.toLowerCase().includes(matcher.value.toLowerCase());
      })
    );
  }

  if (parsed && parsed.text) {
    const textLower = parsed.text.toLowerCase();
    filtered = filtered.filter((log) => {
      const message = typeof log.message === "string" ? log.message : String(log.message ?? "");
      return message.toLowerCase().includes(textLower);
    });
  }

  if (filters.startTime !== undefined) {
    filtered = filtered.filter((log) => log.timestamp >= filters.startTime!);
  }
  if (filters.endTime !== undefined) {
    filtered = filtered.filter((log) => log.timestamp <= filters.endTime!);
  }

  return filtered;
}

export function collapseConsecutiveDuplicates(logs: LogEntry[]): DisplayEntry[] {
  const result: DisplayEntry[] = [];
  for (const log of logs) {
    const last = result[result.length - 1];
    if (
      last &&
      last.entry.level === log.level &&
      last.entry.message === log.message &&
      last.entry.source === log.source
    ) {
      last.count++;
    } else {
      result.push({ entry: log, count: 1 });
    }
  }
  return result;
}
