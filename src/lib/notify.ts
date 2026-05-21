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
import { normalizeForDedup } from "@shared/utils/normalizeErrorMessage";
import type { ErrorRetryability, ErrorType } from "@/store/errorStore";
import type { NotificationSettings } from "@shared/types/ipc/api";

export type NotificationEventKind = "completed" | "waiting" | "workingPulse" | "uiFeedback";

export const EVENT_KIND_TO_SETTING_KEY: Record<NotificationEventKind, keyof NotificationSettings> =
  {
    completed: "completedEnabled",
    waiting: "waitingEnabled",
    workingPulse: "workingPulseEnabled",
    uiFeedback: "uiFeedbackSoundEnabled",
  };

export const EVENT_KIND_LABEL: Record<NotificationEventKind, string> = {
  completed: "completed notifications",
  waiting: "waiting notifications",
  workingPulse: "working pulse sound",
  uiFeedback: "UI feedback sounds",
};

const EVENT_KIND_VALUES: ReadonlySet<string> = new Set(Object.keys(EVENT_KIND_LABEL));

export function isNotificationEventKind(v: string | undefined): v is NotificationEventKind {
  return v !== undefined && EVENT_KIND_VALUES.has(v);
}

/**
 * Default auto-dismiss durations (ms) by notification type.
 *
 * Errors and warnings get a generous 12s so the user has time to read them;
 * success dismisses in 5s — Adobe Spectrum's accessibility minimum, leaving
 * room for short-sentence copy without rushing slow readers. Info gets 8s to
 * match the Atlassian accessibility minimum for sentence-length content. When
 * a toast fires, the persistent inbox is the WCAG 2.2.1 conforming alternative
 * — users who miss a toast can always recover it from the notification center.
 * When no toast is shown (priority "low"), the inbox is the primary channel and
 * carries no compliance load.
 *
 * Action-bearing toasts override this to `0` (sticky) so the action remains
 * available; explicit `duration` on the payload always wins.
 */
export const TOAST_DURATION: Record<NotificationType, number> = {
  error: 12000,
  warning: 12000,
  success: 5000,
  info: 8000,
};

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
  /**
   * Logical pairing key. When a later `notify()` carries the same
   * `supersedeKey`, the prior non-archived inbox entry with that key is
   * archived automatically — used for resolving-event pairs like
   * "disconnected" → "reconnected" so the inbox doesn't accumulate stale
   * stateful rows. Independent of `correlationId`: `correlationId` threads
   * conversational entries; `supersedeKey` retires them.
   */
  supersedeKey?: string;
  /**
   * Exact id of a prior inbox entry to archive when this one is added.
   * Takes precedence over `supersedeKey`. No-op when the target is missing
   * or already archived.
   */
  supersedes?: string;
  /** When set, rapidly fired notifications with the same key coalesce into a single updating toast */
  coalesce?: CoalesceOptions;
  /**
   * Per-source rate-limit bucket key. When the same key fires more than
   * RATE_LIMIT_MAX_TOKENS toasts within RATE_LIMIT_REFILL_MS × MAX_TOKENS,
   * overflow is redirected to a single in-place summary inbox row instead of
   * the toaster. Distinct from `coalesce.key`: coalesce collapses bursts into
   * a single updating toast over a short window (~2s); `rateLimitKey` drops
   * the would-be toast entirely and aggregates the missed signal into an
   * inbox summary, catching slow-dripping noisy producers that sit outside
   * the coalesce window. Falls back to `correlationId ?? context.projectId ??
   * context.worktreeId ?? type` when omitted.
   */
  rateLimitKey?: string;
  /** When false, the history entry exists but does not increment the unread badge. Defaults to true. */
  countable?: boolean;
  /**
   * When true, the notification is shown as a toast only — no history entry is
   * written and no unread badge increments. Use only for one-shot confirmations
   * where the result is already visible elsewhere (clipboard write, file dialog
   * outcome, in-place UI state). Stronger than `countable: false`, which still
   * writes the entry; `transient` skips the inbox entirely.
   */
  transient?: boolean;
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
    /** When set, per-kind silence affordances are surfaced on the toast and notification center kebab. */
    eventKind?: NotificationEventKind;
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

