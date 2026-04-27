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
import { useNotificationSettingsStore } from "@/store/notificationSettingsStore";
import { isScheduledQuietNow, nextOccurrenceTimestamp } from "@shared/utils/quietHours";

export interface ComboOptions {
  key: string;
  tiers: readonly string[];
  windowMs?: number;
}

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
  /** When set, rapid repeats of the same combo key escalate the toast message through tiers */
  combo?: ComboOptions;
  /** When false, the history entry exists but does not increment the unread badge. Defaults to true. */
  countable?: boolean;
  /** When true, the notification bypasses the startup quiet period gate */
  urgent?: boolean;
  /** Fires exactly once when the user explicitly dismisses the toast via the close or action button */
  onDismiss?: () => void;
  /**
   * Origin context — when set, contextual affordances (e.g. "Mute project
   * notifications") are surfaced on the toast and in the notification center.
   * Propagated to both the active notification and the history entry.
   */
  context?: {
    projectId?: string;
    worktreeId?: string;
    panelId?: string;
  };
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

interface ComboEntry {
  count: number;
  lastAt: number;
}

const _comboCounts = new Map<string, ComboEntry>();

export function _resetComboMap(): void {
  _comboCounts.clear();
}

let _quietUntil = 0;

export function setStartupQuietPeriod(durationMs: number): void {
  _quietUntil = Date.now() + durationMs;
}

export function getQuietPeriodRemaining(): number {
  return Math.max(0, _quietUntil - Date.now());
}

export function _setQuietUntil(ts: number): void {
  _quietUntil = ts;
}

/** Session-only mute helper used by the notification-center quick actions. */
export function setSessionQuietUntil(ts: number): void {
  _quietUntil = ts;
  // Mirror to the renderer store so the toolbar bell can react. Module-level
  // _quietUntil stays the hot-path cache for notify().
  useNotificationSettingsStore.getState().setQuietUntil(ts);
  // Mirror to main so completion watch notifications and working-pulse sounds
  // are also suppressed until the timestamp.
  if (typeof window !== "undefined") {
    window.electron?.notification?.setSessionMuteUntil?.(ts);
  }
}

export function muteForDuration(durationMs: number): number {
  const until = Date.now() + Math.max(0, durationMs);
  setSessionQuietUntil(until);
  return until;
}

/** Mutes notifications until the next occurrence of `morningMin` (default 08:00). */
export function muteUntilNextMorning(morningMin = 8 * 60): number {
  const until = nextOccurrenceTimestamp(morningMin);
  setSessionQuietUntil(until);
  return until;
}

export function isScheduledQuietHours(now: Date = new Date()): boolean {
  const state = useNotificationSettingsStore.getState();
  return isScheduledQuietNow(
    {
      quietHoursEnabled: state.quietHoursEnabled,
      quietHoursStartMin: state.quietHoursStartMin,
      quietHoursEndMin: state.quietHoursEndMin,
      quietHoursWeekdays: state.quietHoursWeekdays,
    },
    now
  );
}

/**
 * The single public API for creating any notification in Daintree.
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
  const { placement, correlationId, type, title, message, inboxMessage, context } = payload;

  const historyMessage = inboxMessage ?? (typeof message === "string" ? message : undefined);

  const allActions = [...(payload.actions ?? []), ...(payload.action ? [payload.action] : [])];

  // Action-bearing toasts persist by default so users can act; toaster's 3s fallback would otherwise dismiss them.
  if (payload.duration === undefined && allActions.length > 0) {
    payload = { ...payload, duration: 0 };
  }

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

  const notificationsEnabled = useNotificationSettingsStore.getState().enabled;
  const isQuiet = !payload.urgent && (Date.now() < _quietUntil || isScheduledQuietHours());

  if (placement === "grid-bar") {
    const entryId = historyMessage
      ? useNotificationHistoryStore.getState().addEntry({
          type,
          title,
          message: historyMessage,
          correlationId,
          seenAsToast: !isQuiet,
          countable: payload.countable,
          actions: historyActions.length > 0 ? historyActions : undefined,
          context,
        })
      : undefined;
    if (!notificationsEnabled || isQuiet) return "";
    return useNotificationStore.getState().addNotification({
      ...payload,
      priority,
      historyEntryId: entryId,
    });
  }

  const isFocused = typeof document !== "undefined" ? document.hasFocus() : true;

  const shouldToast = priority === "watch" || (priority === "high" && isFocused);
  const shouldNative = priority === "watch";

  const historyEntryId = historyMessage
    ? useNotificationHistoryStore.getState().addEntry({
        type,
        title,
        message: historyMessage,
        correlationId,
        seenAsToast: !isQuiet && notificationsEnabled && shouldToast,
        countable: payload.countable,
        actions: historyActions.length > 0 ? historyActions : undefined,
        context,
      })
    : undefined;

  if (!notificationsEnabled || isQuiet) return "";

  if (shouldNative && historyMessage && typeof window !== "undefined") {
    window.electron?.notification?.showNative?.({
      title: title ?? "Daintree",
      body: historyMessage,
    });
  }

  if (shouldToast && payload.combo) {
    const { combo } = payload;
    const windowMs = combo.windowMs ?? 2000;
    const now = Date.now();
    const entry = _comboCounts.get(combo.key);

    let count: number;
    if (entry && now - entry.lastAt <= windowMs) {
      count = entry.count + 1;
    } else {
      count = 1;
    }
    _comboCounts.set(combo.key, { count, lastAt: now });

    const tierIndex = Math.min(count - 1, combo.tiers.length - 1);
    const comboMessage = combo.tiers[tierIndex];

    payload = { ...payload, message: comboMessage };
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

        // When the caller provides `buildAction`, it owns the action slot on
        // coalesce — clear any per-item `actions` array from the initial toast
        // so stale buttons (e.g. "Close project-1") don't linger after we
        // collapse multiple notifications together.
        const patchAction = coalesce.buildAction?.(count) ?? payload.action;
        const patch: Parameters<
          ReturnType<typeof useNotificationStore.getState>["updateNotification"]
        >[1] = {
          message: coalesce.buildMessage(count),
          title: coalesce.buildTitle?.(count) ?? title,
          inboxMessage: coalesce.buildInboxMessage?.(count),
          action: patchAction,
        };
        if (coalesce.buildAction) {
          patch.actions = undefined;
        }
        // Clear context on coalesce: the combined toast now represents multiple
        // events which may originate from different projects. A contextual
        // affordance like "Mute project notifications" would otherwise dispatch
        // with the first project's ID and silently mute the wrong target.
        if (notification.context?.projectId !== context?.projectId) {
          patch.context = undefined;
        }
        // Mirror the create-path rule: if the updated toast will be action-bearing
        // and the stored duration is still `undefined`, persist it.
        const resultingActionsCount =
          (patchAction ? 1 : 0) + (coalesce.buildAction ? 0 : (notification.actions?.length ?? 0));
        if (notification.duration === undefined && resultingActionsCount > 0) {
          patch.duration = 0;
        }
        useNotificationStore.getState().updateNotification(existing.id, patch);

        return existing.id;
      }
    }

    const id = useNotificationStore.getState().addNotification({
      ...payload,
      priority,
      historyEntryId,
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
      historyEntryId,
    });
  }

  return "";
}
