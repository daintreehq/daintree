import { useMemo } from "react";
import { ArrowRight } from "lucide-react";
import { History } from "@/components/icons";
import { PanelKindIcon } from "@/components/PanelPalette/PanelKindIcon";
import { actionService } from "@/services/ActionService";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { useAgentSessionRecords } from "@/hooks/useAgentSessionRecords";
import { buildResumeSessionItems, type ResumeSessionItem } from "@/services/resumeSessionItems";
import { useResumeAgentSession } from "@/hooks/useResumeAgentSession";

const SHOWN_COUNT = 3;

/**
 * First-run-quiet discovery card for the empty grid. Fetches the project's
 * closed-session journal (kept live — a session that leaves the trash appears
 * here the moment it's journaled) and, when there is something to resume,
 * offers the most recent few as one-click launches plus a "browse all" entry
 * into the searchable resume launcher. Renders nothing when the project has no
 * resumable sessions, so genuine first-run stays quiet and doesn't compete
 * with the RecipeRunner / welcome CTA (empty-state rules).
 */
export function ResumeSessionsCard() {
  const worktrees = useWorktreeStore((state) => state.worktrees);
  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const resume = useResumeAgentSession();
  const { sessions, hasLoaded } = useAgentSessionRecords(true);

  const items = useMemo(
    () => buildResumeSessionItems(sessions, { currentProjectId, worktrees }),
    [sessions, currentProjectId, worktrees]
  );
  const resumable = useMemo(() => items.filter((item) => !item.isStale), [items]);
  const shown = resumable.slice(0, SHOWN_COUNT);

  // Render nothing until loaded (avoids a flash of empty card) or when the
  // project has nothing to resume.
  if (!hasLoaded || resumable.length === 0) return null;

  const openLauncher = () => {
    void actionService.dispatch("terminal.resumeSessions", undefined, { source: "user" });
  };

  const handleSelect = (item: ResumeSessionItem) => {
    void resume(item.session);
  };

  return (
    <div className="mb-6 w-full max-w-md rounded-[var(--radius-lg)] border border-daintree-border/40 bg-surface p-3">
      <div className="flex items-center gap-2 px-1 pb-2 text-[11px] font-medium uppercase tracking-wider text-daintree-text/40">
        <History className="h-3.5 w-3.5" aria-hidden="true" />
        Resume sessions
      </div>
      <div className="flex flex-col gap-0.5">
        {shown.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => handleSelect(item)}
            className="group flex w-full items-center gap-3 rounded-[var(--radius-md)] px-2 py-1.5 text-left transition-colors hover:bg-overlay-subtle"
          >
            <span className="shrink-0">
              <PanelKindIcon iconId={item.iconId} color={item.color} size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-daintree-text/80 group-hover:text-daintree-text">
                {item.name}
              </span>
              {item.description && (
                <span className="block truncate text-xs text-daintree-text/40">
                  {item.description}
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
      {resumable.length > SHOWN_COUNT && (
        <button
          type="button"
          onClick={openLauncher}
          className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-[var(--radius-md)] px-2 py-1.5 text-xs text-daintree-text/50 transition-colors hover:bg-overlay-subtle hover:text-daintree-text/80"
        >
          Browse more sessions
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
