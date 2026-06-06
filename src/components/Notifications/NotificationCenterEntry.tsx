import { useEffect, useRef, useState, type Ref } from "react";
import {
  CheckCircle2,
  XCircle,
  Info,
  AlertTriangle,
  Clock,
  MoreHorizontal,
  X,
  Copy,
  Bug,
  ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import { actionService } from "@/services/ActionService";
import { EVENT_KIND_LABEL, isNotificationEventKind, notify } from "@/lib/notify";
import type { ActionId } from "@shared/types/actions";
import type { NotificationType } from "@/store/notificationStore";
import { DURATION_250 } from "@/lib/animationUtils";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import {
  formatNotificationCountAriaLabel,
  formatNotificationCountGlyph,
} from "./notificationCount";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SNOOZE_DURATION_OPTIONS,
  SNOOZE_LABEL,
  type SnoozeDurationOption,
} from "@shared/utils/snoozeTimestamps";

const snoozedUntilFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

function formatSnoozedUntil(snoozedUntil: number): string {
  const target = new Date(snoozedUntil);
  return snoozedUntilFormatter.format(target);
}

const TYPE_CONFIG = {
  success: { icon: CheckCircle2, className: "text-status-success" },
  error: { icon: XCircle, className: "text-status-error" },
  info: { icon: Info, className: "text-status-info" },
  warning: { icon: AlertTriangle, className: "text-status-warning" },
};

const yesterdayTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const sameYearFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const priorYearFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const absoluteFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "full",
  timeStyle: "short",
});

function formatNotificationTimestamp(timestamp: number): {
  label: string;
  absolute: string;
} {
  const now = new Date();
  const date = new Date(timestamp);
  const absolute = absoluteFormatter.format(date);

  if (date.toDateString() === now.toDateString()) {
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    if (seconds < 60) return { label: "just now", absolute };
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return { label: `${minutes}m ago`, absolute };
    const hours = Math.floor(minutes / 60);
    return { label: `${hours}h ago`, absolute };
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return { label: `Yesterday ${yesterdayTimeFormatter.format(date)}`, absolute };
  }

  if (date.getFullYear() === now.getFullYear()) {
    return { label: sameYearFormatter.format(date), absolute };
  }

  return { label: priorYearFormatter.format(date), absolute };
}

interface NotificationCenterEntryProps {
  entry: NotificationHistoryEntry;
  displayType?: NotificationType;
  threadCount?: number;
  isNew?: boolean;
  onDismiss?: () => void;
  rowRef?: Ref<HTMLDivElement>;
  tabIndex?: number;
  role?: string;
  onFocus?: () => void;
  onDropdownOpenChange?: (open: boolean) => void;
  /**
   * When true, the parent (NotificationCenter) is requesting that the snooze
   * picker open programmatically for this row — set by the `h` keybinding.
   * The row consumes the request via `onConsumeSnoozePending` after opening
   * so the same flag doesn't reopen the menu on subsequent renders.
   */
  isSnoozePending?: boolean;
  isSnoozed?: boolean;
  snoozedUntil?: number;
  onConsumeSnoozePending?: () => void;
  onSnooze?: (option: SnoozeDurationOption) => void;
  onUnsnooze?: () => void;
}

