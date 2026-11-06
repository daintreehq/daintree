import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { formatPath } from "@/utils/textParsing";
import { FolderX, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { usePanelStore } from "@/store/panelStore";
import { exitProjectHome } from "@/store/storeAccessors";
import {
  getDeletedWorktreeTerminalIds,
  useWorktreeSelectionStore,
  type DeletedWorktree,
} from "@/store/worktreeStore";
import { useTerminalPendingDestructiveActionStore } from "@/store/terminalPendingDestructiveActionStore";
import { useWorktreeTerminals } from "@/hooks/useWorktreeTerminals";
import { WorktreeTerminalSection } from "@/components/Worktree/WorktreeCard/WorktreeTerminalSection";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  buildDestructivePreview,
  collectRunningAgentTerminals,
} from "@/utils/destructiveSessionConfirm";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import { useDeletedWorktreeCountdown } from "./useDeletedWorktreeCountdown";
import { Badge } from "@/components/ui/badge";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";

interface DeletedWorktreeCardProps {
  worktree: DeletedWorktree;
  /** Collapses the home directory to "~" in the path line; fetched once by the sidebar. */
  homeDir?: string;
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
  homeDir,
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
  // Open by default, and local rather than the live card's persisted
  // `expandedTerminals`: the terminals are all this row exists for, so hiding
  // them behind an "N active" bar made opening the group show less than the
  // collapsed rail did.
  const [isTerminalsExpanded, setIsTerminalsExpanded] = useState(true);

  const { counts, terminals } = useWorktreeTerminals(worktree.id);

  // Auto-cleanup countdown: a numeric seconds readout in the header plus the
  // row's own bottom separator draining from full width to empty. While the
  // sweep holds the countdown both freeze, and `hold` says which condition is
  // holding, because a row that just stops counting down reads as broken
  // (#11259).
  const { hasCountdown, hold, remainingSeconds, remainingFraction } =
    useDeletedWorktreeCountdown(worktree);

  const panels = useMemo(() => {
    void panelIdsByWorktreeId;
    return getDeletedWorktreeTerminalIds(worktree.id)
      .map((id) => panelsById[id])
      .filter((panel): panel is PanelInstance => panel != null);
  }, [worktree.id, panelsById, panelIdsByWorktreeId]);
  // Listed from the same set the dismiss would close (#9699): the live hook
  // keeps overlay and dialog panels, which never belong to a worktree row.
  const listedTerminals = useMemo(() => {
    const ids = new Set(panels.map((panel) => panel.id));
    return terminals.filter((terminal) => ids.has(terminal.id));
  }, [panels, terminals]);

  const handleDismiss = useCallback(() => {
    if (panels.length === 0) {
      // Nothing left to confirm — the pruning subscription is about to drop
      // this row anyway, but dismissing directly keeps the button honest.
      dismissDeletedWorktree(worktree.id);
      return;
    }
    // The deleted worktree is gone from the live map, so the row names it.
    const preview = buildDestructivePreview(panels, () => worktree.title);
    requestDestructiveAction({
      kind: "deletedWorktreeDismiss",
      targetCount: panels.length,
      runningAgentCount: collectRunningAgentTerminals(panels).length,
      worktreeId: worktree.id,
      worktreeTitle: worktree.title,
      preview,
    });
  }, [panels, worktree.id, worktree.title, requestDestructiveAction, dismissDeletedWorktree]);

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
        // A grid pane is hidden while the project's Home shows.
        exitProjectHome();
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