// ── active-context suppression ──────────────────────────────────────────────
//
// When a focused, high-priority notification originates from a surface the
// user is already looking at (matching `context.worktreeId` or
// `context.panelId`), the toast is suppressed and the event is recorded
// only in the inbox. A 500ms grace window catches navigate-away races: if
// the user moves to a different surface before the timer expires, the
// suppressed event is promoted to a real toast so the missed signal still
// reaches them.

export interface ActiveContextAccessors {
  getActiveWorktreeId: () => string | null;
  getFocusedPanelId: () => string | null;
  /** Subscribes to changes in either active worktree or focused panel. Returns an unsubscribe. */
  subscribeActiveContext: (cb: () => void) => () => void;
}

let _activeContextAccessors: ActiveContextAccessors | null = null;

export function setActiveContextAccessors(accessors: ActiveContextAccessors): void {
  _activeContextAccessors = accessors;
}

export function _resetActiveContextAccessorsForTest(): void {
  _activeContextAccessors = null;
}

const SUPPRESS_GRACE_MS = 500;

interface PendingSuppressedEntry {
  timerId: ReturnType<typeof setTimeout>;
  unsub: () => void;
}

const _pendingSuppressed = new Map<string, PendingSuppressedEntry>();

export function _resetPendingSuppressedForTest(): void {
  for (const entry of _pendingSuppressed.values()) {
    clearTimeout(entry.timerId);
    entry.unsub();
  }
  _pendingSuppressed.clear();
}

function isOriginSurfaceVisible(context: NotifyPayload["context"]): boolean {
  if (!context) return false;
  if (!_activeContextAccessors) return false;
  if (typeof document !== "undefined" && !document.hasFocus()) return false;

  if (context.worktreeId) {
    if (_activeContextAccessors.getActiveWorktreeId() === context.worktreeId) return true;
  }
  if (context.panelId) {
    if (_activeContextAccessors.getFocusedPanelId() === context.panelId) return true;
  }
  // `projectId` alone is not a surface — a project can have many worktrees.
  return false;
}

// ── transient error escalation ──────────────────────────────────────────────
//
// Transient errors (EBUSY, EAGAIN, ETIMEDOUT, ECONNRESET, ENOTFOUND) are
// routed to priority "low" by default (history-only, no toast). When the same
// error repeats beyond a threshold within a time window, we escalate the next
// instance to priority "high" so the user gets a toast. Escalation is one-shot
// per group with a 60-minute cooldown to avoid toast storms.

interface EscalationTracker {
  count: number;
  firstAt: number;
  lastAt: number;
  escalated: boolean;
  cooldownUntil: number;
}

const ESCALATION_MAX_ENTRIES = 200;
const ESCALATION_COOLDOWN_MS = 60 * 60 * 1000;

interface EscalationProfile {
  windowMs: number;
  threshold: number;
}

const LOCAL_RESOURCE_PROFILE: EscalationProfile = { windowMs: 5_000, threshold: 3 };
const NETWORK_PROFILE: EscalationProfile = { windowMs: 120_000, threshold: 3 };

function classifyErrorType(type: ErrorType): EscalationProfile {
  switch (type) {
    case "filesystem":
    case "process":
      return LOCAL_RESOURCE_PROFILE;
    default:
      return NETWORK_PROFILE;
  }
}

function buildEscalationKey(error: { type: ErrorType; message: string; source?: string }): string {
  return `${error.type}|${error.source ?? ""}|${normalizeForDedup(error.message)}`;
}

const _escalationTrackers = new Map<string, EscalationTracker>();

export function _resetEscalationTrackers(): void {
  _escalationTrackers.clear();
}

function pruneEscalationTrackers(): void {
  if (_escalationTrackers.size <= ESCALATION_MAX_ENTRIES) return;

  const entries = Array.from(_escalationTrackers.entries());
  entries.sort((a, b) => a[1].lastAt - b[1].lastAt);

  const toRemove = entries.slice(0, entries.length - ESCALATION_MAX_ENTRIES);
  for (const [key] of toRemove) {
    _escalationTrackers.delete(key);
  }
}

