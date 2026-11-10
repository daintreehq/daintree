import type { SnoozeDurationOption } from "@shared/utils/snoozeTimestamps";
import { cn } from "@/lib/utils";
import { getWorstSeverity } from "@/lib/notificationSeverity";
import { PALETTE_ROW_FOCUS_CLASS } from "@/components/ui/paletteRowStyles";
import { NotificationCenterEntry } from "./NotificationCenterEntry";
import type { ThreadGroup } from "./notificationTriageModel";

export function NotificationThread({
  group,
  onDismiss,
  rowRef,
  tabIndex,
  onRowFocus,
  onDropdownOpenChange,
  isSnoozePending,
  isSnoozed,
  snoozedUntil,
  onConsumeSnoozePending,
  onSnooze,
  onUnsnooze,
  onArchive,
  onToggleRead,
  onRestore,
  grouped = false,
}: {
  group: ThreadGroup;
  grouped?: boolean;
  onDismiss: () => void;
  rowRef?: (el: HTMLDivElement | null) => void;
  tabIndex?: number;
  onRowFocus?: () => void;
  onDropdownOpenChange?: (open: boolean) => void;
  isSnoozePending?: boolean;
  isSnoozed?: boolean;
  snoozedUntil?: number;
  onConsumeSnoozePending?: () => void;
  onSnooze?: (option: SnoozeDurationOption) => void;
  onUnsnooze?: () => void;
  onArchive?: () => void;
  onToggleRead?: () => void;
  onRestore?: () => void;
}) {
  const latest = group.entries[0];
  const isNew = group.entries.some((e) => !e.seenAsToast);

  if (!latest) return null;

  const displayType = getWorstSeverity(group.entries);

  // When the worst-severity icon disagrees with the latest entry's type (e.g.
  // an "error" thread whose newest entry is a "success" recovery), prefix the
  // preview text so the icon/message divergence reads as intentional rather
  // than a mismatch.
  const displayEntry =
    displayType !== latest.type && latest.message.length > 0
      ? { ...latest, message: `Latest: ${latest.message}` }
      : latest;

  return (
    <div
      ref={rowRef}
      tabIndex={tabIndex}
      role="listitem"
      onFocus={onRowFocus}
      data-testid="notification-thread"
      className={cn(
        "group relative",
        // Same treatment as a solo row (NotificationCenterEntry). Both are
        // stops on the same roving-tabindex ring, so they must not focus
        // differently — one outline, one box-shadow ring would read as two
        // kinds of row.
        tabIndex !== undefined && PALETTE_ROW_FOCUS_CLASS,
        tabIndex !== undefined &&
          "focus-visible:bg-overlay-highlight contrast-more:focus-visible:outline-2 forced-colors:focus-visible:outline-2"
      )}
    >
      <NotificationCenterEntry
        entry={displayEntry}
        displayType={displayType}
        threadCount={group.entries.length}
        isNew={isNew}
        onDismiss={onDismiss}
        onDropdownOpenChange={onDropdownOpenChange}
        isSnoozePending={isSnoozePending}
        isSnoozed={isSnoozed}
        snoozedUntil={snoozedUntil}
        onConsumeSnoozePending={onConsumeSnoozePending}
        onSnooze={onSnooze}
        onUnsnooze={onUnsnooze}
        onArchive={onArchive}
        onToggleRead={onToggleRead}
        onRestore={onRestore}
        grouped={grouped}
      />
    </div>
  );
}
