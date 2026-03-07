import type { ReactNode } from "react";
import {
  useNotificationStore,
  type NotificationPriority,
  type NotificationType,
  type NotificationAction,
  type NotificationPlacement,
} from "@/store/notificationStore";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";

export interface NotifyPayload {
  type: NotificationType;
  title?: string;
  /** Display message — may be a ReactNode for rich toast content */
  message: string | ReactNode;
  /** Plain-text fallback for the history inbox when message is a ReactNode */
  inboxMessage?: string;
  duration?: number;
  action?: NotificationAction;
  actions?: NotificationAction[];
  placement?: NotificationPlacement;
  /**
   * Controls routing:
   * - "high" (default): toast when focused, history only when blurred
   * - "low": history inbox only — never shown as toast or OS notification
   * - "watch": always shows both in-app toast and OS native notification
   */
  priority?: NotificationPriority;
  /** Groups related notifications into a thread in the notification center */
  correlationId?: string;
}

/**
 * The single public API for creating any notification in Canopy.
 *
 * Every call:
 * 1. Adds a persistent entry to the notification center history
 * 2. Routes display output based on priority and current focus state
 *
 * Routing matrix:
 * | Focus   | Priority | Toast | OS Native | History |
 * |---------|----------|-------|-----------|---------|
 * | focused | high     | yes   | no        | yes     |
 * | focused | low      | no    | no        | yes     |
 * | blurred | high     | no    | no        | yes     |
 * | blurred | low      | no    | no        | yes     |
 * | any     | watch    | yes   | yes       | yes     |
 *
 * The `grid-bar` placement bypasses priority routing and always renders inline.
 */
export function notify(payload: NotifyPayload): string {
  const priority = payload.priority ?? "high";
  const { placement, correlationId, type, title, message, inboxMessage } = payload;

  const historyMessage = inboxMessage ?? (typeof message === "string" ? message : undefined);

  if (historyMessage) {
    useNotificationHistoryStore.getState().addEntry({
      type,
      title,
      message: historyMessage,
      correlationId,
    });
  }

  if (placement === "grid-bar") {
    return useNotificationStore.getState().addNotification({
      ...payload,
      priority,
    });
  }

  const isFocused = typeof document !== "undefined" ? document.hasFocus() : true;

  const shouldToast = priority === "watch" || (priority === "high" && isFocused);
  const shouldNative = priority === "watch";

  if (shouldNative && historyMessage && typeof window !== "undefined") {
    window.electron?.notification?.showNative?.({
      title: title ?? "Canopy",
      body: historyMessage,
    });
  }

  if (shouldToast) {
    return useNotificationStore.getState().addNotification({
      ...payload,
      priority,
    });
  }

  return "";
}
