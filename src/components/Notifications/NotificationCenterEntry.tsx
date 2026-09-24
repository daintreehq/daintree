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
  Archive,
  Mail,
  MailOpen,
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SNOOZE_DURATION_OPTIONS,
  SNOOZE_LABEL,
  resolveSnoozeDuration,
  type SnoozeDurationOption,
} from "@shared/utils/snoozeTimestamps";
import { useNotificationSource } from "./notificationSource";
import { useProjectSettingsStore } from "@/store/projectSettingsStore";
import { useUIStore } from "@/store/uiStore";

const snoozedUntilFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

const wakeTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/**
 * When a snooze would end, as the picker previews it. A same-day wake is just
 * the time; anything later names the day, because "8:00 AM" alone doesn't say
 * which morning "Until tomorrow" means.
 */
export function formatSnoozeWake(wakeAt: number, now: Date = new Date()): string {
  const target = new Date(wakeAt);
  return target.toDateString() === now.toDateString()
    ? wakeTimeFormatter.format(target)
    : snoozedUntilFormatter.format(target);
}

/** The row's own words, for control names that have to say which row they act on. */
function rowLabel(entry: NotificationHistoryEntry): string {
  if (entry.title) return entry.title;
  const message = typeof entry.message === "string" ? entry.message : "";
  return message.length > 60 ? `${message.slice(0, 57)}…` : message || "notification";
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
  "text-text-secondary transition-colors hover:bg-overlay-soft hover:text-text-primary",
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
  /** Row-menu twins of the list's `e` and `u` keys; absent, the item is too. */
  onArchive?: () => void;
  onToggleRead?: () => void;
  /**
   * False where something above the row already names its project and
   * worktree — a grouped section header — so the row doesn't say it twice.
   */
  showSource?: boolean;
  /**
   * The pinned rail's preview: the title (or, untitled, the message on one
   * line), the source, the recovery actions and the controls, but not the
   * body. The full row sits in the list below, so the rail's job is to name
   * what needs you, not to repeat it at length.
   */
  compact?: boolean;
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
  onArchive,
  onToggleRead,
  showSource = true,
  compact = false,
}: NotificationCenterEntryProps) {
  const config = TYPE_CONFIG[displayType ?? entry.type];
  const Icon = config.icon;
  const source = useNotificationSource(entry.context);
  const label = rowLabel(entry);
  const showSnoozeLine = isSnoozed && snoozedUntil !== undefined;
  const metaSource = showSource ? source : null;
  const showMessage = !compact || !entry.title;

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
        "group flex items-start gap-2 pl-4 pr-3 hover:bg-overlay-subtle transition-colors",
        // The rail is a preview, so it is packed tighter than the list: at the
        // list's rhythm three pinned rows took nearly half the panel before
        // anything that had just arrived.
        compact ? "py-1.5" : "py-2.5",
        // The shared palette-row focus treatment, not a bespoke ring: `outline`
        // survives Windows High Contrast where a box-shadow ring does not, and
        // the offset is negative because this row is full-bleed inside three
        // nested clipping ancestors (ScrollShadow's scrollport and wrapper, and
        // the popover itself), so an outset outline loses all four sides.
        tabIndex !== undefined && PALETTE_ROW_FOCUS_CLASS
      )}
    >
      <div
        className={cn(
          "relative flex w-4 shrink-0 items-center justify-center",
          // Grid row 1 is 24px tall on a titled row — the trailing rail's
          // controls set that height and the title centres inside it. The icon
          // is a flex sibling of that grid rather than a cell in it, so
          // `items-start` parked it at the top of a 16px box and left it 4px
          // above the title it labels. Matching the height and centring in it
          // puts the two on the same optical line. An untitled row has no such
          // cell: its message starts at the top of the track, which is where a
          // top-aligned icon already sits, so that case keeps its natural box.
          entry.title ? "h-6" : "h-4",
          config.className
        )}
      >
        {/* The dot is aria-hidden, so unread was carried by nothing but colour
            and a heavier title weight — neither of which reaches a screen
            reader. First in the row's DOM order, which is where it reads. */}
        {isNew && <span className="sr-only">Unread. </span>}
        <Icon className="h-4 w-4" />
        {/* The unread dot badges the status icon's top-right corner rather than
            floating in the row's left gutter, where it sat 3px off the icon and
            7px off the panel edge — closer to the chrome than to the thing it
            marked, and on the icon's own centre line, so it read as part of the
            glyph. Straddling the corner it belongs to the icon unambiguously
            and costs no horizontal space, so read rows still carry no spacer.

            The ring is not decoration: the corner of a 16px Lucide circle
            (CheckCircle2, XCircle, Info) passes under this dot, so without a
            cut-out in the row's own backdrop the two silhouettes merge. It has
            to be a flat colour — `.surface-overlay` is 94% + backdrop-blur, and
            a translucent ring would show the desktop through it. */}
        {isNew && (
          <span
            aria-hidden="true"
            // The attribute is not styling — it is the handle the
            // `forced-colors: active` block in index.css repaints, the same way
            // ActivityLight's dot is handled. Without it the UA forces this
            // background to Canvas and the dot disappears, and an unread row
            // carries no border or tint by design, so an untitled one was left
            // with no unread signal at all. The ring below needs a counterpart
            // in that block: it is a box-shadow, forced colors does not paint
            // box-shadows, and the icon this dot now overlaps is flattened to
            // the same CanvasText — so the cut-out is re-declared there as an
            // outline.
            data-notification-unread="true"
            className={cn(
              "absolute right-0 h-1.5 w-1.5 translate-x-1/3 -translate-y-1/3 rounded-full",
              "bg-status-info ring-[1.5px] ring-[var(--overlay-surface-solid)]",
              // Anchored to the icon box, not the wrapper: on a titled row the
              // wrapper is 4px taller than the glyph at each end.
              entry.title ? "top-1" : "top-0"
            )}
          />
        )}
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
                  "shrink-0 rounded-full bg-tint/15 px-1.5 py-0.5 text-3xs font-medium leading-none text-text-secondary tabular-nums min-w-[2.5ch] text-center",
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
        {showMessage && (
          <p
            className={cn(
              "text-xs text-text-secondary leading-snug",
              compact ? "truncate" : "break-words",
              entry.title ? "col-span-2 row-start-2" : "col-start-1 row-start-1 min-w-0"
            )}
          >
            {entry.message}
          </p>
        )}
        {showChip && !entry.title && (
          <span
            key={bumpKey}
            aria-label={formatNotificationCountAriaLabel(safeCount)}
            data-notification-count="true"
            style={{ animationDuration: `${DURATION_150}ms` }}
            className={cn(
              "col-span-2 row-start-2 mt-0.5 justify-self-start rounded-full bg-tint/15 px-1.5 py-0.5 text-3xs font-medium leading-none text-text-secondary tabular-nums min-w-[2.5ch] text-center",
              bumpKey > 0 && "animate-badge-bump"
            )}
          >
            {formatNotificationCountGlyph(safeCount)}
          </span>
        )}
        {/* Where it came from, and on a snoozed row when it comes back: quiet
            lines under the message rather than more weight on the title line.
            At fleet volume "Tests failed" is only half a fact until it says
            which worktree. They get a line each; side by side, the source was
            truncated to a fragment on the one tab that shows both. */}
        {showSnoozeLine && (
          <p
            data-testid="notification-snoozed-indicator"
            className="col-span-2 row-start-3 mt-0.5 flex items-center gap-1 text-2xs text-text-secondary"
          >
            <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
            Snoozed until {formatSnoozeWake(snoozedUntil)}
          </p>
        )}
        {metaSource && (
          <p
            data-testid="notification-source"
            title={metaSource}
            className={cn(
              "col-span-2 mt-0.5 min-w-0 truncate text-2xs text-text-secondary",
              showSnoozeLine ? "row-start-4" : "row-start-3"
            )}
          >
            {metaSource}
          </p>
        )}
        {entry.actions && entry.actions.length > 0 && (
          <div
            className={cn(
              "col-span-2 row-start-5 flex flex-wrap gap-1.5",
              compact ? "mt-1" : "mt-1.5"
            )}
          >
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
                        ? "border border-border-strong text-text-secondary hover:bg-overlay-medium"
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
                      : "border border-border-subtle text-text-muted cursor-not-allowed"
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
        {/* `min-h-6` and `self-start` pin the first line to 24px and hold the
            rail on it: the icon opposite is centred against that height, and an
            untitled row whose message wraps must not drag the controls down to
            the middle of the block they act on. */}
        <div
          className={cn(
            "col-start-2 row-start-1 flex min-h-6 items-center self-start gap-1.5",
            // An untitled row's first line is its message, 16.5px of text-xs
            // against this 24px rail. Pulling the rail up and down by 4px puts
            // its centre on that line instead of 4px below it.
            !entry.title && "-my-1"
          )}
        >
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
            rowLabel={label}
            onDropdownOpenChange={onDropdownOpenChange}
            isSnoozePending={isSnoozePending}
            isSnoozed={isSnoozed}
            snoozedUntil={snoozedUntil}
            onConsumeSnoozePending={onConsumeSnoozePending}
            onSnooze={onSnooze}
            onUnsnooze={onUnsnooze}
            isRead={!isNew}
            onArchive={onArchive}
            onToggleRead={onToggleRead}
          />
          {onDismiss && (
            <button
              type="button"
              aria-label={`Dismiss ${label}`}
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

/**
 * The silence and mute actions write the project's settings file, and the
 * silence tells no renderer store at all, so the inbox's quiet strip kept
 * describing the state from before the click until the panel reopened.
 */
function refreshProjectOverrides(projectId: string | undefined): void {
  if (!projectId) return;
  void useProjectSettingsStore.getState().loadNotificationOverridesForProjects([projectId]);
}

interface RowOptionsMenuProps {
  entry: NotificationHistoryEntry;
  rowLabel: string;
  onDropdownOpenChange?: (open: boolean) => void;
  isSnoozePending: boolean;
  isSnoozed: boolean;
  snoozedUntil: number | undefined;
  onConsumeSnoozePending?: () => void;
  onSnooze?: (option: SnoozeDurationOption) => void;
  onUnsnooze?: () => void;
  isRead: boolean;
  onArchive?: () => void;
  onToggleRead?: () => void;
}

function RowOptionsMenu({
  entry,
  rowLabel,
  onDropdownOpenChange,
  isSnoozePending,
  isSnoozed,
  snoozedUntil,
  onConsumeSnoozePending,
  onSnooze,
  onUnsnooze,
  isRead,
  onArchive,
  onToggleRead,
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
  const hasTriageActions = !!onToggleRead || !!onArchive;
  const hasActions =
    hasTriageActions || hasContextActions || supportsSnooze || hasDiagnosticsActions;
  const [open, setOpen] = useState(false);
  // `h` asks for the snooze durations, not the whole menu, so it opens a menu
  // of just those. A controlled submenu opened in the same frame as its parent
  // never mounted, and the programmatic open left focus on <body>.
  const [snoozeOnly, setSnoozeOnly] = useState(false);
  const menuContentRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Set when `h` opened the menu. That path started on the ROW, and the list's
  // keys only move between rows, so an Escape that handed focus to this
  // trigger (the default) left the user outside j/k.
  const openedFromRowRef = useRef(false);
  // Opened from the keyboard with nothing under the pointer, so focus goes on
  // the first duration explicitly. Radix's own open focus left it on <body>
  // for a programmatic open. One frame later so it lands after Radix's.
  useEffect(() => {
    if (!open || !snoozeOnly) return;
    const frame = requestAnimationFrame(() => {
      menuContentRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, snoozeOnly]);
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
    setSnoozeOnly(!isSnoozed);
    openedFromRowRef.current = true;
    setOpen(true);
    onDropdownOpenChange?.(true);
    onConsumeSnoozePending?.();
  }, [isSnoozePending, supportsSnooze, isSnoozed, onConsumeSnoozePending, onDropdownOpenChange]);

  if (!hasActions) return null;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setSnoozeOnly(false);
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
    // The one row-menu item that takes you somewhere else. The inbox used to
    // close under it only because any menu pick counted as a click outside.
    useUIStore.getState().closeNotificationCenter();
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

  const durationItems = SNOOZE_DURATION_OPTIONS.map((option) => (
    <DropdownMenuItem
      key={option}
      onSelect={() => {
        onSnooze?.(option);
      }}
    >
      {SNOOZE_LABEL[option]}
      {/* The commitment, before it's made: "Until tomorrow" is 8:00 AM, and
          "Until next week" is Monday. */}
      <span className="ml-auto pl-6 text-text-secondary tabular-nums">
        {formatSnoozeWake(resolveSnoozeDuration(option))}
      </span>
    </DropdownMenuItem>
  ));

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          ref={triggerRef}
          aria-label={`Options for ${rowLabel}`}
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
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        className="min-w-[200px] max-w-[280px]"
        ref={menuContentRef}
        onCloseAutoFocus={(event) => {
          if (!openedFromRowRef.current) return;
          openedFromRowRef.current = false;
          const row = triggerRef.current?.closest('[role="listitem"]');
          // A snooze removes the row; the list's own recovery then picks the
          // neighbour. Only a cancel finds the row still here.
          if (row instanceof HTMLElement) {
            event.preventDefault();
            row.focus({ preventScroll: true });
          }
        }}
      >
        {snoozeOnly ? (
          <>
            <DropdownMenuLabel>Snooze</DropdownMenuLabel>
            {durationItems}
          </>
        ) : (
          <>
            {/* Triage first — the same verbs, and the same keys, as the list:
                without these a pointer user could only read or archive one
                notification by learning `u` and `e`, or by doing it to all. */}
            {onToggleRead && (
              <DropdownMenuItem onSelect={onToggleRead}>
                {isRead ? (
                  <Mail data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <MailOpen data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                )}
                {isRead ? "Mark as unread" : "Mark as read"}
                <DropdownMenuShortcut aria-hidden="true">U</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}
            {onArchive && (
              <DropdownMenuItem onSelect={onArchive}>
                <Archive data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                Archive
                <DropdownMenuShortcut aria-hidden="true">E</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}
            {supportsSnooze &&
              (isSnoozed ? (
                <DropdownMenuItem
                  onSelect={() => {
                    onUnsnooze?.();
                  }}
                >
                  <Clock data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  {snoozedUntil !== undefined
                    ? `Snoozed until ${formatSnoozeWake(snoozedUntil)} · Unsnooze`
                    : "Unsnooze"}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Clock data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                    Snooze
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>{durationItems}</DropdownMenuSubContent>
                </DropdownMenuSub>
              ))}
            {(hasTriageActions || supportsSnooze) &&
              (hasDiagnosticsActions || hasContextActions) && <DropdownMenuSeparator />}
            {supportsCopyCorrelationId && (
              <DropdownMenuItem onSelect={handleCopyCorrelationId}>
                <Copy data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                Copy correlation ID
              </DropdownMenuItem>
            )}
            {supportsGoToSource && (
              <DropdownMenuItem onSelect={handleGoToSource}>
                <ArrowRight data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
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
                <Bug data-menu-icon className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                Report on GitHub
              </DropdownMenuItem>
            )}
            {hasDiagnosticsActions && hasContextActions && <DropdownMenuSeparator />}
            {isNotificationEventKind(eventKind) && (
              <DropdownMenuItem
                onSelect={() => {
                  const projectId = entry.context?.projectId;
                  if (!isNotificationEventKind(eventKind)) return;
                  void actionService
                    .dispatch("project.silenceNotificationKind", { kind: eventKind, projectId })
                    .then(() => refreshProjectOverrides(projectId));
                }}
              >
                {/* No shim. The gutter these two need in a menu that also offers
                Snooze / Copy / Report is allocated by the `:has([data-menu-icon])`
                rule in index.css, and withdrawn when every icon-bearing item is
                filtered out — an entry with no correlationId and no panelId
                leaves only these, and with no projectId either, only this one. */}
                Silence {EVENT_KIND_LABEL[eventKind]}
                {entry.context?.projectId && eventKind !== "uiFeedback" ? " from this project" : ""}
              </DropdownMenuItem>
            )}
            {entry.context?.projectId && (
              <DropdownMenuItem
                onSelect={() => {
                  const projectId = entry.context?.projectId;
                  if (!projectId) return;
                  void actionService
                    .dispatch("project.muteNotifications", { projectId })
                    .then(() => refreshProjectOverrides(projectId));
                }}
              >
                Mute project notifications
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
