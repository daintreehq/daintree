import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { FolderX, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store/panelStore";
import {
  getDeletedWorktreeTerminalIds,
  useWorktreeSelectionStore,
  type DeletedWorktree,
} from "@/store/worktreeStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useTerminalPendingDestructiveActionStore } from "@/store/terminalPendingDestructiveActionStore";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";
import { useWorktreeTerminals } from "@/hooks/useWorktreeTerminals";
import { WorktreeTerminalSection } from "@/components/Worktree/WorktreeCard/WorktreeTerminalSection";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";

interface DeletedWorktreeCardProps {
  worktree: DeletedWorktree;
  /**
   * Grouped cards hide their own trash button (#11260) — the group's single
   * bulk clear replaces N per-row ones, which is the point of grouping. A
   * standalone card keeps it.
   */
  showDismissAction?: boolean;
}

/**
 * Sidebar row for a worktree whose directory is gone but whose terminals are
 * still running (#11232).
 *
 * Shares the live card's design language on purpose: same header scale, the
 * same `WorktreeTerminalSection` (collapsed "N active" bar with waiting
 * indicators, expandable rows, drag handles), and the same select-on-click
 * behaviour — activating it shows its surviving terminals in the grid/dock.
 * What marks it as deleted is the `FolderX` icon, the badge, the struck-through
 * path, and a slight fade. It deliberately does *not* use
 * `SortableWorktreeCard`, which is what registers a card as a drop target via
 * `type: "worktree"` drag data — a deleted worktree must never accept
 * terminals, and omitting that wrapper excludes it by construction rather than
 * by a flag `DndProvider` would have to check.
 */
export function DeletedWorktreeCard({
  worktree,
  showDismissAction = true,
}: DeletedWorktreeCardProps) {
  const panelsById = usePanelStore((s) => s.panelsById);
  const panelIdsByWorktreeId = usePanelStore((s) => s.panelIdsByWorktreeId);
  const setFocused = usePanelStore((s) => s.setFocused);
  const openDockTerminal = usePanelStore((s) => s.openDockTerminal);
  const pingTerminal = usePanelStore((s) => s.pingTerminal);
  const requestDestructiveAction = useTerminalPendingDestructiveActionStore((s) => s.request);
  const dismissDeletedWorktree = useWorktreeSelectionStore((s) => s.dismissDeletedWorktree);
  const isActive = useWorktreeSelectionStore((s) => s.activeWorktreeId === worktree.id);
  const selectWorktree = useWorktreeSelectionStore((s) => s.selectWorktree);
  const trackTerminalFocus = useWorktreeSelectionStore((s) => s.trackTerminalFocus);
  const isTerminalsExpanded = useWorktreeSelectionStore((s) =>
    s.expandedTerminals.has(worktree.id)
  );
  const toggleTerminalsExpanded = useWorktreeSelectionStore((s) => s.toggleTerminalsExpanded);

  const { counts, terminals } = useWorktreeTerminals(worktree.id);

  // Auto-cleanup countdown (deletedWorktreeCleanup.ts owns the deadline; this
  // is display only): a numeric seconds readout in the header plus the row's
  // own bottom separator draining from full width to empty. Both hold at full
  // while the sweep defers the deadline (drag in progress, agent still
  // working, confirm dialog open).
  const cleanupSeconds = usePreferencesStore((s) => s.deletedWorktreeCleanupSeconds);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const expiresAt = worktree.expiresAt;
  const hasCountdown = expiresAt !== null && cleanupSeconds > 0;
  useVisibilityAwareInterval(() => setNowTick(Date.now()), 1000, hasCountdown);
  // The sweep (which re-extends the deadline while deferred) and this tick run
  // on independent 1s phases — clamp remaining to the TTL (no "61s" flicker)
  // and snap the top ~1.5s to exactly full so a paused bar holds steady
  // instead of sawtoothing between full and full-minus-a-tick.
  const cleanupMs = cleanupSeconds * 1000;
  const rawRemainingMs = expiresAt !== null ? Math.max(0, expiresAt - nowTick) : 0;
  const remainingMs = cleanupMs > 0 ? Math.min(rawRemainingMs, cleanupMs) : rawRemainingMs;
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const remainingFraction = hasCountdown
    ? remainingMs >= cleanupMs - 1500
      ? 1
      : Math.min(1, remainingMs / cleanupMs)
    : 0;

  const panels = useMemo(() => {
    void panelIdsByWorktreeId;
    return getDeletedWorktreeTerminalIds(worktree.id)
      .map((id) => panelsById[id])
      .filter((panel): panel is PanelInstance => panel != null);
  }, [worktree.id, panelsById, panelIdsByWorktreeId]);

  const handleDismiss = useCallback(() => {
    if (panels.length === 0) {
      // Nothing left to confirm — the pruning subscription is about to drop
      // this row anyway, but dismissing directly keeps the button honest.
      dismissDeletedWorktree(worktree.id);
      return;
    }
    requestDestructiveAction({
      kind: "deletedWorktreeDismiss",
      targetCount: panels.length,
      runningAgentCount: panels.filter((panel) => deriveTerminalChrome(panel).isAgent).length,
      worktreeId: worktree.id,
    });
  }, [panels, worktree.id, requestDestructiveAction, dismissDeletedWorktree]);

  // `source: "focus"` — viewing a ghost row is an incidental, session-only
  // selection. The user-source path would persist the deleted id as the
  // durable restore target, and after a restart (deletedWorktrees is
  // in-memory only) panel restoration would re-home surviving sessions onto
  // an id with neither a live worktree nor a ghost row.
  const handleSelect = useCallback(() => {
    selectWorktree(worktree.id, { source: "focus" });
  }, [selectWorktree, worktree.id]);

  // Mirrors WorktreeCard's handleTerminalSelect: activate this worktree first
  // so the grid/dock (both filtered by activeWorktreeId) can actually show the
  // terminal, then focus and ping it.
  const handleTerminalSelect = useCallback(
    (terminal: PtyPanelData) => {
      if (!isActive) {
        if (terminal.worktreeId) {
          trackTerminalFocus(terminal.worktreeId, terminal.id);
        }
        selectWorktree(worktree.id, { source: "focus" });
      }
      if (terminal.location === "dock") {
        openDockTerminal(terminal.id);
      } else {
        setFocused(terminal.id);
      }
      pingTerminal(terminal.id);
    },
    [
      isActive,
      trackTerminalFocus,
      selectWorktree,
      worktree.id,
      openDockTerminal,
      setFocused,
      pingTerminal,
    ]
  );

  const handleToggleTerminals = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      toggleTerminalsExpanded(worktree.id);
    },
    [toggleTerminalsExpanded, worktree.id]
  );

  // Defensive: the store prunes empty deleted-worktree rows, so an empty row should never
  // reach render. Bailing keeps a torn frame from showing a zero-terminal card.
  if (panels.length === 0) return null;

  const noun = panels.length === 1 ? "terminal" : "terminals";
  const closeLabel = `Close ${panels.length} ${noun}`;

  return (
    <div
      data-deleted-worktree-id={worktree.id}
      className="sidebar-worktree-card group/card relative isolate transition-colors duration-150"
      data-active={isActive ? "true" : undefined}
      data-hoverable={!isActive ? "true" : undefined}
      aria-label={`Deleted worktree: ${worktree.title}`}
      onClick={handleSelect}
    >
      <button
        type="button"
        data-card-select-overlay=""
        // Unlike the live card's overlay (allowlisted in the focus-ring
        // contract), this card has no focusable parent row owning keyboard
        // nav — the overlay button IS the keyboard path, so it carries its
        // own inset focus ring.
        className="absolute inset-0 z-0 outline-hidden focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-daintree-accent"
        aria-label={`Select deleted worktree: ${worktree.title}`}
      />
      <div
        className={cn(
          // The fade is the "this worktree is gone" signal; it lifts on hover,
          // focus, and while active so the card stays fully usable. Left
          // padding matches live sidebar rows' drag-handle gutter (w-4 + pl-1)
          // so the icon sits exactly in line with live branch icons.
          "relative z-10 pl-5 pr-4 py-3 transition-opacity duration-150",
          !isActive && "opacity-70 group-hover/card:opacity-100 group-focus-within/card:opacity-100"
        )}
      >
        {/* Mirrors WorktreeHeader's title row: same row height, and the same
            icon size/stroke/gap/typography as BranchLabel, with FolderX in
            the branch-type icon's slot. */}
        <div className="flex items-center gap-2 min-h-[22px]">
          <span className="flex items-center gap-1.5 min-w-0 flex-1">
            <FolderX
              className="w-3.5 h-3.5 text-text-muted shrink-0"
              strokeWidth={2.5}
              aria-hidden="true"
            />
            <span
              className="truncate font-mono text-[11px] font-medium text-text-muted"
              title={worktree.title}
            >
              {worktree.title}
            </span>
            <span className="shrink-0 rounded-full bg-overlay-soft px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
              Deleted
            </span>
          </span>
          <div className="flex items-center gap-2 shrink-0">
            {hasCountdown && (
              <span
                className="font-mono text-[11px] tabular-nums text-text-muted"
                title={`Closes automatically in ${remainingSeconds}s`}
                data-testid="deleted-worktree-countdown-seconds"
              >
                {remainingSeconds}s
              </span>
            )}
            {showDismissAction && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDismiss();
                    }}
                    className="sidebar-action-button shrink-0 p-1.5 -my-1.5 text-status-error/70 hover:text-status-error rounded transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent"
                    aria-label={closeLabel}
                  >
                    <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{closeLabel}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
        <div className="truncate text-xs text-text-muted line-through mt-0.5" title={worktree.path}>
          {worktree.path}
        </div>
        <WorktreeTerminalSection
          worktreeId={worktree.id}
          isExpanded={isTerminalsExpanded}
          counts={counts}
          terminals={terminals}
          onToggle={handleToggleTerminals}
          onTerminalSelect={handleTerminalSelect}
        />
      </div>
      {/* The row separator and the countdown are one element, not two stacked
          ones (#11262). A `border-b` on this card paints at the border-box edge
          while an absolutely positioned bar resolves `bottom-0` against the
          *padding* edge — offset by exactly the border width, which read as a
          doubled rule. So this track owns the bottom edge outright: it is the
          separator when unarmed, and the fill drains along it when armed.
          Nudging the bar by a negative offset instead would only line up
          coincidentally, and re-break under sub-pixel rounding at fractional
          DPR.

          It stays above the interaction plane on purpose. Behind it (`-z-10`)
          the overlay button's bottom edge would cover it in contrast modes,
          where every button picks up a 1px/2px border (`src/index.css`
          forced-colors and prefers-contrast blocks) — the separator would
          disappear for exactly the users the forced-colors fallback below is
          meant to serve. The cost is that it clips the outermost pixel of that
          button's inset focus ring along the bottom; the ring stays visible on
          all four sides, and the armed countdown already did this before
          #11262. No `title` either: a 1px decorative strip is an unhittable
          hover target, and the seconds readout in the header already owns that
          tooltip. */}
      <div
        className="deleted-worktree-separator pointer-events-none absolute inset-x-0 bottom-0 z-10 h-px bg-border-default"
        data-testid="deleted-worktree-separator"
        aria-hidden="true"
      >
        {hasCountdown && (
          <div
            className="deleted-worktree-countdown-fill h-full bg-border-strong transition-[width] duration-1000 ease-linear motion-reduce:transition-none"
            style={{ width: `${remainingFraction * 100}%` }}
            data-testid="deleted-worktree-countdown"
          />
        )}
      </div>
    </div>
  );
}
