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
import { PALETTE_ROW_FOCUS_CLASS } from "@/components/ui/paletteRowStyles";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import { actionService } from "@/services/ActionService";
import { EVENT_KIND_LABEL, isNotificationEventKind, notify } from "@/lib/notify";
import type { ActionId } from "@shared/types/actions";
import type { NotificationType } from "@/store/notificationStore";
import { DURATION_150, DURATION_250 } from "@/lib/animationUtils";
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

/**
 * The row's two management controls. 24x24 rather than the previous 16x16:
 * WCAG 2.2 SC 2.5.8 wants 24 CSS px, and the old pair sat 22px apart, so it
 * cleared neither the size rule nor the spacing exemption. It is also the size
 * the toast uses for this same notification content, and the dominant size for
 * row controls across the app. They had no focus ring at all before.
 */
const ROW_CONTROL_CLASS = cn(
  "h-6 w-6 shrink-0 flex items-center justify-center rounded-[var(--radius-sm)]",
  "text-text-muted transition-colors hover:bg-overlay-soft hover:text-text-primary",
  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2",
  "focus-visible:outline-accent-primary focus-visible:text-text-primary"
);

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
        "group flex items-start gap-2 px-3 py-2.5 hover:bg-overlay-subtle transition-colors",
        // The shared palette-row focus treatment, not a bespoke ring: `outline`
        // survives Windows High Contrast where a box-shadow ring does not, and
        // the offset is negative because this row is full-bleed inside three
        // nested clipping ancestors (ScrollShadow's scrollport and wrapper, and
        // the popover itself), so an outset outline loses all four sides.
        tabIndex !== undefined && PALETTE_ROW_FOCUS_CLASS
      )}
    >
      <div className={cn("relative shrink-0", config.className)}>
        {/* The unread dot floats in the row's px-3 gutter (absolute, anchored
            to the icon) so read rows don't carry a phantom spacer column and
            the icon shares the 12px gutter with the header and section labels. */}
        {isNew && (
          <span
            aria-hidden="true"
            // The attribute is not styling — it is the handle the
            // `forced-colors: active` block in index.css repaints, the same way
            // ActivityLight's dot is handled. Without it the UA forces this
            // background to Canvas and the dot disappears, and an unread row
            // carries no border or tint by design, so an untitled one was left
            // with no unread signal at all.
            data-notification-unread="true"
            className="absolute right-full mr-[3px] top-1/2 -translate-y-1/2 h-1.5 w-1.5 rounded-full bg-status-info"
          />
        )}
        <Icon className="h-4 w-4" />
      </div>
      <div className="grid flex-1 min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-2">
        {entry.title && (
          <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-1.5">
            <p
              className={cn(
                "text-xs text-text-primary truncate",
                isNew ? "font-semibold" : "font-normal"
              )}
            >
              {entry.title}
            </p>
            {showChip && (
              <span
                key={bumpKey}
                aria-label={formatNotificationCountAriaLabel(safeCount)}
                // Handle for the forced-colors repaint — the tint fill is forced
                // to Canvas there, leaving a bare numeral that reads as part of
                // the title.
                data-notification-count="true"
                style={{ animationDuration: `${DURATION_150}ms` }}
                className={cn(
                  "shrink-0 rounded-full bg-tint/15 px-1.5 py-0.5 text-3xs font-medium leading-none text-daintree-text/60 tabular-nums min-w-[2.5ch] text-center",
                  bumpKey > 0 && "animate-badge-bump"
                )}
              >
                {formatNotificationCountGlyph(safeCount)}
              </span>
            )}
          </div>
        )}
        {/* A titled row's message spans both columns on row 2, under the rail,
            so it gets the full width. An untitled row has nothing else to put
            on row 1, so the message takes that cell instead — otherwise the
            rail sits alone against an empty gutter and the row wastes a line.
            It wraps inside column 1 there, which costs nothing at the widths
            this popover actually uses: the rail is about 100px for a relative
            stamp, and a message long enough to wrap at 210px was already
            wrapping at 312px. */}
        <p
          className={cn(
            "text-xs text-daintree-text/70 leading-snug break-words",
            entry.title ? "col-span-2 row-start-2" : "col-start-1 row-start-1 min-w-0"
          )}
        >
          {entry.message}
        </p>
        {showChip && !entry.title && (
          <span
            key={bumpKey}
            aria-label={formatNotificationCountAriaLabel(safeCount)}
            data-notification-count="true"
            style={{ animationDuration: `${DURATION_150}ms` }}
            className={cn(
              "col-span-2 row-start-2 mt-0.5 justify-self-start rounded-full bg-tint/15 px-1.5 py-0.5 text-3xs font-medium leading-none text-daintree-text/60 tabular-nums min-w-[2.5ch] text-center",
              bumpKey > 0 && "animate-badge-bump"
            )}
          >
            {formatNotificationCountGlyph(safeCount)}
          </span>
        )}
        {entry.actions && entry.actions.length > 0 && (
          <div className="col-span-2 row-start-4 mt-1.5 flex flex-wrap gap-1.5">
            {entry.actions.map((action, index) => {
              const manifest = actionService.get(action.actionId as ActionId);
              const isAvailable = manifest !== null && manifest.enabled;
              return (
                <button
                  key={`${action.actionId}-${index}`}
                  type="button"
                  // Handle for the `forced-colors: active` block in index.css.
                  // Primary is marked by its status-info fill and border, and
                  // the UA flattens both — so "Pull and rebase" and "Open
                  // review" render as the same white pill and the recommended
                  // action stops being recommended. Same fix as the destructive
                  // button in that block: a heavier border.
                  data-notification-action={
                    action.variant === "secondary" ? "secondary" : "primary"
                  }
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
                    "h-6 rounded-[var(--radius-sm)] px-2 text-2xs font-medium transition-colors",
                    isAvailable
                      ? action.variant === "secondary"
                        ? "border border-daintree-text/20 text-text-secondary hover:bg-overlay-medium"
                        : // The primary used to ink its label from `status-info`,
                          // which `shared/theme/contrast.ts` only gates at 3:1 —
                          // no body-text guarantee. It measured 4.46:1 against
                          // its own fill while the secondary beside it measured
                          // 7.6:1, so the button with primary chrome read as the
                          // weaker, near-disabled one, and `prefers-contrast:
                          // more` lifted the secondary and left it behind. Keep
                          // status-info as the fill and border (that is what
                          // marks it primary) and take the label from the gated
                          // text ramp.
                          "border border-status-info/30 bg-status-info/15 text-text-primary hover:bg-status-info/20"
                      : "border border-daintree-text/10 text-text-muted cursor-not-allowed"
                  )}
                >
                  {action.label}
                </button>
              );
            })}
          </div>
        )}
        {/* One stable rail — the row's trailing metadata and management
            controls, held in a grid cell rather than an overlay or a float.

            The old build cross-faded the metadata out and covered it with an
            absolutely positioned layer carrying its own `bg-overlay-raised`
            fill, so time — the orientation cue the inbox exists to provide —
            vanished at exactly the moment the user was inspecting the row, and
            on the Snoozed tab took the snooze state with it. It was also the
            only metadata-covering action layer in the app. Now nothing moves
            and nothing is covered: the controls hold their place at every
            state, quiet at rest and stronger under the pointer, which is the
            treatment the worktree card's action toolbar already uses here.
            Keeping them in flow is what makes them reachable on a touch screen,
            where there is no hover to reveal anything.

            Grid, not a flex sibling and not a float. A flex sibling subtracts
            its width from every line of the row rather than the one it sits on,
            which cost the default message a line and the dense one two. A float
            fixes that but has to precede the content it shifts, which put the
            management controls ahead of the title, message and recovery actions
            in DOM order — so tabbing reached Dismiss before "Pull and rebase",
            and a screen reader read the metadata before the event. Explicit
            grid placement gets both: this rail is last in the DOM and reads
            last, but paints in row 1's trailing column, and the message and
            actions below it span the full width. */}
        <div className="col-start-2 row-start-1 flex items-center gap-1.5">
          {isSnoozed && snoozedUntil !== undefined && (
            <>
              <span
                data-testid="notification-snoozed-indicator"
                title={`Snoozed until ${formatSnoozedUntil(snoozedUntil)}`}
                aria-label={`Snoozed until ${formatSnoozedUntil(snoozedUntil)}`}
                className="inline-flex h-4 w-4 items-center justify-center text-text-secondary"
              >
                <Clock className="h-3 w-3" aria-hidden="true" />
              </span>
              {/* The clock means "snoozed until later"; the stamp beside it means
                  "arrived at". Abutting they read as one fact, so they get a
                  separator. */}
              <span aria-hidden="true" className="text-3xs leading-none text-daintree-text/40">
                ·
              </span>
            </>
          )}
          {(() => {
            const ts = formatNotificationTimestamp(entry.timestamp);
            return (
              <span
                data-testid="notification-timestamp"
                title={ts.absolute}
                aria-label={ts.absolute}
                // A solid token, not `text-daintree-text/40`: slash-alpha
                // composites against whatever is behind it and read at ~3.2:1
                // here. `theme-tokens.md` gates `text-secondary` at >=3:1 across
                // every theme and prefers a solid token for exactly this.
                className="text-3xs text-text-secondary tabular-nums"
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
          {onDismiss && (
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={(e) => {
                e.stopPropagation();
                onDismiss();
              }}
              className={ROW_CONTROL_CLASS}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Module-level so the try/catch/finally and awaited import() expressions stay
// outside RowOptionsMenu — both bail React Compiler memoization for the
// per-row component.
async function reportNotificationOnGitHub(
  entry: NotificationHistoryEntry,
  messageString: string
): Promise<void> {
  const correlationId = entry.correlationId;
  if (!correlationId) return;
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
      envInfo = {
        appVersion: "unknown",
        electron: "unknown",
        chrome: "unknown",
        os: "unknown",
        arch: "unknown",
      };
    }

    const reportMessage =
      entry.title && messageString
        ? `${entry.title} — ${messageString}`
        : entry.title || messageString || "Notification";

    const { url, fullBody, usedClipboardFallback } = buildNotificationReportUrl({
      correlationId,
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
          message: "Couldn't copy the full report. Quote the correlation ID when filing the issue.",
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
    // the fire-and-forget call site as an unhandled promise.

    console.warn("Failed to build notification report", reportError);
  }
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

  const handleReportOnGitHub = () => {
    if (reportInFlight) return;
    if (!entry.correlationId) return;
    if (entry.type !== "error" && entry.type !== "warning") return;
    setReportInFlight(true);
    void reportNotificationOnGitHub(entry, messageString).finally(() => {
      setReportInFlight(false);
    });
  };

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Notification options"
          onClick={(e) => e.stopPropagation()}
          // `data-[state=open]` so the trigger reads as pressed while its menu
          // is up — the repo's standard open-row cue. Without it nothing said
          // which of the two controls opened the menu.
          className={cn(ROW_CONTROL_CLASS, "data-[state=open]:bg-overlay-raised")}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      {/* Bounded on both sides, matching the panel-header and docked-tab menus:
          a floor so short items do not collapse it, and a ceiling so it cannot
          end up wider than the 360px popover it belongs to — it was overlaying
          three rows of the inbox behind it. */}
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-[200px] max-w-[280px]">
        {supportsSnooze &&
          (isSnoozed ? (
            <DropdownMenuItem
              onSelect={() => {
                onUnsnooze?.();
              }}
            >
              <Clock className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
              {snoozedUntil !== undefined
                ? `Snoozed until ${formatSnoozedUntil(snoozedUntil)} · Unsnooze`
                : "Unsnooze"}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Clock className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
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
            <Copy className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            Copy correlation ID
          </DropdownMenuItem>
        )}
        {supportsGoToSource && (
          <DropdownMenuItem onSelect={handleGoToSource}>
            <ArrowRight className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
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
            <Bug className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
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
            <span className="ml-[1.375rem]">
              Silence {EVENT_KIND_LABEL[eventKind]}
              {entry.context?.projectId && eventKind !== "uiFeedback" ? " from this project" : ""}
            </span>
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
            <span className="ml-[1.375rem]">Mute project notifications</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
