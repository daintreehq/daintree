import { create } from "zustand";

export interface NotificationHistoryEntry {
  id: string;
  type: "success" | "error" | "info" | "warning";
  title?: string;
  message: string;
  timestamp: number;
  context?: {
    projectId?: string;
    worktreeId?: string;
    panelId?: string;
  };
}

const MAX_ENTRIES = 50;

interface NotificationHistoryState {
  entries: NotificationHistoryEntry[];
  unreadCount: number;
  addEntry: (entry: Omit<NotificationHistoryEntry, "id" | "timestamp">) => void;
  clearAll: () => void;
  markAllRead: () => void;
}

export const useNotificationHistoryStore = create<NotificationHistoryState>((set) => ({
  entries: [],
  unreadCount: 0,
  addEntry: (entry) => {
    const newEntry: NotificationHistoryEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    set((state) => {
      const updated = [newEntry, ...state.entries];
      if (updated.length > MAX_ENTRIES) {
        updated.length = MAX_ENTRIES;
      }
      return { entries: updated, unreadCount: state.unreadCount + 1 };
    });
  },
  clearAll: () => set({ entries: [], unreadCount: 0 }),
  markAllRead: () => set({ unreadCount: 0 }),
}));
