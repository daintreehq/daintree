import { useEffect, useMemo, type ReactElement } from "react";
import { Unlink } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { isPtyPanel } from "@shared/types/panel";
import { deriveWorktreeDivergence } from "@/utils/worktreeAlignment";
import { notify } from "@/lib/notify";

/**
 * Ambient marker for a panel whose process runs somewhere other than the
 * worktree it is filed under (#11840).
 *
 * Only ever shown for panels whose user explicitly chose "Move panel only", so
 * it is informed consent rather than a nag — and it has to be ambient rather
 * than a dismissible banner, because dismissal turns a durable invariant
 * violation back into silence.
 *
 * Neutral chrome by design. This is a statement of where the process lives, not
 * a call to action, so it never takes the accent.
 */
export function WorktreeDivergenceIndicator({ panelId }: { panelId: string }): ReactElement | null {
  const panel = usePanelStore((s) => s.panelsById[panelId]);
  const worktrees = useWorktreeStore((s) => s.worktrees);

  const divergence = useMemo(() => {
    if (!panel || !isPtyPanel(panel)) return { kind: "none" as const };
    return deriveWorktreeDivergence(
      {
        cwd: panel.cwd,
        worktreeId: panel.worktreeId,
        worktreeMoveOptOut: panel.worktreeMoveOptOut,
      },
      [...worktrees.values()].map((w) => ({
        id: w.id,
        path: w.path,
        name: w.name,
        headOid: w.worktreeChanges?.headOid,
      }))
    );
  }, [panel, worktrees]);

  const headDrifted = divergence.kind === "diverged" && divergence.headDrifted;
  const launchLabel = divergence.kind === "diverged" ? divergence.launchLabel : undefined;

  // The pane may be off-screen the moment this matters — a divergent panel lives
  // under a worktree the user may not be looking at, and in the dock it isn't
  // rendered at all. Grid-bar is the surface for a signal from outside the
  // visible UI; the pill alone can't carry it.
  useEffect(() => {
    if (!headDrifted || !launchLabel) return;
    notify({
      type: "warning",
      title: "Commits landed in the old worktree",
      message: `${panel?.title ?? "A session"} is filed elsewhere but is still committing in ${launchLabel}.`,
      placement: "grid-bar",
      supersedeKey: `worktree-divergence-drift:${panelId}`,
      action: {
        label: "Show session",
        onClick: () => usePanelStore.getState().activateTerminal(panelId),
      },
    });
  }, [headDrifted, launchLabel, panelId, panel?.title]);

  if (divergence.kind !== "diverged") return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-none select-none max-w-[140px] bg-overlay-subtle text-text-secondary"
          data-testid="worktree-divergence-indicator"
          data-head-drifted={divergence.headDrifted ? "true" : undefined}
        >
          <Unlink className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{divergence.launchLabel}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>Running in {divergence.launchLabel}, not the worktree this panel is filed under.</p>
        {divergence.headDrifted && <p>That worktree has picked up new commits since the move.</p>}
      </TooltipContent>
    </Tooltip>
  );
}
