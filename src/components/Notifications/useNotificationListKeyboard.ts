import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { NotificationHistoryEntry } from "@/store/slices/notificationHistorySlice";
import { isMac } from "@/lib/platform";
import {
  goToNotificationSource,
  resolveLiveNotificationDestination,
} from "./notificationNavigation";
import { announceTriage } from "./useNotificationRowActions";
import type { FlatRow, NotificationFilter } from "./notificationTriageModel";

/**
 * Why Enter went nowhere. A pointer user sees a row that doesn't dress as a
 * link; from the keyboard the same row just swallowed the key.
 */
function sourceUnreachableMessage(context: NotificationHistoryEntry["context"]): string {
  const destination = resolveLiveNotificationDestination(context);
  if (destination.kind !== "none") return "Couldn't open the source";
  switch (destination.reason) {
    case "other-host":
      return "It came from another machine";
    case "other-project":
      return "Its project is no longer available";
    case "panel-trashed":
      return "Its panel is in the trash";
    case "gone":
      return "Its source is no longer available";
    default:
      return "No source to open";
  }
}

interface NotificationListKeyboardOptions {
  open: boolean;
  filter: NotificationFilter;
  flatRows: FlatRow[];
  /** The panel root: where focus goes on open, and when the last row goes. */
  dialogRef: RefObject<HTMLDivElement | null>;
  archiveRow: (row: FlatRow) => void;
  toggleReadForRow: (row: FlatRow) => void;
  dispatchPrimaryAction: (row: FlatRow) => void;
}

/**
 * The list's roving focus and its keys: j/k and arrows, e/u/h, Enter and
 * Mod+Enter, the hand-off from the panel root into the rows, and recovery when
 * the focused row is replaced. An open row menu suspends all of it.
 */
