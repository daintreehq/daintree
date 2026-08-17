import { useMemo, type ReactElement } from "react";
import { Unlink } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreesOptional } from "@/hooks/useWorktreesOptional";
import { isPtyPanel } from "@shared/types/panel";
import { deriveWorktreeDivergence } from "@/utils/worktreeAlignment";

/**
 * Ambient marker for a panel whose process runs somewhere other than the
 * worktree it is filed under (#11840).
 *
 * Only ever shown for panels whose user explicitly chose "Move panel only", so
 * it is informed consent rather than a nag — and it has to be ambient rather
 * than a dismissible banner, because dismissal turns a durable invariant
 * violation back into silence.
 *
 * Purely visual: the drift backstop lives in `WorktreeDivergenceWatcher`, which
 * stays mounted when a worktree switch unmounts this pane. Neutral chrome by
 * design — a statement of where the process lives, not a call to action, so it
 * never takes the accent.
 */
export function WorktreeDivergenceIndicator({ panelId }: { panelId: string }): ReactElement | null {
  const panel = usePanelStore((s) => s.panelsById[panelId]);
  const worktrees = useWorktreesOptional();

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

  if (divergence.kind !== "diverged") return null;

  const { launchLabel, launchResolved, headDrifted } = divergence;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-none select-none max-w-[140px] bg-overlay-subtle text-text-secondary"
          data-testid="worktree-divergence-indicator"
          data-head-drifted={headDrifted ? "true" : undefined}
        >
          <Unlink className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{launchResolved ? launchLabel : "Location unknown"}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>
          {launchResolved
            ? `Running in ${launchLabel}, not the worktree this panel is filed under.`
            : `This session's launch directory (${launchLabel}) doesn't belong to any current worktree.`}
        </p>
        {headDrifted && <p>That worktree has picked up new commits since the move.</p>}
      </TooltipContent>
    </Tooltip>
  );
}
