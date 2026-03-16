import { create } from "zustand";
import type { ActionId } from "@shared/types/actions";
import type { NotificationActionVariant } from "@/store/notificationStore";

export interface NotificationHistoryAction {
  label: string;
  actionId: ActionId;
  actionArgs?: Record<string, unknown>;
  variant?: NotificationActionVariant;
}

export interface NotificationHistoryEntry {
  id: string;
  type: "success" | "error" | "info" | "warning";
  title?: string;
  message: string;
  timestamp: number;
  correlationId?: string;
  /** True when the user has seen this notification (shown as toast or explicitly marked as read). False when missed (app blurred or low priority). */
  seenAsToast: boolean;
  /** True after being included in a re-entry summary shown on window refocus. */
  summarized: boolean;
  /** When false, the entry exists in history but does not increment the unread badge. Defaults to true. */
  countable: boolean;
  context?: {
    projectId?: string;
    worktreeId?: string;
    panelId?: string;
  };
  actions?: NotificationHistoryAction[];
}

type AddEntryInput = Omit<
  NotificationHistoryEntry,
  "id" | "timestamp" | "seenAsToast" | "summarized" | "countable"
> & {
  seenAsToast?: boolean;
  countable?: boolean;
};

const MAX_ENTRIES = 200;

interface NotificationHistoryState {
  entries: NotificationHistoryEntry[];
  unreadCount: number;
  addEntry: (entry: AddEntryInput) => string;
  markUnseenAsToast: (id: string) => void;
  dismissEntry: (id: string) => void;
  clearAll: () => void;
  markAllRead: () => void;
  markSummarized: (ids: string[]) => void;
}

export const useNotificationHistoryStore = create<NotificationHistoryState>((set) => ({
  entries: [],
  unreadCount: 0,
  addEntry: (entry) => {
    const seenAsToast = entry.seenAsToast ?? false;
    const countable = entry.countable ?? true;
    const newEntry: NotificationHistoryEntry = {
      ...entry,
      seenAsToast,
      summarized: false,
      countable,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    set((state) => {
      const updated = [newEntry, ...state.entries];
      if (updated.length > MAX_ENTRIES) {
        updated.length = MAX_ENTRIES;
      }
      const unreadCount = updated.filter((e) => !e.seenAsToast && e.countable !== false).length;
      return { entries: updated, unreadCount };
    });
    return newEntry.id;
  },
  markUnseenAsToast: (id) =>
    set((state) => {
      const entry = state.entries.find((e) => e.id === id);
      if (!entry || !entry.seenAsToast) return state;
      const entries = state.entries.map((e) => (e.id === id ? { ...e, seenAsToast: false } : e));
      return {
        entries,
        unreadCount: entries.filter((e) => !e.seenAsToast && e.countable !== false).length,
      };
    }),
  dismissEntry: (id) =>
    set((state) => {
      const entries = state.entries.filter((e) => e.id !== id);
      return {
        entries,
        unreadCount: entries.filter((e) => !e.seenAsToast && e.countable !== false).length,
      };
    }),
  clearAll: () => set({ entries: [], unreadCount: 0 }),
  markAllRead: () =>
    set((state) => ({
      unreadCount: 0,
      entries: state.entries.map((e) => (e.seenAsToast ? e : { ...e, seenAsToast: true })),
    })),
  markSummarized: (ids) =>
    set((state) => {
      const idSet = new Set(ids);
      return {
        entries: state.entries.map((e) =>
          idSet.has(e.id) && !e.summarized ? { ...e, summarized: true } : e
        ),
      };
    }),
}));

/** Returns all history entries that share the given correlationId */
export function getEntriesByCorrelationId(correlationId: string): NotificationHistoryEntry[] {
  return useNotificationHistoryStore
    .getState()
    .entries.filter((e) => e.correlationId === correlationId);
}
