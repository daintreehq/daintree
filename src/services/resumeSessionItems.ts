import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { isUselessTitle } from "@shared/utils/isUselessTitle";
import { formatTimeAgo } from "@/utils/timeAgo";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

/**
 * Shared model for a browsable "resume closed session" entry. Built from a
 * journaled {@link AgentSessionRecord} plus the live worktree map so the resume
 * launcher (`ResumeSessionsPalette`), the empty-grid card (`ResumeSessionsCard`)
 * and the panel palette all render the same metadata, grouping and stale flags
 * without duplicating the mapping. Kept renderer-pure (no store reads) so it is
 * trivially unit-testable.
 */
export interface ResumeSessionItem {
  /** Stable option id: `resume:<sessionId>`. */
  id: string;
  /** The underlying journal record, forwarded to the resume launcher. */
  session: AgentSessionRecord;
  /** Row title — `Resume: <title>` when meaningful, else `Resume <agent>`. */
  name: string;
  /** Agent icon id for {@link PanelKindIcon}. */
  iconId: string;
  /** Agent accent color for the icon. */
  color: string;
  /** Second metadata line: model · agent · location · time-ago. */
  description: string;
  /** Extra fuzzy-search haystack (agent, model, branch, worktree, cwd). */
  searchAliases: string[];
  /**
   * Recorded worktree no longer resolves in the live map (deleted/removed).
   * Rendered greyed-out with a "Worktree removed" badge and excluded from
   * keyboard navigation / launch (#10851).
   */
  isStale: boolean;
  /** Live worktree display name, when it still resolves. */
  worktreeName?: string;
  /** Branch the session was captured on (live value preferred over recorded). */
  branchName?: string;
  /** Grouping key for the browse view: worktree id, or a no-worktree sentinel. */
  groupKey: string;
  /** Human label for the worktree group header. */
  groupLabel: string;
}

/** Group key for resume records that were never tied to a worktree. */
export const NO_WORKTREE_GROUP_KEY = "__no-worktree__";

/** Minimal shape of a live worktree needed for labelling/stale detection. */
export interface ResumeWorktreeLike {
  name: string;
  branch?: string | null;
}

/** Last path segment of a POSIX or Windows path (for cwd-derived labels). */
export function pathBasename(p: string | null | undefined): string {
  if (!p) return "";
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** Turn a raw model id (`anthropic/claude-opus-4-8`) into a readable label. */
export function prettifyModelId(modelId: string): string {
  let name = modelId;
  const slashIdx = name.lastIndexOf("/");
  if (slashIdx >= 0) name = name.slice(slashIdx + 1);
  name = name
    .replace(/^claude-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return name;
}

/**
 * Filter the (unscoped, newest-first) journal to the current project and map
 * each record to a rich, groupable {@link ResumeSessionItem}. Legacy records
 * with a null projectId (pre-scoping) are kept only when their worktree still
 * resolves in the live map — otherwise there's no reliable way to know they
 * belong to this project.
 */
export function buildResumeSessionItems(
  sessions: AgentSessionRecord[],
  opts: {
    currentProjectId: string | null;
    worktrees: ReadonlyMap<string, ResumeWorktreeLike>;
  }
): ResumeSessionItem[] {
  const { currentProjectId, worktrees } = opts;
  return sessions
    .filter((session) => !!session.sessionId)
    .filter((session) => {
      if (session.projectId) return session.projectId === currentProjectId;
      return !!session.worktreeId && worktrees.has(session.worktreeId);
    })
    .map((session) => {
      const agentConfig = getEffectiveAgentConfig(session.agentId);
      const timeAgo = formatTimeAgo(session.savedAt);
      const modelPart = session.agentModelId ? prettifyModelId(session.agentModelId) : null;
      const agentName = agentConfig?.name ?? session.agentId;
      const hasMeaningfulTitle = !!session.title && !isUselessTitle(session.title);
      const name = hasMeaningfulTitle ? `Resume: ${session.title}` : `Resume ${agentName}`;

      const liveWorktree = session.worktreeId ? worktrees.get(session.worktreeId) : undefined;
      const isStale = !!session.worktreeId && !liveWorktree;
      const worktreeName = liveWorktree?.name;
      const branchName = liveWorktree?.branch ?? session.branch;

      const groupKey = session.worktreeId ?? NO_WORKTREE_GROUP_KEY;
      const groupLabel = liveWorktree
        ? liveWorktree.name
        : isStale
          ? session.branch || pathBasename(session.cwd) || "Removed worktree"
          : "No worktree";

      const locationPart = isStale ? "Worktree removed" : (worktreeName ?? branchName ?? null);
      const description = [modelPart, hasMeaningfulTitle ? agentName : null, locationPart, timeAgo]
        .filter((part): part is string => !!part)
        .join(" · ");

      const searchAliases = [
        session.agentId,
        agentName,
        modelPart,
        worktreeName,
        branchName,
        pathBasename(session.cwd),
      ].filter((alias): alias is string => !!alias);

      return {
        id: `resume:${session.sessionId}`,
        session,
        name,
        iconId: agentConfig?.iconId ?? "terminal",
        color: agentConfig?.color ?? "var(--color-daintree-text)",
        description,
        searchAliases,
        isStale,
        worktreeName,
        branchName,
        groupKey,
        groupLabel,
      };
    });
}
