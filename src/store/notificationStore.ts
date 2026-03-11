import { create } from "zustand";
import type { ReactNode } from "react";
import type { ActionId } from "@shared/types/actions";

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
}

interface NotificationStore {
  notifications: Notification[];
  addNotification: (notification: Omit<Notification, "id">) => string;
  dismissNotification: (id: string) => void;
  removeNotification: (id: string) => void;
  clearNotifications: () => void;
  reset: () => void;
}

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: [],
  addNotification: (notification) => {
    const id = uuidv4();
    set((state) => ({
      notifications: [...state.notifications, { ...notification, id }],
    }));
    return id;
  },
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