export function NotificationCenterEntry({
  entry,
  displayType,
  threadCount,
  isNew = false,
  onDismiss,
  rowRef,
  tabIndex,
  role,
  onFocus,
  onDropdownOpenChange,
  isSnoozePending = false,
  isSnoozed = false,
  snoozedUntil,
  onConsumeSnoozePending,
  onSnooze,
  onUnsnooze,
}: NotificationCenterEntryProps) {
  const config = TYPE_CONFIG[displayType ?? entry.type];
  const Icon = config.icon;

  const showChip =
    typeof threadCount === "number" && Number.isFinite(threadCount) && threadCount > 1;
  // Leading-edge throttle: bump the chip's React `key` to remount the span and
  // restart the CSS animation, but suppress re-fires within DURATION_250 so
  // chatty agent-state churn (#6427) doesn't strobe the chip. The displayed
  // count still updates immediately — only the animation trigger is gated.
  const safeCount = threadCount ?? 0;
  const lastCountRef = useRef(safeCount);
  const lastBumpTimeRef = useRef(0);
  const [bumpKey, setBumpKey] = useState(0);
  useEffect(() => {
    if (safeCount <= lastCountRef.current) {
      lastCountRef.current = safeCount;
      return;
    }
    lastCountRef.current = safeCount;
    const now = Date.now();
    if (now - lastBumpTimeRef.current < DURATION_250) return;
    lastBumpTimeRef.current = now;
    setBumpKey((k) => k + 1);
  }, [safeCount]);

  return (
    <div
      ref={rowRef}
      tabIndex={tabIndex}
      role={role}
      onFocus={onFocus}
      className={cn(
        "group flex items-start gap-2 px-3 py-2.5 hover:bg-overlay-raised transition-colors",
        tabIndex !== undefined &&
          "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-daintree-accent/50"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "w-1.5 shrink-0 self-start mt-1.5",
          isNew && "h-1.5 rounded-full bg-status-info"
        )}
      />
      <div className={cn("mt-0.5 shrink-0", config.className)}>
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        {entry.title && (
          <div className="flex items-center gap-1.5">
            <p
              className={cn(
                "text-xs text-daintree-text truncate",
                isNew ? "font-semibold" : "font-normal"
              )}
            >
              {entry.title}
            </p>
            {showChip && (
              <span
                key={bumpKey}
                aria-label={formatNotificationCountAriaLabel(safeCount)}
                style={{ animationDuration: "150ms" }}
                className={cn(
                  "shrink-0 rounded-full bg-tint/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-daintree-text/60 tabular-nums min-w-[2.5ch] text-center",
                  bumpKey > 0 && "animate-badge-bump"
                )}
              >
                {formatNotificationCountGlyph(safeCount)}
              </span>
            )}
          </div>
        )}
        <p className="text-xs text-daintree-text/70 leading-snug break-words">{entry.message}</p>
        {showChip && !entry.title && (
          <span
            key={bumpKey}
            aria-label={formatNotificationCountAriaLabel(safeCount)}
            style={{ animationDuration: "150ms" }}
            className={cn(
              "mt-0.5 inline-block rounded-full bg-tint/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-daintree-text/60 tabular-nums min-w-[2.5ch] text-center",
              bumpKey > 0 && "animate-badge-bump"
            )}
          >
            {formatNotificationCountGlyph(safeCount)}
          </span>
        )}
        {entry.actions && entry.actions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {entry.actions.map((action, index) => {
              const manifest = actionService.get(action.actionId as ActionId);
              const isAvailable = manifest !== null && manifest.enabled;
              return (
                <button
                  key={`${action.actionId}-${index}`}
                  type="button"
                  aria-disabled={!isAvailable || undefined}
                  title={
                    !isAvailable ? (manifest?.disabledReason ?? "Action unavailable") : undefined
                  }
                  onClick={
                    isAvailable
                      ? () =>
                          void actionService.dispatch(
                            action.actionId as ActionId,
                            action.actionArgs
                          )
                      : undefined
                  }
                  className={cn(
                    "h-6 rounded-[var(--radius-sm)] px-2 text-[11px] font-medium transition-colors",
                    isAvailable
                      ? action.variant === "secondary"
                        ? "border border-daintree-text/20 text-daintree-text/70 hover:bg-overlay-medium"
                        : "border border-status-info/30 bg-status-info/15 text-status-info hover:bg-status-info/20"
                      : "border border-daintree-text/10 text-daintree-text/30 cursor-not-allowed"
                  )}
                >
                  {action.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-1.5 mt-0.5">
        {(() => {
          const ts = formatNotificationTimestamp(entry.timestamp);
          return (
            <span
              data-testid="notification-timestamp"
              title={ts.absolute}
              aria-label={ts.absolute}
              className="text-[10px] text-daintree-text/40 tabular-nums"
            >
              {ts.label}
            </span>
          );
        })()}
        <RowOptionsMenu
          entry={entry}
          onDropdownOpenChange={onDropdownOpenChange}
          isSnoozePending={isSnoozePending}
          isSnoozed={isSnoozed}
          snoozedUntil={snoozedUntil}
          onConsumeSnoozePending={onConsumeSnoozePending}
          onSnooze={onSnooze}
          onUnsnooze={onUnsnooze}
        />
        {isSnoozed && snoozedUntil !== undefined && (
          <span
            data-testid="notification-snoozed-indicator"
            title={`Snoozed until ${formatSnoozedUntil(snoozedUntil)}`}
            aria-label={`Snoozed until ${formatSnoozedUntil(snoozedUntil)}`}
            className="inline-flex h-4 w-4 items-center justify-center text-daintree-text/40"
          >
            <Clock className="h-3 w-3" aria-hidden="true" />
          </span>
        )}
        {onDismiss && (
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            className="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-has-[:focus-visible]:opacity-100 focus:opacity-100 h-4 w-4 flex items-center justify-center rounded text-daintree-text/40 hover:text-daintree-text/70 transition-opacity"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

interface RowOptionsMenuProps {
  entry: NotificationHistoryEntry;
  onDropdownOpenChange?: (open: boolean) => void;
  isSnoozePending: boolean;
  isSnoozed: boolean;
  snoozedUntil: number | undefined;
  onConsumeSnoozePending?: () => void;
  onSnooze?: (option: SnoozeDurationOption) => void;
  onUnsnooze?: () => void;
}

function RowOptionsMenu({
  entry,
  onDropdownOpenChange,
  isSnoozePending,
  isSnoozed,
  snoozedUntil,
  onConsumeSnoozePending,
  onSnooze,
  onUnsnooze,
}: RowOptionsMenuProps) {
  const eventKind = entry.context?.eventKind;
  const hasContextActions = isNotificationEventKind(eventKind) || !!entry.context?.projectId;
  const supportsSnooze = !!entry.correlationId && !!onSnooze;
  const messageString = typeof entry.message === "string" ? entry.message : "";
  // Diagnostics affordances. "Report on GitHub" is restricted to error/warning
  // entries so the inbox isn't a vector for filing noise issues on success
  // toasts; correlation ID is still required so reviewers have a join key.
  const supportsCopyCorrelationId = !!entry.correlationId;
  const supportsReportOnGitHub =
    !!entry.correlationId && (entry.type === "error" || entry.type === "warning");
  const supportsGoToSource = !!entry.context?.panelId;
  const hasDiagnosticsActions =
    supportsCopyCorrelationId || supportsReportOnGitHub || supportsGoToSource;
  const hasActions = hasContextActions || supportsSnooze || hasDiagnosticsActions;
  const [open, setOpen] = useState(false);
  const { copy: copyCorrelationId } = useCopyWithFeedback({
    announcement: "Correlation ID copied",
  });
  const [reportInFlight, setReportInFlight] = useState(false);

  // Programmatic open from the parent's `h` keybinding. Open exactly once
  // per pending request and consume the flag in the same effect so the menu
  // doesn't re-open on subsequent renders.
  useEffect(() => {
    if (!isSnoozePending) return;
    if (!supportsSnooze) {
      onConsumeSnoozePending?.();
      return;
    }
    setOpen(true);
    onConsumeSnoozePending?.();
  }, [isSnoozePending, supportsSnooze, onConsumeSnoozePending]);

  if (!hasActions) return null;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onDropdownOpenChange?.(next);
  };

  const handleCopyCorrelationId = () => {
    if (!entry.correlationId) return;
    void copyCorrelationId(entry.correlationId);
  };

  const handleGoToSource = () => {
    const panelId = entry.context?.panelId;
    if (!panelId) return;
    // panel.focus throws "Terminal panel no longer exists" for evicted panels.
    // Swallow silently — the inbox keeps stale rows after the source goes
    // away and forcing a toast on every dead-link click would be noise.
    void actionService.dispatch("panel.focus", { panelId }).catch(() => undefined);
  };

  const handleReportOnGitHub = async () => {
    if (reportInFlight) return;
    if (!entry.correlationId) return;
    if (entry.type !== "error" && entry.type !== "warning") return;
    setReportInFlight(true);
    try {
      // Lazy-load the report-flow dependencies so they stay off the boot
      // path — appClient + buildNotificationReportUrl + logger together push
      // the renderer eager-import count past budget when imported statically.
      const [{ appClient }, { buildNotificationReportUrl }, { logError }] = await Promise.all([
        import("@/clients/appClient"),
        import("@/components/ErrorBoundary/buildReportIssueUrl"),
        import("@/utils/logger"),
      ]);
      let envInfo: Awaited<ReturnType<typeof appClient.getVersionInfo>>;
      try {
        envInfo = await appClient.getVersionInfo();
      } catch (envError) {
        logError("Failed to load version info for inbox report", envError);
        envInfo = { appVersion: "unknown", electron: "unknown", chrome: "unknown", os: "unknown" };
      }

      const reportMessage =
        entry.title && messageString
          ? `${entry.title} — ${messageString}`
          : entry.title || messageString || "Notification";

      const { url, fullBody, usedClipboardFallback } = buildNotificationReportUrl({
        correlationId: entry.correlationId,
        message: reportMessage,
        notificationType: entry.type,
        context: entry.context,
        envInfo,
      });

      if (usedClipboardFallback) {
        const writeText = window.electron?.clipboard?.writeText;
        let clipboardOk = false;
        if (writeText) {
          try {
            await writeText(fullBody);
            clipboardOk = true;
          } catch (clipboardError) {
            logError("Failed to copy notification report to clipboard", clipboardError);
          }
        }
        if (clipboardOk) {
          notify({
            type: "info",
            title: "Report details copied",
            message:
              "The full notification report was copied to your clipboard — paste it into the issue body.",
            transient: true,
            priority: "high",
            context: { eventKind: "uiFeedback" },
          });
        } else {
          notify({
            type: "info",
            title: "Report too long to send",
            message:
              "Couldn't copy the full report. Quote the correlation ID when filing the issue.",
            inboxMessage: "Couldn't copy notification report to clipboard.",
            priority: "high",
            context: { eventKind: "uiFeedback" },
          });
        }
      }

      if (!window.electron?.system?.openExternal) return;
      try {
        const result = await actionService.dispatch(
          "system.openExternal",
          { url },
          { source: "user" }
        );
        if (!result.ok) {
          await window.electron.system.openExternal(url);
        }
      } catch (dispatchError) {
        logError("Failed to open notification report URL", dispatchError);
      }
    } catch (reportError) {
      // buildNotificationReportUrl can surface URIError (lone surrogates in
      // title/message) and JSON.stringify can surface TypeError (circular
      // refs / BigInt in context). Without this catch the rejection escapes
      // the `void handleReportOnGitHub()` site as an unhandled promise.

      console.warn("Failed to build notification report", reportError);
    } finally {
      setReportInFlight(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Notification options"
          onClick={(e) => e.stopPropagation()}
          className="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-has-[:focus-visible]:opacity-100 focus:opacity-100 data-[state=open]:opacity-100 h-4 w-4 flex items-center justify-center rounded text-daintree-text/40 hover:text-daintree-text/70 transition-opacity"
        >
          <MoreHorizontal className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4}>
        {supportsSnooze &&
          (isSnoozed ? (
            <DropdownMenuItem
              onSelect={() => {
                onUnsnooze?.();
              }}
            >
              <Clock className="mr-2 h-3 w-3" aria-hidden="true" />
              {snoozedUntil !== undefined
                ? `Snoozed until ${formatSnoozedUntil(snoozedUntil)} · Unsnooze`
                : "Unsnooze"}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Clock className="mr-2 h-3 w-3" aria-hidden="true" />
                Snooze
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {SNOOZE_DURATION_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option}
                    onSelect={() => {
                      onSnooze?.(option);
                    }}
                  >
                    {SNOOZE_LABEL[option]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}
        {supportsSnooze && hasDiagnosticsActions && <DropdownMenuSeparator />}
        {supportsCopyCorrelationId && (
          <DropdownMenuItem onSelect={handleCopyCorrelationId}>
            <Copy className="mr-2 h-3 w-3" aria-hidden="true" />
            Copy correlation ID
          </DropdownMenuItem>
        )}
        {supportsGoToSource && (
          <DropdownMenuItem onSelect={handleGoToSource}>
            <ArrowRight className="mr-2 h-3 w-3" aria-hidden="true" />
            Go to source
          </DropdownMenuItem>
        )}
        {supportsReportOnGitHub && (
          <DropdownMenuItem
            disabled={reportInFlight}
            onSelect={() => {
              void handleReportOnGitHub();
            }}
          >
            <Bug className="mr-2 h-3 w-3" aria-hidden="true" />
            Report on GitHub
          </DropdownMenuItem>
        )}
        {hasDiagnosticsActions && hasContextActions && <DropdownMenuSeparator />}
        {!hasDiagnosticsActions && supportsSnooze && hasContextActions && <DropdownMenuSeparator />}
        {isNotificationEventKind(eventKind) && (
          <DropdownMenuItem
            onSelect={() => {
              const projectId = entry.context?.projectId;
              if (!isNotificationEventKind(eventKind)) return;
              void actionService.dispatch("project.silenceNotificationKind", {
                kind: eventKind,
                projectId,
              });
            }}
          >
            Silence {EVENT_KIND_LABEL[eventKind]}
            {entry.context?.projectId && eventKind !== "uiFeedback" ? " from this project" : ""}
          </DropdownMenuItem>
        )}
        {entry.context?.projectId && (
          <DropdownMenuItem
            onSelect={() => {
              const projectId = entry.context?.projectId;
              if (!projectId) return;
              void actionService.dispatch("project.muteNotifications", { projectId });
            }}
          >
            Mute project notifications
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
