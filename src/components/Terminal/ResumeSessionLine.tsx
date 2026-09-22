import { useMemo } from "react";
import { History } from "@/components/icons";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import { actionService } from "@/services/ActionService";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useAgentSessionRecords } from "@/hooks/useAgentSessionRecords";
import { buildResumeSessionItems } from "@/services/resumeSessionItems";
import { useResumeAgentSession } from "@/hooks/useResumeAgentSession";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => void resume(primary.session)}
            // Disclosure is a Tooltip, not `title`: this row is an ordinary tab
            // stop and its name truncates, so the person who most needs the full
            // string is the keyboard user `title` never reaches. Deliberately NOT
            // an aria-label — `truncate` clips at paint time only, so the full
            // name is already in the DOM text node and is already the accessible
            // name; an aria-label would replace a correct name with a second copy
            // and risk breaking Label in Name. Below the narrow breakpoint the
            // description is dropped from the row entirely, and the tooltip is
            // then the only place it survives.
            className="group flex min-w-0 items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left transition-colors hover:bg-overlay-subtle focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary"
          >
            <History className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
            <span className="shrink-0">
              <PanelKindIcon iconId={primary.iconId} color={primary.color} size={15} />
              <span className="sr-only">{primary.agentName} </span>
            </span>
            <span className="truncate text-sm text-text-secondary group-hover:text-text-primary">
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
        </TooltipTrigger>
        <TooltipContent side="top">
          <span className="font-medium">{primary.name}</span>
          {primary.description && (
            <span className="ml-1 text-text-secondary">{primary.description}</span>
          )}
        </TooltipContent>
      </Tooltip>
      {extraCount > 0 && (
        <button
          type="button"
          onClick={openLauncher}
          className="shrink-0 rounded-[var(--radius-md)] px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-overlay-subtle hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-primary"
          // Opens with the visible string verbatim, `+` included. WCAG 2.2
          // SC 2.5.3 (Label in Name) wants what is on the control to appear in
          // its accessible name, so a speech-input user can say what they read;
          // "Browse 2 more resumable sessions" contained "2 more" but not
          // "+2 more", and the control they can see is the one they cannot say.
          aria-label={`+${extraCount} more — browse resumable session${
            extraCount !== 1 ? "s" : ""
          }`}
        >
          +{extraCount} more
        </button>
      )}
    </div>
  );
}
