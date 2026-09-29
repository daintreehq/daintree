import { forwardRef, useCallback, useEffect, useRef, type ReactNode } from "react";
import { AnimatedLabel } from "@/components/ui/AnimatedLabel";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { POPOVER_HEADER_CLASS, POPOVER_ROW_HOVER_CLASS } from "@/components/ui/popoverHeader";
import { cn } from "@/lib/utils";

/**
 * The status pills sit inside one tray, and the tray is the surface: each pill
 * is a transparent segment of it. That shared, rounder surface is what sets
 * the project-wide cluster apart from the worktree's own chips on the rail.
 * Height tracks the chip height so tray and chips line up at every density.
 */
export const DOCK_STATUS_PILL_CLASS =
  "h-[calc(var(--dock-item-height)-4px)] bg-transparent ring-0 hover:bg-[var(--dock-item-bg-hover)] hover:ring-0";

/**
 * The popover-open state, shared in spirit with the chips'
 * (`DOCK_CHIP_OPEN_CLASS`): a neutral lift, never accent. Repeated under
 * `hover:` so pointing at an open pill keeps it open-looking.
 */
export const DOCK_STATUS_PILL_OPEN_CLASS =
  "bg-overlay-emphasis hover:bg-overlay-emphasis text-text-primary";

/** The title strip above a status popover's list: the app-wide popover header. */
export const DOCK_POPOVER_HEADER_CLASS = POPOVER_HEADER_CLASS;

/** Hover on a status popover row, the same in all four popovers and every other popover list. */
export const DOCK_POPOVER_ROW_HOVER_CLASS = POPOVER_ROW_HOVER_CLASS;

interface DockStatusPillLabelProps {
  icon: ReactNode;
  label: string;
  count: number;
  /** A qualifier on the count ("1 waiting"), dropped along with the label word. */
  detail?: ReactNode;
  /**
   * Some of the count is in the active worktree. Carried by the count's tone
   * alone — bright when it touches this worktree, the label's quieter tone
   * when it is all elsewhere — so scope costs no width and no extra mark. The
   * exact split lives in the name, the tooltip, and the popover's sections.
   */
  hasLocal?: boolean;
  compact: boolean;
}

/**
 * Glyph, word, count, qualifier — in that order on every pill. When the dock
 * runs short of width, or the user picks compact density, the word and the
 * qualifier go and the count stays beside its glyph, never on top of it.
 */
export function DockStatusPillLabel({
  icon,
  label,
  count,
  detail,
  hasLocal = false,
  compact,
}: DockStatusPillLabelProps) {
  const condensable = "@max-[64rem]/dock:hidden";
  return (
    <>
      {icon}
      {!compact && <span className={cn("font-medium", condensable)}>{label}</span>}
      <span
        data-dock-pill-local={hasLocal ? "" : undefined}
        // Without a local share the count inherits the pill's own tone, so it
        // lifts with the label on hover and open instead of lagging behind it.
        className={cn("font-medium tabular-nums", hasLocal && "text-text-primary")}
      >
        <AnimatedLabel label={String(count)} />
      </span>
      {!compact && detail && (
        <span className={cn("tabular-nums text-text-secondary", condensable)}>· {detail}</span>
      )}
    </>
  );
}

/**
 * One section of a status popover's list — "This worktree", then "Other
 * worktrees". Every popover splits the same way, so the pill's project-wide
 * count always opens onto the same answer to "which of these is here".
 */
export function DockPopoverSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 flex-col gap-px">
      <div
        className="flex h-5 items-center px-2 text-3xs font-medium text-text-secondary"
        aria-hidden="true"
      >
        {label}
      </div>
      {children}
    </div>
  );
}

export const DOCK_POPOVER_SECTIONS = [
  { key: "here", label: "This worktree" },
  { key: "elsewhere", label: "Other worktrees" },
] as const;

/** "across all worktrees", with the local share when there is one. */
export function dockStatusScopeDescription(total: number, here: number): string {
  if (here === 0) return "across all worktrees, none in this one";
  if (here === total) return "across all worktrees, all in this one";
  return `across all worktrees, ${here} in this one`;
}

