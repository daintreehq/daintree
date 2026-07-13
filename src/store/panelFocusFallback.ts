import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

/**
 * Whether a panel is one the user can actually see and type into right now:
 * laid out in the grid of the active worktree. Legacy rows carry no `location`
 * and are grid panels by omission.
 *
 * This is the eligibility half of every focus fallback — the panel a hidden or
 * removed pane can safely hand the keyboard to. Docked panels are excluded even
 * when their popover is open: the popover is a transient surface, and handing
 * focus back to one that is closing is the bug this guards against (#11133).
 */
export function isVisibleGridPanel(panel: CarrierPanel, activeWorktreeId: string | null): boolean {
  if (panel.location && panel.location !== "grid") return false;
  return (panel.worktreeId ?? undefined) === (activeWorktreeId ?? undefined);
}

/**
 * Where focus goes when the open dock panel is dismissed while holding it.
 *
 * `previousFocusedId` is preferred because `openDockTerminal` records the pane
 * the user came from, which makes the round trip exact — and, when the grid is
 * maximized, that pane is the maximized target, so the choice stays visible
 * without the picker having to know about maximize state at all.
 */
export function pickDockCloseFocusId(options: {
  panels: CarrierPanel[];
  activeWorktreeId: string | null;
  previousFocusedId: string | null;
}): string | null {
  const visible = options.panels.filter((panel) =>
    isVisibleGridPanel(panel, options.activeWorktreeId)
  );
  const previous = visible.find((panel) => panel.id === options.previousFocusedId);
  return previous?.id ?? visible[0]?.id ?? null;
}
