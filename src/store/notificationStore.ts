import { create } from "zustand";
import type { ReactNode } from "react";

const uuidv4 = () => crypto.randomUUID();

export type NotificationType = "success" | "error" | "info" | "warning";
export type NotificationPlacement = "toast" | "grid-bar";
export type NotificationActionVariant = "primary" | "secondary";

export interface NotificationAction {
  label: string;
  onClick: () => void | Promise<void>;
  variant?: NotificationActionVariant;
}

export interface Notification {
  id: string;
  type: NotificationType;
  placement?: NotificationPlacement;
  title?: string;
  message: string | ReactNode;
  duration?: number;
  action?: NotificationAction;
  actions?: NotificationAction[];
}

interface NotificationStore {
  notifications: Notification[];
  addNotification: (notification: Omit<Notification, "id">) => string;
  removeNotification: (id: string) => void;
  clearNotifications: () => void;
  reset: () => void;
}

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: [],
  addNotification: (notification) => {
    const id = uuidv4();
    const newNotification = { ...notification, id };

    set((state) => ({
      notifications: [...state.notifications, newNotification],
    }));

    return id;
  },
  removeNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    })),
  clearNotifications: () => set({ notifications: [] }),
  reset: () => set({ notifications: [] }),
}));