export function shouldEscalateTransientError(error: {
  type: ErrorType;
  message: string;
  source?: string;
  retryability: ErrorRetryability;
}): boolean {
  if (error.retryability !== "auto") return false;

  const key = buildEscalationKey(error);
  const now = Date.now();
  const profile = classifyErrorType(error.type);
  const tracker = _escalationTrackers.get(key);

  if (tracker) {
    if (tracker.escalated && now < tracker.cooldownUntil) return false;

    if (now - tracker.firstAt <= profile.windowMs) {
      tracker.count += 1;
      tracker.lastAt = now;
    } else {
      tracker.count = 1;
      tracker.firstAt = now;
      tracker.lastAt = now;
      tracker.escalated = false;
    }

    if (tracker.count >= profile.threshold && !tracker.escalated) {
      return true;
    }
  } else {
    _escalationTrackers.set(key, {
      count: 1,
      firstAt: now,
      lastAt: now,
      escalated: false,
      cooldownUntil: 0,
    });
    pruneEscalationTrackers();
  }

  return false;
}

export function consumeEscalation(error: {
  type: ErrorType;
  message: string;
  source?: string;
  retryability: ErrorRetryability;
}): void {
  if (error.retryability !== "auto") return;

  const key = buildEscalationKey(error);
  const tracker = _escalationTrackers.get(key);
  if (!tracker || tracker.escalated) return;

  const profile = classifyErrorType(error.type);
  if (tracker.count >= profile.threshold) {
    tracker.escalated = true;
    tracker.cooldownUntil = Date.now() + ESCALATION_COOLDOWN_MS;
  }
}

// ── per-source rate-limit (token bucket) ────────────────────────────────────
//
// Catches slow-dripping noisy producers that sit outside `coalesce` (2s
// window) and `shouldEscalateTransientError` (retryability: "auto" only).
// A bucket holds up to RATE_LIMIT_MAX_TOKENS = 3 tokens and refills at
// 1 token per RATE_LIMIT_REFILL_MS (10s) → 3-toast burst + ~3/30s long-run
// average per source. On overflow, the would-be toast is suppressed and an
// in-place `priority: "low"` summary inbox row tracks the count so the
// signal still lands.
//
// Bypassed for: priority "low" (already inbox-only), transient: true (no
// inbox fallback — would silently drop), placement "grid-bar" (renders
// inline and is its own gate), and explicit `urgent: true` (caller has
// declared the event critical enough to outrun even quiet hours).

const RATE_LIMIT_MAX_TOKENS = 3;
const RATE_LIMIT_REFILL_MS = 10_000;
const RATE_LIMIT_MAX_BUCKETS = 200;

interface RateLimitBucket {
  tokens: number;
  /**
   * Token-refill clock — advances only when a refill interval elapses, so
   * its rate of change reflects token mechanics, not source activity. Don't
   * use it for LRU pruning; use `lastSeen` instead.
   */
  lastRefill: number;
  /**
   * Wall-clock of the most recent rate-limit check on this bucket. Updated
   * on every call (allow or overflow). Used as the LRU sort key so an
   * actively-overflowing source stays in the map and isn't recycled into a
   * fresh 3-token bucket by an unrelated insert burst.
   */
  lastSeen: number;
  /** id of the active summary inbox row, or null when no overflow is in flight */
  overflowEntryId: string | null;
  overflowCount: number;
}

const _rateLimitBuckets = new Map<string, RateLimitBucket>();

export function _resetRateLimitBuckets(): void {
  _rateLimitBuckets.clear();
}

function pruneRateLimitBuckets(): void {
  if (_rateLimitBuckets.size <= RATE_LIMIT_MAX_BUCKETS) return;

  const entries = Array.from(_rateLimitBuckets.entries());
  entries.sort((a, b) => a[1].lastSeen - b[1].lastSeen);

  const toRemove = entries.slice(0, entries.length - RATE_LIMIT_MAX_BUCKETS);
  for (const [key] of toRemove) {
    _rateLimitBuckets.delete(key);
  }
}

