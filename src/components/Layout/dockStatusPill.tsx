import { useCallback, useRef, type ReactNode } from "react";
import { AnimatedLabel } from "@/components/ui/AnimatedLabel";
import { cn } from "@/lib/utils";

/**
 * The status pills sit inside one tray, and the tray is the surface: each pill
 * is a transparent segment of it. That shared, rounder surface is what sets
 * the project-wide cluster apart from the worktree's own chips on the rail.
 * Height tracks the chip height so tray and chips line up at every density.
 */
export const DOCK_STATUS_PILL_CLASS =
  "h-[calc(var(--dock-item-height)-4px)] bg-transparent ring-0 hover:bg-overlay-soft hover:ring-0";

export const DOCK_STATUS_PILL_OPEN_CLASS = "bg-overlay-emphasis text-text-primary";

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
  const markHandoff = useCallback(() => {
    handedOffRef.current = true;
  }, []);
  const onCloseAutoFocus = useCallback((event: Event) => {
    if (!handedOffRef.current) return;
    handedOffRef.current = false;
    event.preventDefault();
  }, []);
  return { markHandoff, onCloseAutoFocus };
}