const ROW_SELECTOR = "[data-dock-row]";
const CONTROL_SELECTOR = "button:not([disabled])";

function rowsOf(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(ROW_SELECTOR));
}

/** A row's own controls, not those of a row nested inside it (a group's members). */
function controlsOf(row: HTMLElement): HTMLElement[] {
  // A row may itself be the button (Errors), or hold several.
  if (row.matches(CONTROL_SELECTOR)) return [row];
  return Array.from(row.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).filter(
    (control) => control.closest(ROW_SELECTOR) === row
  );
}

function targetOf(row: HTMLElement): HTMLElement | undefined {
  const controls = controlsOf(row);
  return controls.find((control) => control.hasAttribute("data-dock-row-target")) ?? controls[0];
}

/**
 * The list's one Tab stop: the control focus was last in, else the first row's
 * primary control. Everything else is `tabindex="-1"` and reached with the
 * arrows — Up/Down between rows, Left/Right across a row's own buttons.
 */
function applyStop(list: HTMLElement, active: HTMLElement | undefined) {
  const rows = rowsOf(list);
  const controls = rows.flatMap(controlsOf);
  const stop = active && controls.includes(active) ? active : rows[0] && targetOf(rows[0]);
  for (const control of controls) control.tabIndex = control === stop ? 0 : -1;
}

/**
 * Keyboard model for a status popover's list, after the NotificationCenter
 * popover: the list is one Tab stop, Up/Down/Home/End move between rows (onto
 * each row's primary control), and Left/Right move between a row's own
 * controls. Rows mark themselves `data-dock-row`; a row whose first control is
 * not its primary one marks that control `data-dock-row-target`.
 *
 * Applied imperatively against the live DOM, like `useToolbarRoving`: rows are
 * grouped, collapsible and expire on their own clock, and a pass after every
 * commit always sees the list that actually exists.
 */
function DockPopoverListNavigation({ listRef }: { listRef: React.RefObject<HTMLElement | null> }) {
  const activeControlRef = useRef<HTMLElement | undefined>(undefined);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const focused =
      document.activeElement instanceof HTMLElement && list.contains(document.activeElement)
        ? document.activeElement
        : undefined;
    applyStop(list, focused ?? activeControlRef.current);
  });
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    // A pointer click focuses whichever control it hit; the stop follows it so
    // Tab never leaves focus on an untabbable control.
    const handleFocusIn = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      if (!event.target.closest(ROW_SELECTOR) || !list.contains(event.target)) return;
      activeControlRef.current = event.target;
      applyStop(list, event.target);
    };
    list.addEventListener("focusin", handleFocusIn);
    return () => list.removeEventListener("focusin", handleFocusIn);
  }, [listRef]);
  return null;
}

/** Focus a list row's primary control: the first or last row. */
export function focusDockPopoverRow(list: HTMLElement | null, which: "first" | "last"): boolean {
  if (!list) return false;
  const rows = rowsOf(list);
  const row = which === "first" ? rows[0] : rows[rows.length - 1];
  const target = row && targetOf(row);
  if (!target) return false;
  target.focus();
  return true;
}

export function handleDockPopoverListKeyDown(event: React.KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const list = event.currentTarget;
  const origin = event.target;
  // React bubbles portalled content (a row's context menu) through this
  // handler; only keys from the list's own DOM are the list's to move.
  if (!(origin instanceof HTMLElement) || !list.contains(origin)) return;
  const row = origin.closest<HTMLElement>(ROW_SELECTOR);
  if (!row) return;
  const rows = rowsOf(list);
  const index = rows.indexOf(row);
  let next: HTMLElement | undefined;
  switch (event.key) {
    case "ArrowDown":
      next = targetOf(rows[Math.min(index + 1, rows.length - 1)]!);
      break;
    case "ArrowUp":
      next = targetOf(rows[Math.max(index - 1, 0)]!);
      break;
    case "Home":
      next = targetOf(rows[0]!);
      break;
    case "End":
      next = targetOf(rows[rows.length - 1]!);
      break;
    case "ArrowRight":
    case "ArrowLeft": {
      const controls = controlsOf(row);
      const at = controls.indexOf(origin);
      if (at === -1) return;
      const step = event.key === "ArrowRight" ? 1 : -1;
      next = controls[Math.min(Math.max(at + step, 0), controls.length - 1)];
      break;
    }
    default:
      return;
  }
  event.preventDefault();
  next?.focus();
}