function getRateLimitKey(payload: NotifyPayload): string {
  return (
    payload.rateLimitKey ??
    payload.correlationId ??
    payload.context?.projectId ??
    payload.context?.worktreeId ??
    payload.type
  );
}

function buildOverflowSummary(source: string, count: number): string {
  const eventsWord = count === 1 ? "event" : "events";
  return `${source} reported ${count} more ${eventsWord} — open inbox`;
}

/**
 * Returns true when the would-be toast should be suppressed and the caller
 * must not write its own inbox entry. Refills tokens based on elapsed time,
 * consumes one when available, otherwise writes (or updates) an in-place
 * low-priority summary inbox row keyed by the bucket.
 */
function checkAndApplyRateLimit(payload: NotifyPayload): boolean {
  const key = getRateLimitKey(payload);
  const now = Date.now();
  let bucket = _rateLimitBuckets.get(key);

  if (!bucket) {
    bucket = {
      tokens: RATE_LIMIT_MAX_TOKENS,
      lastRefill: now,
      lastSeen: now,
      overflowEntryId: null,
      overflowCount: 0,
    };
    _rateLimitBuckets.set(key, bucket);
    pruneRateLimitBuckets();
  } else {
    bucket.lastSeen = now;
    const elapsed = now - bucket.lastRefill;
    const refill = Math.floor(elapsed / RATE_LIMIT_REFILL_MS);
    if (refill > 0) {
      const newTokens = Math.min(RATE_LIMIT_MAX_TOKENS, bucket.tokens + refill);
      const wasEmpty = bucket.tokens === 0;
      bucket.tokens = newTokens;
      bucket.lastRefill += refill * RATE_LIMIT_REFILL_MS;
      // Recovered from overflow → next overflow starts a fresh summary row.
      if (wasEmpty && newTokens > 0) {
        bucket.overflowEntryId = null;
        bucket.overflowCount = 0;
      }
    }
  }

  if (bucket.tokens > 0) {
    bucket.tokens -= 1;
    return false;
  }

  bucket.overflowCount += 1;
  const historyStore = useNotificationHistoryStore.getState();

  // Try to update an existing summary row first. If the row has been
  // archived, dismissed, or pushed off the end of the 200-entry history
  // ring, `updateEntryMessage` returns false — fall through and write a
  // fresh row so the overflow signal isn't silently lost.
  if (bucket.overflowEntryId) {
    const updated = historyStore.updateEntryMessage(
      bucket.overflowEntryId,
      buildOverflowSummary(key, bucket.overflowCount)
    );
    if (!updated) {
      bucket.overflowEntryId = null;
      bucket.overflowCount = 1;
    }
  }
  if (!bucket.overflowEntryId) {
    // No context on the summary row: a bucket can span multiple projects
    // when its key isn't context-derived (explicit `rateLimitKey`, falls
    // back to `correlationId` or `type`), so a contextual affordance like
    // "Mute project X" would dispatch against the first overflow's project
    // and silently mute the wrong target on later events.
    bucket.overflowEntryId = historyStore.addEntry({
      type: payload.type,
      title: payload.title,
      message: buildOverflowSummary(key, bucket.overflowCount),
      correlationId: payload.correlationId,
      seenAsToast: false,
      countable: payload.countable,
    });
  }

  return true;
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
 *
 * `transient: true` skips step 1 — no history entry, no badge tick. Use it
 * only for one-shot confirmations whose result is already visible elsewhere
 * (clipboard, file dialog, in-place UI). It is stronger than `countable:
 * false`, which still writes the entry but suppresses the badge. Constraints:
 * combine with `priority: "high"` (or default) only — `priority: "low"` is a
 * no-op (no toast and no inbox), and `priority: "watch"` still fires the OS
 * native banner with no inbox fallback. Don't pair with `context` either:
 * the active-context suppression-grace path needs an inbox entry to fall
 * back to and silently drops the event when one isn't written.
 *
 * Only call for events the user could not otherwise observe: completion, failure,
 * or required action. Don't duplicate in-place UI state changes — those are
 * already visible without a notification.
 *
 * When `message` is a non-string ReactNode, `inboxMessage` is required —
 * otherwise the history entry is dropped and a toast (when shown) has no
 * WCAG 2.2.1 recoverable alternative. String messages auto-derive the history
 * text from the message itself.
 */
export function notify(
  payload: Omit<NotifyPayload, "message" | "inboxMessage"> & {
    message: string;
    inboxMessage?: string;
  }
): string;
export function notify(
  payload: Omit<NotifyPayload, "message" | "inboxMessage"> & {
    message: Exclude<ReactNode, string>;
    inboxMessage: string;
  }
): string;
export function notify(payload: NotifyPayload): string {
  const priority = payload.priority ?? "high";
  const { placement, correlationId, type, title, message, inboxMessage, context } = payload;

  if (import.meta.env.DEV && typeof message !== "string" && !inboxMessage) {
    // DEV-only API misuse warning. Routing this through the logger would loop
    // back through notify on log failure, so emit straight to the console.
    // eslint-disable-next-line no-console
    console.error(
      "[notify] ReactNode message without inboxMessage — persistent inbox history will be dropped. Provide inboxMessage for WCAG 2.2.1 compliance."
    );
  }

  if (import.meta.env.DEV && payload.transient) {
    // transient bypasses the inbox, so combinations that depend on the inbox
    // as a fallback (priority="low" routes only to inbox; context-suppression
    // promotes the inbox entry on navigate-away) collapse to a silent drop.
    // Surface here so the contradictory shape is caught at write-time.
    if (priority === "low") {
      console.warn(
        "[notify] transient: true with priority: 'low' is a silent no-op — low priority skips the toast and transient skips the inbox."
      );
    }
    if (context) {
      console.warn(
        "[notify] transient: true with context drops the event when the origin surface is visible — the suppression-grace path needs an inbox entry to fall back to."
      );
    }
  }

  const historyMessage = inboxMessage ?? (typeof message === "string" ? message : undefined);

  const allActions = [...(payload.actions ?? []), ...(payload.action ? [payload.action] : [])];

  // Action-bearing toasts persist by default so users can act; toaster's 3s fallback would otherwise dismiss them.
  if (payload.duration === undefined && allActions.length > 0) {
    payload = { ...payload, duration: 0 };
  }

  // Severity-based dismiss defaults. When a toast fires, the persistent inbox is
  // the WCAG 2.2.1 conforming alternative for time-limited content, so
  // error/warning use a generous 12s instead of full sticky to keep the active
  // stack from growing.
  if (payload.duration === undefined) {
    payload = { ...payload, duration: TOAST_DURATION[type] };
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
    const entryId =
      historyMessage && !payload.transient
        ? useNotificationHistoryStore.getState().addEntry({
            type,
            title,
            message: historyMessage,
            correlationId,
            seenAsToast: !isQuiet,
            countable: payload.countable,
            actions: historyActions.length > 0 ? historyActions : undefined,
            context,
            supersedeKey: payload.supersedeKey,
            supersedes: payload.supersedes,
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

  const originVisible = priority === "high" && isFocused && isOriginSurfaceVisible(context);
  const shouldToast = priority === "watch" || (priority === "high" && isFocused && !originVisible);
  const shouldNative = priority === "watch";

  // Per-source rate-limit gate. Only consumes a token (and routes to the
  // overflow summary inbox row) when the notification would actually toast
  // in the current state — blurred/quiet/disabled paths already deliver
  // inbox-only, so rate-limiting them would create a confusing summary row
  // alongside the normal inbox entries it's meant to replace. Bypasses:
  // `transient` (no inbox fallback would silently drop), `urgent` (explicit
  // critical override — `isQuiet` is already false here when `urgent`),
  // and `coalesce` (its own gate over a shorter window). Runs before the
  // history-entry write so overflowed events aren't double-recorded as
  // both an original row and a summary row.
  if (
    shouldToast &&
    notificationsEnabled &&
    !isQuiet &&
    !payload.transient &&
    !payload.urgent &&
    !payload.coalesce &&
    checkAndApplyRateLimit(payload)
  ) {
    return "";
  }

  const historyEntryId =
    historyMessage && !payload.transient
      ? useNotificationHistoryStore.getState().addEntry({
          type,
          title,
          message: historyMessage,
          correlationId,
          seenAsToast: !isQuiet && notificationsEnabled && (shouldToast || originVisible),
          countable: payload.countable,
          actions: historyActions.length > 0 ? historyActions : undefined,
          context,
          supersedeKey: payload.supersedeKey,
          supersedes: payload.supersedes,
        })
      : undefined;

  if (!notificationsEnabled || isQuiet) return "";

  if (shouldNative && historyMessage && typeof window !== "undefined") {
    window.electron?.notification?.showNative?.({
      title: title ?? "Daintree",
      body: historyMessage,
    });
  }

  if (originVisible && historyEntryId) {
    scheduleSuppressionGrace(historyEntryId, payload, priority, context);
    return "";
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
        // Mirror the create-path rule: when the updated toast will be
        // action-bearing, promote it to sticky so the user has time to act.
        // Preserve an explicit caller-supplied duration that differs from the
        // type default — that signals an intentional UX choice.
        const resultingActionsCount =
          (patchAction ? 1 : 0) + (coalesce.buildAction ? 0 : (notification.actions?.length ?? 0));
        const storedDurationIsDefault =
          notification.duration === undefined ||
          notification.duration === TOAST_DURATION[notification.type];
        if (resultingActionsCount > 0 && storedDurationIsDefault) {
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

function scheduleSuppressionGrace(
  historyEntryId: string,
  payload: NotifyPayload,
  priority: NotificationPriority,
  context: NotifyPayload["context"]
): void {
  const subscriber = _activeContextAccessors?.subscribeActiveContext;

  // Replace any prior pending entry for this id (defensive — historyEntryId
  // is a UUID, but cancel-and-replace keeps the invariant clean).
  const prev = _pendingSuppressed.get(historyEntryId);
  if (prev) {
    clearTimeout(prev.timerId);
    prev.unsub();
    _pendingSuppressed.delete(historyEntryId);
  }

  const cleanup = (): void => {
    const entry = _pendingSuppressed.get(historyEntryId);
    if (!entry) return;
    clearTimeout(entry.timerId);
    entry.unsub();
    _pendingSuppressed.delete(historyEntryId);
  };

  const promote = (): void => {
    // Re-read state at callback time to avoid the stale-closure trap (#5087).
    if (isOriginSurfaceVisible(context)) return;
    cleanup();
    if (!useNotificationSettingsStore.getState().enabled) return;
    if (!payload.urgent && (Date.now() < _quietUntil || isScheduledQuietHours())) return;
    useNotificationStore.getState().addNotification({
      ...payload,
      priority,
      historyEntryId,
    });
  };

  const timerId = setTimeout(() => {
    cleanup();
  }, SUPPRESS_GRACE_MS);

  // If no subscriber is registered (very early startup), the timer is the
  // sole gate — falls back to "suppress for 500ms then drop".
  const unsubContext = subscriber ? subscriber(promote) : () => {};

  // Window blur during grace means the user can no longer see the inline
  // affordance, but no worktree/panel state changes to fire `subscriber`.
  // Treat it as navigate-away so the missed signal still surfaces when they
  // come back instead of being silently swallowed with `seenAsToast: true`.
  let unsubBlur = (): void => {};
  if (typeof window !== "undefined") {
    const blurHandler = (): void => promote();
    window.addEventListener("blur", blurHandler);
    unsubBlur = (): void => window.removeEventListener("blur", blurHandler);
  }

  const unsub = (): void => {
    unsubContext();
    unsubBlur();
  };

  _pendingSuppressed.set(historyEntryId, { timerId, unsub });
}
