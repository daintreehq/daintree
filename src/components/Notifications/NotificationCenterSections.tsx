import { useId } from "react";
import { ArrowDown } from "lucide-react";
import type { SnoozeDurationOption } from "@shared/utils/snoozeTimestamps";
import { Button } from "@/components/ui/button";
import { LIST_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { cn } from "@/lib/utils";
import { NotificationCenterEntry } from "./NotificationCenterEntry";
import { NotificationThread } from "./NotificationThread";
import { ContextSectionHeader } from "./ContextSectionHeader";
import {
  buildFlatRow,
  type ContextSection,
  type FlatRow,
  type ThreadGroup,
} from "./notificationTriageModel";

interface RovingSectionProps {
  indexOffset: number;
  focusedIndex: number;
  setRowRef: (index: number, el: HTMLDivElement | null) => void;
  onRowFocus: (index: number) => void;
  onDropdownOpenChange: (open: boolean) => void;
}

export function NeedsAttentionSection({
  groups,
  overflowCount,
  onJumpToOverflow,
  indexOffset,
  focusedIndex,
  setRowRef,
  onRowFocus,
  onDropdownOpenChange,
  onDismiss,
  onDismissThread,
  snoozePendingIndex,
  snoozedThreads,
  snoozeRenderTime,
  onConsumeSnoozePending,
  onSnoozeRow,
  onUnsnoozeRow,
  onArchiveRow,
  onToggleReadRow,
  onRestoreRow,
}: {
  groups: ThreadGroup[];
  /** Severe unread threads beyond the pinned cap — they remain in the chronological list below. */
  overflowCount: number;
  /** Scrolls to and focuses the first overflow row; absent when it isn't in this view. */
  onJumpToOverflow: (() => void) | undefined;
  onDismiss: (id: string) => void;
  onDismissThread: (correlationId: string) => void;
  snoozePendingIndex: number | null;
  snoozedThreads: Record<string, number>;
  snoozeRenderTime: number;
  onConsumeSnoozePending: () => void;
  onSnoozeRow: (row: FlatRow, option: SnoozeDurationOption) => void;
  onUnsnoozeRow: (row: FlatRow) => void;
  onArchiveRow: ((row: FlatRow) => void) | undefined;
  onToggleReadRow: ((row: FlatRow) => void) | undefined;
  onRestoreRow: ((row: FlatRow) => void) | undefined;
} & RovingSectionProps) {
  return (
    <div data-testid="needs-attention-section" className="border-b border-divider">
      <div className={cn(LIST_LABEL_CLASS, "pl-4 pr-3 pt-2 pb-1")}>Needs attention</div>
      <div role="group" aria-label="Needs attention">
        {groups.map((group, idx) => {
          const flatIndex = indexOffset + idx;
          return renderGroup(
            group,
            onDismiss,
            onDismissThread,
            {
              flatIndex,
              focusedIndex,
              setRowRef,
              onRowFocus,
              onDropdownOpenChange,
              grouped: false,
            },
            buildSnoozeProps(
              group,
              flatIndex,
              snoozePendingIndex,
              snoozedThreads,
              snoozeRenderTime,
              {
                onConsumeSnoozePending,
                onSnooze: onSnoozeRow,
                onUnsnooze: onUnsnoozeRow,
                onArchive: onArchiveRow,
                onToggleRead: onToggleReadRow,
                onRestore: onRestoreRow,
              }
            )
          );
        })}
      </div>
      {/* A way to them, not just a count: after the rail stopped repeating
          the list, the overflow rows below looked like any other row. */}
      {overflowCount > 0 && (
        <div className="pl-4 pr-3 pb-2">
          {onJumpToOverflow ? (
            <button
              type="button"
              data-testid="needs-attention-overflow"
              onClick={onJumpToOverflow}
              className={cn(
                // The negative margin keeps the text on the 16px edge at rest;
                // the padding is for when high contrast frames it as a button.
                "-mx-1 inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-1 py-0.5 text-2xs text-text-secondary",
                "hover:text-text-primary transition-colors focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
              )}
            >
              +{overflowCount} more below
              <ArrowDown className="h-3 w-3" aria-hidden="true" />
            </button>
          ) : (
            <span data-testid="needs-attention-overflow" className="text-2xs text-text-secondary">
              +{overflowCount} more below
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function ChronoSection({
  section,
  groupByContext,
  dividerGroupId,
  dividerRef,
  lastClosedAt,
  indexOffset,
  focusedIndex,
  setRowRef,
  onRowFocus,
  onDropdownOpenChange,
  onDismiss,
  onDismissThread,
  onMarkIdsRead,
  snoozePendingIndex,
  snoozedThreads,
  snoozeRenderTime,
  onConsumeSnoozePending,
  onSnoozeRow,
  onUnsnoozeRow,
  onArchiveRow,
  onToggleReadRow,
  onRestoreRow,
  hasPinnedAbove,
}: {
  section: ContextSection;
  groupByContext: boolean;
  dividerGroupId: string | null;
  dividerRef?: (el: HTMLDivElement | null) => void;
  lastClosedAt: number;
  onDismiss: (id: string) => void;
  onDismissThread: (correlationId: string) => void;
  onMarkIdsRead: (ids: string[], options: { resetLastClosed: boolean }) => void;
  snoozePendingIndex: number | null;
  snoozedThreads: Record<string, number>;
  snoozeRenderTime: number;
  onConsumeSnoozePending: () => void;
  onSnoozeRow: (row: FlatRow, option: SnoozeDurationOption) => void;
  onUnsnoozeRow: (row: FlatRow) => void;
  onArchiveRow: ((row: FlatRow) => void) | undefined;
  onToggleReadRow: ((row: FlatRow) => void) | undefined;
  onRestoreRow: ((row: FlatRow) => void) | undefined;
  /**
   * Whether the "Needs attention" rail is rendering above this list. The rail
   * takes its rows out of the list, so the list is the rest of the inbox and
   * says so; without the rail it is the whole inbox and needs no label.
   */
  hasPinnedAbove?: boolean;
} & RovingSectionProps) {
  const sectionUnreadIds = section.groups.flatMap((g) =>
    g.entries.filter((e) => !e.seenAsToast).map((e) => e.id)
  );
  const newSinceUnreadIds = section.groups
    .filter((g) => g.latestTimestamp > lastClosedAt)
    .flatMap((g) => g.entries.filter((e) => !e.seenAsToast).map((e) => e.id));
  const sectionLabel = "Everything else";
  // Grouped, the section's name is its header's — "Notifications for this
  // context" named nothing a screen reader user could tell apart.
  const headerLabelId = useId();
  // Where "new" ends: the first group at or before the watermark, marked only
  // when something newer sits above it in this same section — a section that
  // is all new or all old has no boundary to draw. The divider at the top
  // says where new begins; without this nothing said where it stopped.
  const firstKey = section.groups[0]
    ? (section.groups[0].correlationId ?? section.groups[0].entries[0]!.id)
    : null;
  const opensWithNew =
    lastClosedAt > 0 && !!section.groups[0] && section.groups[0].latestTimestamp > lastClosedAt;
  const earlierGroup = opensWithNew
    ? section.groups.find((g) => g.latestTimestamp <= lastClosedAt)
    : undefined;
  const earlierKey = earlierGroup
    ? (earlierGroup.correlationId ?? earlierGroup.entries[0]!.id)
    : null;
  // The divider already says what this list is, so it stands in for the
  // "All notifications" label rather than stacking a second one on it.
  const dividerLeads = dividerGroupId !== null && dividerGroupId === firstKey;
  return (
    <div data-testid="chrono-section">
      {!groupByContext && hasPinnedAbove && !dividerLeads && (
        <div className={cn(LIST_LABEL_CLASS, "pl-4 pr-3 pt-2 pb-1")}>{sectionLabel}</div>
      )}
      {groupByContext && (
        <ContextSectionHeader
          labelId={headerLabelId}
          worktreeId={section.worktreeId}
          projectId={section.projectId}
          hostName={section.hostName}
          count={section.groups.length}
          newCount={
            lastClosedAt > 0
              ? section.groups.filter((g) => g.latestTimestamp > lastClosedAt).length
              : 0
          }
          unreadIds={sectionUnreadIds}
          onMarkRead={() => onMarkIdsRead(sectionUnreadIds, { resetLastClosed: false })}
        />
      )}
      <div
        role="group"
        aria-label={groupByContext ? undefined : sectionLabel}
        aria-labelledby={groupByContext ? headerLabelId : undefined}
      >
        {section.groups.map((group, idx) => {
          const groupKey = group.correlationId ?? group.entries[0]!.id;
          const isDivider = dividerGroupId !== null && groupKey === dividerGroupId;
          const flatIndex = indexOffset + idx;
          return (
            <div
              key={groupKey}
              // This used to carry `content-visibility: auto` with
              // `contain-intrinsic-size: auto 72px`. Rows here measure 44px to
              // 123.5px, so the 72px placeholder was wrong by up to 71% for
              // every row not yet scrolled into view: scrollHeight was a
              // fiction, the thumb jumped as rows rendered for the first time,
              // and the content below moved while you were scrolling toward it
              // — during the one interaction this panel exists for. The skip
              // was never worth that; the history is capped at 200 entries
              // (MAX_ENTRIES, notificationHistorySlice) which group into fewer
              // rows still, and that is a modest list for a plain container.
              // If this ever profiles badly, the answer is measured virtualization
              // (Virtuoso, as used elsewhere in the app), not a single guessed
              // height standing in for rows that differ by a factor of three.
            >
              {isDivider && (
                <NewSinceLastLookedDivider
                  ref={dividerRef}
                  unreadCount={newSinceUnreadIds.length}
                  onMarkRead={() => onMarkIdsRead(newSinceUnreadIds, { resetLastClosed: true })}
                />
              )}
              {groupKey === earlierKey && (
                <div
                  data-testid="notification-earlier-boundary"
                  className={cn(LIST_LABEL_CLASS, "pl-4 pr-3 pt-2 pb-1")}
                >
                  Earlier
                </div>
              )}
              {renderGroup(
                group,
                onDismiss,
                onDismissThread,
                {
                  flatIndex,
                  focusedIndex,
                  setRowRef,
                  onRowFocus,
                  onDropdownOpenChange,
                  // The section header names the place; the row needn't.
                  grouped: groupByContext,
                },
                buildSnoozeProps(
                  group,
                  flatIndex,
                  snoozePendingIndex,
                  snoozedThreads,
                  snoozeRenderTime,
                  {
                    onConsumeSnoozePending,
                    onSnooze: onSnoozeRow,
                    onUnsnooze: onUnsnoozeRow,
                    onArchive: onArchiveRow,
                    onToggleRead: onToggleReadRow,
                    onRestore: onRestoreRow,
                  }
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface RowRovingProps {
  flatIndex: number;
  focusedIndex: number;
  setRowRef: (index: number, el: HTMLDivElement | null) => void;
  onRowFocus: (index: number) => void;
  onDropdownOpenChange: (open: boolean) => void;
  grouped: boolean;
}

interface SnoozeRowProps {
  isSnoozePending: boolean;
  isSnoozed: boolean;
  snoozedUntil: number | undefined;
  onConsumeSnoozePending: () => void;
  onSnooze: (option: SnoozeDurationOption) => void;
  onUnsnooze: () => void;
  /** The pointer's route to what `e` and `u` do from the keyboard. */
  onArchive: (() => void) | undefined;
  onToggleRead: (() => void) | undefined;
  /** Archive's inverse, offered only in the Archived tab. */
  onRestore: (() => void) | undefined;
}

function renderGroup(
  group: ThreadGroup,
  onDismiss: (id: string) => void,
  onDismissThread: (correlationId: string) => void,
  roving: RowRovingProps,
  snooze: SnoozeRowProps
) {
  const isFocused = roving.flatIndex === roving.focusedIndex;
  const tabIndex = isFocused ? 0 : -1;
  const rowRef = (el: HTMLDivElement | null) => roving.setRowRef(roving.flatIndex, el);
  const handleFocus = () => roving.onRowFocus(roving.flatIndex);

  if (group.correlationId && group.entries.length > 1) {
    return (
      <NotificationThread
        key={group.correlationId}
        group={group}
        onDismiss={() => onDismissThread(group.correlationId!)}
        rowRef={rowRef}
        tabIndex={tabIndex}
        onRowFocus={handleFocus}
        onDropdownOpenChange={roving.onDropdownOpenChange}
        isSnoozePending={snooze.isSnoozePending}
        isSnoozed={snooze.isSnoozed}
        snoozedUntil={snooze.snoozedUntil}
        onConsumeSnoozePending={snooze.onConsumeSnoozePending}
        onSnooze={snooze.onSnooze}
        onUnsnooze={snooze.onUnsnooze}
        onArchive={snooze.onArchive}
        onToggleRead={snooze.onToggleRead}
        onRestore={snooze.onRestore}
        grouped={roving.grouped}
      />
    );
  }
  const entry = group.entries[0]!;
  return (
    <NotificationCenterEntry
      key={entry.id}
      entry={entry}
      isNew={!entry.seenAsToast}
      onDismiss={() => onDismiss(entry.id)}
      rowRef={rowRef}
      tabIndex={tabIndex}
      role="listitem"
      onFocus={handleFocus}
      onDropdownOpenChange={roving.onDropdownOpenChange}
      isSnoozePending={snooze.isSnoozePending}
      isSnoozed={snooze.isSnoozed}
      snoozedUntil={snooze.snoozedUntil}
      onConsumeSnoozePending={snooze.onConsumeSnoozePending}
      onSnooze={snooze.onSnooze}
      onUnsnooze={snooze.onUnsnooze}
      onArchive={snooze.onArchive}
      onToggleRead={snooze.onToggleRead}
      onRestore={snooze.onRestore}
      grouped={roving.grouped}
    />
  );
}

function buildSnoozeProps(
  group: ThreadGroup,
  flatIndex: number,
  snoozePendingIndex: number | null,
  snoozedThreads: Record<string, number>,
  now: number,
  handlers: RowMenuHandlers
): SnoozeRowProps {
  const row = buildFlatRow(group);
  const snoozedUntil = group.correlationId ? snoozedThreads[group.correlationId] : undefined;
  const isSnoozed =
    typeof snoozedUntil === "number" && Number.isFinite(snoozedUntil) && snoozedUntil > now;
  return {
    isSnoozePending: snoozePendingIndex === flatIndex && !!group.correlationId,
    isSnoozed,
    snoozedUntil: isSnoozed ? snoozedUntil : undefined,
    onConsumeSnoozePending: handlers.onConsumeSnoozePending,
    onSnooze: (option) => handlers.onSnooze(row, option),
    onUnsnooze: () => handlers.onUnsnooze(row),
    onArchive: handlers.onArchive ? () => handlers.onArchive?.(row) : undefined,
    onToggleRead: handlers.onToggleRead ? () => handlers.onToggleRead?.(row) : undefined,
    onRestore: handlers.onRestore ? () => handlers.onRestore?.(row) : undefined,
  };
}

interface RowMenuHandlers {
  onConsumeSnoozePending: () => void;
  onSnooze: (row: FlatRow, option: SnoozeDurationOption) => void;
  onUnsnooze: (row: FlatRow) => void;
  /** Absent in the Archived tab, where there is nothing further to archive to. */
  onArchive: ((row: FlatRow) => void) | undefined;
  /** Absent in the Archived tab too: read state doesn't apply to filed rows. */
  onToggleRead: ((row: FlatRow) => void) | undefined;
  /** Present only in the Archived tab. */
  onRestore: ((row: FlatRow) => void) | undefined;
}

function NewSinceLastLookedDivider({
  ref,
  unreadCount,
  onMarkRead,
}: {
  ref?: (el: HTMLDivElement | null) => void;
  unreadCount: number;
  onMarkRead: () => void;
}) {
  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-testid="new-since-last-looked"
      className={cn(
        LIST_LABEL_CLASS,
        "flex items-center gap-2 pl-4 pr-3 py-1 bg-overlay-raised outline-hidden"
      )}
    >
      <span>New since you last looked</span>
      {unreadCount > 0 && (
        <Button
          variant="subtle"
          size="xs"
          onClick={onMarkRead}
          // Bordered like Resume — the panel's one small-button shape. Bare, it
          // was the same grey and size as the label beside it and read as more
          // of the label.
          className="ml-auto shrink-0 px-1.5 text-2xs normal-case tracking-normal focus-visible:-outline-offset-2"
        >
          {unreadCount === 1 ? "Mark this read" : `Mark these ${unreadCount} read`}
        </Button>
      )}
    </div>
  );
}