export function useNotificationListKeyboard({
  open,
  filter,
  flatRows,
  dialogRef,
  archiveRow,
  toggleReadForRow,
  dispatchPrimaryAction,
}: NotificationListKeyboardOptions) {
  const [snoozePendingIndex, setSnoozePendingIndex] = useState<number | null>(null);
  const rowCount = flatRows.length;
  const [focusedIndex, setFocusedIndex] = useState(0);
  // Whether a row has held focus during this opening. Recovery below only runs
  // for a user who was already in the list; it must never pull focus off the
  // bell (or anywhere else) when the panel opens or when rows arrive.
  const rowHadFocusRef = useRef(false);
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const dropdownOpenCountRef = useRef(0);

  const setRowRef = useCallback((index: number, el: HTMLDivElement | null) => {
    if (el) {
      rowRefs.current.set(index, el);
    } else {
      rowRefs.current.delete(index);
    }
  }, []);

  const handleDropdownOpenChange = useCallback((open: boolean) => {
    dropdownOpenCountRef.current = Math.max(0, dropdownOpenCountRef.current + (open ? 1 : -1));
  }, []);

  const handleRowFocus = useCallback((index: number) => {
    rowHadFocusRef.current = true;
    setFocusedIndex(index);
  }, []);

  useEffect(() => {
    if (!open) rowHadFocusRef.current = false;
  }, [open]);

  // After the rows change, clamp focusedIndex; reset the dropdown counter (a
  // row removed mid-menu may never fire onOpenChange(false)); and if focus has
  // dropped to <body> because the focused row just unmounted, put it on the
  // row now in that slot — or on the panel when nothing is left.
  //
  // Keyed on the rows, not their count. Marking a pinned row read with `u`
  // takes it out of the rail and promotes the next severe thread into the
  // same slot, so the count never moves while the focused element is replaced
  // — and the old count gate left focus on <body>, where j/k do nothing.
  useEffect(() => {
    dropdownOpenCountRef.current = 0;
    const clamped = rowCount === 0 ? 0 : Math.min(focusedIndex, rowCount - 1);
    if (clamped !== focusedIndex) setFocusedIndex(clamped);

    if (!rowHadFocusRef.current) return;
    if (typeof document === "undefined") return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    if (rowCount === 0) {
      dialogRef.current?.focus({ preventScroll: true });
      return;
    }
    rowRefs.current.get(clamped)?.focus();
  }, [flatRows, rowCount, focusedIndex, dialogRef]);

  const moveFocusTo = useCallback((index: number) => {
    const target = rowRefs.current.get(index);
    if (target) {
      target.focus();
    }
    setFocusedIndex(index);
  }, []);

  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (dropdownOpenCountRef.current > 0) return;
      if (rowCount === 0) return;

      const active = document.activeElement;
      let activeIndex = -1;
      for (const [idx, el] of rowRefs.current.entries()) {
        if (el === active) {
          activeIndex = idx;
          break;
        }
      }
      if (activeIndex === -1) return;

      switch (e.key) {
        case "j":
        case "ArrowDown": {
          e.preventDefault();
          moveFocusTo(Math.min(activeIndex + 1, rowCount - 1));
          return;
        }
        case "k":
        case "ArrowUp": {
          e.preventDefault();
          moveFocusTo(Math.max(activeIndex - 1, 0));
          return;
        }
        case "Home": {
          e.preventDefault();
          moveFocusTo(0);
          return;
        }
        case "End": {
          e.preventDefault();
          moveFocusTo(rowCount - 1);
          return;
        }
        case "e": {
          if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
          // Nothing in the Archived tab. `e` is learned as archive, and it used
          // to turn into a permanent delete here, so the same key that filed
          // something away destroyed it one tab over. The row's × is the
          // deliberate delete.
          if (filter === "archived") return;
          const row = flatRows[activeIndex];
          if (!row) return;
          e.preventDefault();
          archiveRow(row);
          return;
        }
        case "u": {
          // Linear-parity toggle: flip the focused row between read and
          // unread. Lowercase only — uppercase `U` is reserved for a future
          // bulk action and would conflict with Shift-modified navigation.
          if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
          // Archived rows are filed; the store won't unread them, so the key
          // would do nothing while looking like it should.
          if (filter === "archived") return;
          e.preventDefault();
          const row = flatRows[activeIndex];
          if (!row) return;
          toggleReadForRow(row);
          return;
        }
        case "h": {
          // Linear-parity snooze: open the snooze sub-menu on the focused
          // row. Lowercase only and only for correlated rows (snooze is a
          // thread-level concept). The dropdown-open guard at the top of
          // this handler keeps subsequent j/k from double-navigating.
          if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
          // Filed rows don't snooze; the row menu doesn't offer it either.
          if (filter === "archived") return;
          const row = flatRows[activeIndex];
          if (!row || !row.correlationId) return;
          e.preventDefault();
          setSnoozePendingIndex(activeIndex);
          return;
        }
        case "Enter": {
          const row = flatRows[activeIndex];
          if (!row || e.repeat || e.shiftKey || e.altKey) return;
          // Enter goes where a click goes. The primary action can be a side
          // effect (Retry, Restore), so it moves to Mod+Enter rather than
          // firing on the key everyone presses to open a list item.
          const mod = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
          if (mod) {
            if (!row.primaryAction) return;
            e.preventDefault();
            dispatchPrimaryAction(row);
            return;
          }
          if (e.metaKey || e.ctrlKey) return;
          e.preventDefault();
          void goToNotificationSource(row.context, row.entryId).then((arrived) => {
            if (!arrived) announceTriage(sourceUnreachableMessage(row.context));
          });
          return;
        }
        default:
          return;
      }
    },
    [rowCount, flatRows, moveFocusTo, archiveRow, dispatchPrimaryAction, filter, toggleReadForRow]
  );

  // Take focus into the panel when it opens. The bell keeps `aria-haspopup` and
  // the panel is portalled to the end of `document.body`, so without this the
  // next Tab walks the whole rest of the app instead of entering the surface
  // the user just asked for — the rows are reachable in principle and not in
  // practice. Deliberately the ROOT and not the first row: focusing a row on
  // open is a separate, settled decision (see the row-count effect above) and
  // this leaves it alone.
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus({ preventScroll: true });
  }, [open, dialogRef]);

  // The first arrow press hands off from the panel root into the list. The
  // list's own handler bails unless `document.activeElement` is already a row,
  // so without this bridge a keyboard user who has just opened the panel
  // presses Down and nothing happens.
  const handleDialogKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return;
      if (dropdownOpenCountRef.current > 0) return;
      if (rowCount === 0) return;
      switch (e.key) {
        case "j":
        case "ArrowDown":
        case "Home":
          e.preventDefault();
          moveFocusTo(0);
          return;
        case "k":
        case "ArrowUp":
        case "End":
          e.preventDefault();
          moveFocusTo(rowCount - 1);
          return;
        default:
          return;
      }
    },
    [rowCount, moveFocusTo]
  );

  const consumeSnoozePending = useCallback(() => setSnoozePendingIndex(null), []);

  return {
    focusedIndex,
    setRowRef,
    handleRowFocus,
    handleDropdownOpenChange,
    moveFocusTo,
    handleListKeyDown,
    handleDialogKeyDown,
    snoozePendingIndex,
    consumeSnoozePending,
  };
}
