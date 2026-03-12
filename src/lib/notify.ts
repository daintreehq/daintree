import type { ReactNode } from "react";
import {
  useNotificationStore,
  type NotificationPriority,
  type NotificationType,
  type NotificationAction,
  type NotificationPlacement,
} from "@/store/notificationStore";
import {
  useNotificationHistoryStore,
  type NotificationHistoryAction,
} from "@/store/slices/notificationHistorySlice";

export interface CoalesceOptions {
  key: string;
  windowMs?: number;
  buildMessage: (count: number) => string | ReactNode;
  buildTitle?: (count: number) => string | undefined;
  buildInboxMessage?: (count: number) => string | undefined;
  buildAction?: (count: number) => NotificationAction | undefined;
}

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
  /** When set, rapidly fired notifications with the same key coalesce into a single updating toast */
  coalesce?: CoalesceOptions;
}

interface CoalesceEntry {
  id: string;
  expiresAt: number;
  count: number;
}

const _activeCoalesced = new Map<string, CoalesceEntry>();

export function _resetCoalesceMap(): void {
  _activeCoalesced.clear();
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

  const allActions = [...(payload.actions ?? []), ...(payload.action ? [payload.action] : [])];
  const historyActions: NotificationHistoryAction[] = allActions
    .filter(
      (a): a is NotificationAction & { actionId: NonNullable<NotificationAction["actionId"]> } =>
        !!a.actionId
    )
    .map((a) => ({
      label: a.label,
      actionId: a.actionId,
      actionArgs: a.actionArgs,
      variant: a.variant,
    }));

  if (placement === "grid-bar") {
    if (historyMessage) {
      useNotificationHistoryStore.getState().addEntry({
        type,
        title,
        message: historyMessage,
        correlationId,
        seenAsToast: true,
        actions: historyActions.length > 0 ? historyActions : undefined,
      });
    }
    return useNotificationStore.getState().addNotification({
      ...payload,
      priority,
    });
  }

  const isFocused = typeof document !== "undefined" ? document.hasFocus() : true;

  const shouldToast = priority === "watch" || (priority === "high" && isFocused);
  const shouldNative = priority === "watch";

  if (historyMessage) {
    useNotificationHistoryStore.getState().addEntry({
      type,
      title,
      message: historyMessage,
      correlationId,
      seenAsToast: shouldToast,
      actions: historyActions.length > 0 ? historyActions : undefined,
    });
  }

  if (shouldNative && historyMessage && typeof window !== "undefined") {
    window.electron?.notification?.showNative?.({
      title: title ?? "Canopy",
      body: historyMessage,
    });
  }

  if (shouldToast && payload.coalesce) {
    const { coalesce } = payload;
    const windowMs = coalesce.windowMs ?? 2000;
    const now = Date.now();
    const existing = _activeCoalesced.get(coalesce.key);

    if (existing && existing.expiresAt > now) {
      const notification = useNotificationStore
        .getState()
        .notifications.find((n) => n.id === existing.id && !n.dismissed);

      if (notification) {
        existing.count += 1;
        existing.expiresAt = now + windowMs;
        const count = existing.count;

        useNotificationStore.getState().updateNotification(existing.id, {
          message: coalesce.buildMessage(count),
          title: coalesce.buildTitle?.(count) ?? title,
          inboxMessage: coalesce.buildInboxMessage?.(count),
          action: coalesce.buildAction?.(count) ?? payload.action,
        });

        return existing.id;
      }
    }

    const id = useNotificationStore.getState().addNotification({
      ...payload,
      priority,
    });
    _activeCoalesced.set(coalesce.key, {
      id,
      expiresAt: now + windowMs,
      count: 1,
    });
    return id;
  }

  if (shouldToast) {
    return useNotificationStore.getState().addNotification({
      ...payload,
      priority,
    });
  }

  return "";
}