interface DockPopoverListProps {
  children: ReactNode;
  onFocusCapture?: React.FocusEventHandler<HTMLDivElement>;
}

/**
 * A status popover's scrolling list. One height cap and one overflow cue for
 * all four popovers: the cap never runs past the room the popover actually has
 * above the dock, and the compact scroll shadow says there is more above or
 * below when macOS hides the scrollbar.
 */
export const DockPopoverList = forwardRef<HTMLDivElement, DockPopoverListProps>(
  function DockPopoverList({ children, onFocusCapture }, forwardedRef) {
    const listRef = useRef<HTMLDivElement | null>(null);
    const setRef = useCallback(
      (node: HTMLDivElement | null) => {
        listRef.current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef]
    );
    return (
      <ScrollShadow
        compact
        ref={setRef}
        data-dock-popover-list=""
        onKeyDown={handleDockPopoverListKeyDown}
        onFocusCapture={onFocusCapture}
        scrollClassName="flex max-h-[min(360px,calc(var(--radix-popover-content-available-height)-5rem))] flex-col gap-1 p-1"
      >
        <DockPopoverListNavigation listRef={listRef} />
        {children}
      </ScrollShadow>
    );
  }
);

/**
 * Close-time focus for a status popover. Activating a row hands focus to the
 * panel it opens, so that close must not pull focus back to the pill; every
 * other close (Escape, click away, a button in the body) is left to the
 * Popover primitive's shared policy, which restores the way the close asked
 * for. Suppressing every close, as these popovers used to, stranded a keyboard
 * user on `document.body` after Escape.
 */
export function useDockPopoverFocusHandoff() {
  const handedOffRef = useRef(false);
  const openedFromKeyboardRef = useRef(false);
  const markHandoff = useCallback(() => {
    handedOffRef.current = true;
  }, []);
  const onCloseAutoFocus = useCallback((event: Event) => {
    if (!handedOffRef.current) return;
    handedOffRef.current = false;
    event.preventDefault();
  }, []);
  /** On the pill: a keyboard activation fires `click` with `detail === 0`. */
  const onTriggerClick = useCallback((event: { detail: number }) => {
    openedFromKeyboardRef.current = event.detail === 0;
  }, []);
  /**
   * A pointer open leaves focus on the pill, as it always has. A keyboard open
   * takes focus to the popover itself, as NotificationCenter does — otherwise
   * the popover is portalled to the end of the document and the next Tab walks
   * the rest of the app instead of entering it. The root, not the first row:
   * the arrows (see `onContentKeyDown`) take it into the list.
   */
  const onOpenAutoFocus = useCallback((event: Event) => {
    event.preventDefault();
    if (!openedFromKeyboardRef.current) return;
    openedFromKeyboardRef.current = false;
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.focus({ preventScroll: true });
    }
  }, []);
  /** From the popover root, the first arrow press enters the list. */
  const onContentKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const list = event.currentTarget.querySelector<HTMLElement>("[data-dock-popover-list]");
    let which: "first" | "last";
    switch (event.key) {
      case "ArrowDown":
      case "Home":
        which = "first";
        break;
      case "ArrowUp":
      case "End":
        which = "last";
        break;
      default:
        return;
    }
    if (focusDockPopoverRow(list, which)) event.preventDefault();
  }, []);
  return { markHandoff, onCloseAutoFocus, onTriggerClick, onOpenAutoFocus, onContentKeyDown };
}
