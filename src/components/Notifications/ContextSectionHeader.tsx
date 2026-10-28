import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { Button } from "@/components/ui/button";
import { CountBadge } from "@/components/ui/badge";
import {
  APP_SOURCE_LABEL,
  UNKNOWN_PROJECT_LABEL,
  worktreeNameFromId,
} from "@/lib/notificationSourceLabel";
import { pluralize } from "@/lib/pluralize";
import { useIsWorktreeUnavailable } from "./notificationSource";

export function ContextSectionHeader({
  worktreeId,
  projectId,
  hostName,
  count,
  newCount,
  unreadIds,
  onMarkRead,
  labelId,
}: {
  /** The name's element id, which the section's group takes as its label. */
  labelId: string;
  worktreeId?: string;
  projectId?: string;
  /** The other host the section's rows came from, which then leads its name. */
  hostName?: string;
  count: number;
  /**
   * Rows here newer than the last look. Grouped, there's no single divider to
   * say where new starts, so each place says how much of it is new, and its
   * "Earlier" boundary says where that stops.
   */
  newCount: number;
  unreadIds: string[];
  onMarkRead: () => void;
}) {
  const worktreeName = useWorktreeStore((s) =>
    worktreeId ? s.worktrees.get(worktreeId)?.name : undefined
  );
  const projectName = useProjectStore((s) =>
    projectId ? s.projects.find((p) => p.id === projectId)?.name : undefined
  );
  // Names, never ids. A project id is a sha256 and a worktree id is a path, so
  // the old `worktreeName ?? worktreeId ?? projectId` fallback printed a
  // 64-character hash as the heading of any section from a project this view
  // hasn't loaded.
  const project = projectName ?? (projectId ? UNKNOWN_PROJECT_LABEL : undefined);
  // A worktree this project view no longer has keeps its name, since the
  // records under it stay readable, but is not passed off as a live one.
  const worktreeUnavailable = useIsWorktreeUnavailable(worktreeId, projectId);
  const resolvedWorktree = worktreeId
    ? worktreeName?.trim() || worktreeNameFromId(worktreeId)
    : undefined;
  // A main worktree is named after its folder, usually the project's own name.
  const worktree = resolvedWorktree && resolvedWorktree !== project ? resolvedWorktree : undefined;
  const host = hostName?.trim() || undefined;
  const label =
    [host, project, worktree, worktreeUnavailable ? "unavailable" : undefined]
      .filter(Boolean)
      .join(" · ") || APP_SOURCE_LABEL;
  const hasUnread = unreadIds.length > 0;
  return (
    // Sticky, so the place a row belongs to stays on screen while you read
    // it: mid-section, the rows carry no source of their own. The solid layer
    // underneath is what makes that work — `overlay-raised` is a tint, and
    // alone it let the rows scroll visibly through the header. `z-20` puts it
    // above ScrollShadow's `z-10` top fade, whose lower edge then falls just
    // under the header as its shadow. The list's `scroll-py-8` already keeps
    // keyboard-focused rows clear of it.
    <div
      data-testid="context-section-sticky"
      className="sticky top-0 z-20 bg-[var(--overlay-surface-solid)]"
    >
      <div
        data-testid="context-section-header"
        // Sentence case, not the uppercase eyebrow the other labels use: this
        // one is a name. Branch names are case-sensitive and uppercasing
        // "feature/refine-inbox" misstates the thing it identifies.
        className="flex items-center justify-between gap-2 pl-4 pr-3 py-1 bg-overlay-raised text-2xs font-medium text-text-secondary"
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          {/* Two spans so the worktree survives a long project name. As one
            string it truncated from the right, and the worktree — the part
            that tells two sections of one project apart — went first. */}
          <span
            id={labelId}
            className="flex min-w-0 items-baseline text-text-primary"
            title={label}
          >
            {host ? <span className="shrink-0 truncate">{host}</span> : null}
            {host && (project || worktree) ? (
              <span aria-hidden="true" className="shrink-0 px-1 text-text-secondary">
                ·
              </span>
            ) : null}
            {/* Both names give way in proportion to their length, each kept to
                a readable stub. With the worktree held whole, a long project
                name went to "daintree-n…" — and a grouped row names neither, so
                the header is the only place the project is said at all. */}
            {project ? <span className="min-w-[5ch] truncate">{project}</span> : null}
            {project && worktree ? (
              <span aria-hidden="true" className="shrink-0 px-1 text-text-secondary">
                ·
              </span>
            ) : null}
            {worktree ? <span className="min-w-[5ch] truncate">{worktree}</span> : null}
            {worktreeUnavailable ? (
              <span
                data-testid="context-section-unavailable"
                className="shrink-0 pl-1 text-text-secondary"
              >
                · unavailable
              </span>
            ) : null}
            {!host && !project && !worktree ? (
              <span className="truncate">{APP_SOURCE_LABEL}</span>
            ) : null}
          </span>
          {/* Beside the name it counts, not beside the button — at the far end
            it read as part of "Mark read". */}
          <CountBadge label={`${pluralize(count, "notification")}`}>{count}</CountBadge>
          {newCount > 0 && (
            <span data-testid="context-section-new" className="shrink-0 tabular-nums">
              · {newCount} new
            </span>
          )}
        </span>
        {hasUnread && (
          <Button
            variant="subtle"
            size="xs"
            onClick={onMarkRead}
            className="shrink-0 px-1.5 text-2xs focus-visible:-outline-offset-2"
          >
            Mark read
          </Button>
        )}
      </div>
    </div>
  );
}
