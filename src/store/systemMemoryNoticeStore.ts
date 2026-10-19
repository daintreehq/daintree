import { create } from "zustand";
import type { NotificationAction } from "@/store/notificationStore";

export interface SystemMemoryNotice {
  /** The observed readings, one line, never a cause (#12462). */
  reading: string;
  /** The reading with its restart note and Daintree's workloads, for the row's tooltip. */
  detail: string;
  action: NotificationAction | null;
  /** The kernel reported its critical level on the latest publish. */
  critical: boolean;
}

interface SystemMemoryNoticeState {
  /**
   * The open high-memory episode this view raised, shown as a sidebar footer
   * row (#13101). Live hardware state rather than a notification, so inbox
   * dismissal and clear-all never touch it — only recovery clears it, and a
   * worsening episode replaces it. Owned by `useSystemMemoryPressureNotice`.
   */
  notice: SystemMemoryNotice | null;
  setNotice: (notice: SystemMemoryNotice) => void;
  clearNotice: () => void;
}

export const useSystemMemoryNoticeStore = create<SystemMemoryNoticeState>((set) => ({
  notice: null,
  setNotice: (notice) => set({ notice }),
  clearNotice: () => set({ notice: null }),
}));
