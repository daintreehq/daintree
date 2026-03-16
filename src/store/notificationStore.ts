import { create } from "zustand";
import type { ReactNode } from "react";
import type { ActionId } from "@shared/types/actions";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";

const uuidv4 = () => crypto.randomUUID();

export type NotificationType = "success" | "error" | "info" | "warning";
export type NotificationPlacement = "toast" | "grid-bar";
export type NotificationActionVariant = "primary" | "secondary";
export type NotificationPriority = "high" | "low" | "watch";

export interface NotificationAction {
  label: string;
  onClick: () => void | Promise<void>;
  variant?: NotificationActionVariant;
  actionId?: ActionId;
  actionArgs?: Record<string, unknown>;
}

export interface Notification {
  id: string;
  type: NotificationType;
  priority: NotificationPriority;
  placement?: NotificationPlacement;
  title?: string;
  message: string | ReactNode;
  /** Plain-text fallback for history when message is a ReactNode */
  inboxMessage?: string;
  duration?: number;
  action?: NotificationAction;
  actions?: NotificationAction[];
  correlationId?: string;
  /** Set to true synchronously on dismiss to avoid flicker */
  dismissed?: boolean;
  /** Bumped on each coalesced update so useEffect deps can detect changes */
  updatedAt?: number;
  /** Links this toast to its notification history entry for overflow tracking */
  historyEntryId?: string;
}

export type NotificationPatch = Partial<Omit<Notification, "id">>;

interface NotificationStore {
  notifications: Notification[];
  addNotification: (notification: Omit<Notification, "id">) => string;
  updateNotification: (id: string, patch: NotificationPatch) => void;
  dismissNotification: (id: string) => void;
  removeNotification: (id: string) => void;
  clearNotifications: () => void;
  reset: () => void;
}

export const MAX_VISIBLE_TOASTS = 3;

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: [],
  addNotification: (notification) => {
    const id = uuidv4();
    set((state) => {
      let notifications = state.notifications;
      if (notification.placement !== "grid-bar") {
        const active = notifications.filter((n) => !n.dismissed && n.placement !== "grid-bar");
        if (active.length >= MAX_VISIBLE_TOASTS) {
          const oldest = active[0];
          notifications = notifications.map((n) =>
            n.id === oldest.id ? { ...n, dismissed: true } : n
          );
          if (oldest.historyEntryId) {
            useNotificationHistoryStore.getState().markUnseenAsToast(oldest.historyEntryId);
          }
        }
      }
      return {
        notifications: [...notifications, { ...notification, id, updatedAt: Date.now() }],
      };
    });
    return id;
  },
  updateNotification: (id, patch) =>
    set((state) => ({
      notifications: state.notifications.map((n) =>
        n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n
      ),
    })),
  dismissNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.map((n) => (n.id === id ? { ...n, dismissed: true } : n)),
    })),
  removeNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    })),
  clearNotifications: () => set({ notifications: [] }),
  reset: () => set({ notifications: [] }),
}));