  const handleToggleTerminals = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    setIsTerminalsExpanded((open) => !open);
  }, []);

  // Defensive: the store prunes empty deleted-worktree rows, so an empty row should never
  // reach render. Bailing keeps a torn frame from showing a zero-terminal card.
  if (panels.length === 0) return null;

  const noun = panels.length === 1 ? "terminal" : "terminals";
  const closeLabel = `Close ${panels.length} ${noun}`;

  return (
    <div
      data-deleted-worktree-id={worktree.id}
      className="sidebar-worktree-card group/card relative isolate transition-colors duration-150"
      // The live card's plane and shadow come from sidebar.css's
      // `[data-variant="sidebar"]` rules; without it this row sank flat into
      // the rail on every theme. Its select button carries the name.
      data-variant="sidebar"
      data-active={isActive ? "true" : undefined}
      data-hoverable={!isActive ? "true" : undefined}
      onClick={handleSelect}
    >
      <button
        type="button"
        data-card-select-overlay=""
        // Unlike the live card's overlay (allowlisted in the focus-ring
        // contract), this card has no focusable parent row owning keyboard
        // nav — the overlay button IS the keyboard path, so it carries its
        // own inset focus ring.
        className="row-select-target absolute inset-0 z-0 outline-hidden focus-visible:outline-solid focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
        aria-label={`Select deleted worktree: ${worktree.title}`}
      />
      {/* Left padding is the live card's drag-grip gutter (w-4), so FolderX
          sits on the live branch-icon column. No fade: what marks the row as
          deleted is FolderX, the badge and the struck-through path — dimming
          the whole row made its surviving sessions read as disabled. */}
      <div className="relative z-10 pl-4 pr-4 py-3">
        {/* Mirrors WorktreeHeader's title row: same row height, and the same
            icon size/gap/typography as BranchLabel, with FolderX in
            the branch-type icon's slot. */}
        <div className="flex items-center gap-2 min-h-[22px]">
          <span className="flex items-center gap-1.5 min-w-0 flex-1">
            <FolderX className="w-3.5 h-3.5 text-text-secondary shrink-0" aria-hidden="true" />
            <TruncatedTooltip content={worktree.title}>
              <span className="truncate font-mono text-2xs font-medium text-text-secondary">
                {worktree.title}
              </span>
            </TruncatedTooltip>
            <Badge size="xs">Deleted</Badge>
          </span>
          <div className="flex items-center gap-2 shrink-0">
            {hasCountdown && (
              <span
                role="timer"
                aria-label={
                  hold !== undefined
                    ? `${hold.tooltip}, holding at ${remainingSeconds} seconds`
                    : `Closes automatically in ${remainingSeconds} seconds`
                }
                className="font-mono text-2xs tabular-nums text-text-secondary"
                title={
                  hold !== undefined
                    ? `${hold.tooltip}, holding at ${remainingSeconds}s`
                    : `Closes automatically in ${remainingSeconds}s`
                }
                data-testid="deleted-worktree-countdown-seconds"
              >
                {remainingSeconds}s
              </span>
            )}
            {showDismissAction && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDismiss();
                    }}
                    className="sidebar-action-button -my-1 shrink-0 hover:text-status-error focus-visible:text-status-error [&_svg]:size-3.5"
                    aria-label={closeLabel}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">{closeLabel}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
        {/* The hold reason rides the path line: in the title row it pushed the
            branch name down to a few characters, and the name is what says
            which worktree this is. */}
        <div className="mt-0.5 flex items-center gap-2">
          {/* Measured, not inferred from the ~ shortening: an unclipped path
              is no tab stop. */}
          <TruncatedTooltip content={worktree.path}>
            {/* A size under the branch name it belongs to, not over it. */}
            <div className="min-w-0 flex-1 truncate font-mono text-2xs text-text-secondary line-through">
              {formatPath(worktree.path, homeDir)}
            </div>
          </TruncatedTooltip>
          {hold !== undefined && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  size="xs"
                  data-testid="deleted-worktree-countdown-hold"
                  data-hold-reason={worktree.holdReason}
                >
                  {hold.label}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top">{hold.tooltip}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <WorktreeTerminalSection
          worktreeId={worktree.id}
          worktreeLabel={worktree.title}
          isExpanded={isTerminalsExpanded}
          counts={counts}
          terminals={listedTerminals}
          onToggle={handleToggleTerminals}
          onTerminalSelect={handleTerminalSelect}
          rowClick="select"
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
            className={cn(
              // The 1s linear sweep is the countdown's own tempo (it matches
              // the tick that drives it), not a state-change tier. A held bar
              // holds one frozen width, so there is nothing to interpolate —
              // leaving the transition on would only smear the moment it stops.
              "deleted-worktree-countdown-fill h-full bg-border-strong",
              hold === undefined && "transition-[width] duration-1000 ease-linear",
              "motion-reduce:transition-none"
            )}
            style={{ width: `${remainingFraction * 100}%` }}
            data-testid="deleted-worktree-countdown"
            data-held={hold !== undefined ? "true" : undefined}
          />
        )}
      </div>
    </div>
  );
}
