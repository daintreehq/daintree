import { useMemo } from "react";
import { History } from "@/components/icons";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import { actionService } from "@/services/ActionService";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useAgentSessionRecords } from "@/hooks/useAgentSessionRecords";
import { buildResumeSessionItems } from "@/services/resumeSessionItems";
import { useResumeAgentSession } from "@/hooks/useResumeAgentSession";

/**
 * First-run-quiet resume affordance for the launcher: one line for the single
 * most-recent resumable session, with a "+N more" entry into the searchable
 * resume launcher when the project has a deeper history. Renders nothing when
 * there is nothing to resume, so genuine first-run stays silent (empty-state
 * rules). Replaces the earlier three-row card — the palette is the browse
 * surface, this is just the fast "pick up where I left off" tap.
 */
export function ResumeSessionLine() {
  const worktrees = useWorktreeStore((state) => state.worktrees);
  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const resume = useResumeAgentSession();
  const { sessions, hasLoaded } = useAgentSessionRecords(true);

  const resumable = useMemo(
    () =>
      buildResumeSessionItems(sessions, { currentProjectId, worktrees }).filter(
        (item) => !item.isStale
      ),
    [sessions, currentProjectId, worktrees]
  );

  const primary = resumable[0];
  const extraCount = resumable.length - 1;

  if (!hasLoaded || !primary) return null;

  const openLauncher = () => {
    // The launcher's open transition clears the shortcut hint globally
    // (AppPaletteDialog overlay clearing, issue #11030).
    void actionService.dispatch("terminal.resumeSessions", undefined, { source: "user" });
  };

  return (
    // Hugs its content (centered) rather than stretching to the column width —
    // a stretched row strands "+N more" at the far edge, visually orphaned
    // from the session it extends. The width cap now comes from the launcher
    // column, which owns the single measure every band shares.
    <div className="flex w-full items-center justify-center gap-1">
      <button
        type="button"
        onClick={() => void resume(primary.session)}
        className="group flex min-w-0 items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left transition-colors hover:bg-overlay-subtle focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary"
      >
        <History className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="shrink-0">
          <PanelKindIcon iconId={primary.iconId} color={primary.color} size={15} />
        </span>
        <span className="truncate text-sm text-daintree-text/75 group-hover:text-text-primary">
          {primary.name}
        </span>
        {primary.description && (
          // Shrinkable (no shrink-0): a long worktree/branch description must
          // truncate inside the column's measure, not push the row past it.
          //
          // And below the launcher's narrow breakpoint it is dropped outright.
          // Sharing the row down there truncated BOTH halves at once — a task
          // title cut mid-word beside a model name cut mid-word, neither of
          // them readable. The title is what identifies the session; the model
          // and location are still on the row this line opens.
          <span className="min-w-0 truncate text-xs text-text-secondary @max-[31rem]/launcher:hidden">
            {primary.description}
          </span>
        )}
      </button>
      {extraCount > 0 && (
        <button
          type="button"
          onClick={openLauncher}
          className="shrink-0 rounded-[var(--radius-md)] px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-overlay-subtle hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary"
          aria-label={`Browse ${extraCount} more resumable session${extraCount !== 1 ? "s" : ""}`}
        >
          +{extraCount} more
        </button>
      )}
    </div>
  );
}
