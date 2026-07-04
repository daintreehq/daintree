import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { isUselessTitle } from "@shared/utils/isUselessTitle";
import { cleanTaskTitle } from "@shared/utils/taskTitle";
import { formatTimeAgo } from "@/utils/timeAgo";
import { inferWorktreeIdFromCwd } from "@/utils/worktreePaths";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

/**
 * Shared model for a browsable "resume closed session" entry. Built from a
 * journaled {@link AgentSessionRecord} plus the live worktree map so the resume
 * launcher (`ResumeSessionsPalette`), the empty-grid line (`ResumeSessionLine`)
 * and the panel palette all render the same metadata and stale flags without
 * duplicating the mapping. Kept renderer-pure (no store reads) so it is
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
}

/** Minimal shape of a live worktree needed for labelling/stale detection. */
export interface ResumeWorktreeLike {
  name: string;
  branch?: string | null;
  /** Absolute worktree root path — enables cwd-based worktree inference. */
  path?: string;
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
 * each record to a rich {@link ResumeSessionItem}. Legacy records with a null
 * projectId (pre-scoping) are kept only when their worktree still resolves in
 * the live map — otherwise there's no reliable way to know they belong to this
 * project.
 *
 * Records journaled without a worktreeId (terminals spawned before worktree
 * selection settled, "global" terminals) are re-homed by cwd: longest-prefix
 * matching against live worktree paths. That keeps the row's location line and
 * the launch target accurate instead of pretending the session ran nowhere.
 */
export function buildResumeSessionItems(
  sessions: AgentSessionRecord[],
  opts: {
    currentProjectId: string | null;
    worktrees: ReadonlyMap<string, ResumeWorktreeLike>;
  }
): ResumeSessionItem[] {
  const { currentProjectId, worktrees } = opts;
  const worktreePaths = [...worktrees].flatMap(([id, wt]) =>
    wt.path ? [{ id, path: wt.path }] : []
  );
  return sessions
    .filter((session) => !!session.sessionId)
    .map((session) => ({
      session,
      resolvedWorktreeId:
        session.worktreeId ?? inferWorktreeIdFromCwd(session.cwd, worktreePaths) ?? null,
    }))
    .filter(({ session, resolvedWorktreeId }) => {
      if (session.projectId) return session.projectId === currentProjectId;
      return !!resolvedWorktreeId && worktrees.has(resolvedWorktreeId);
    })
    .map(({ session, resolvedWorktreeId }) => {
      const agentConfig = getEffectiveAgentConfig(session.agentId);
      const timeAgo = formatTimeAgo(session.savedAt);
      const modelPart = session.agentModelId ? prettifyModelId(session.agentModelId) : null;
      const agentName = agentConfig?.name ?? session.agentId;
      // Glyph-stripped so the resume label matches how the live tab rendered
      // the same task title.
      const taskTitle = cleanTaskTitle(session.title);
      const hasMeaningfulTitle = !!taskTitle && !isUselessTitle(taskTitle);
      const name = hasMeaningfulTitle ? `Resume: ${taskTitle}` : `Resume ${agentName}`;

      const liveWorktree = resolvedWorktreeId ? worktrees.get(resolvedWorktreeId) : undefined;
      // Stale means the RECORDED worktree no longer resolves — an inferred id
      // always resolves (it came from the live map), so inference never
      // produces a stale row.
      const isStale = !!session.worktreeId && !liveWorktree;
      const worktreeName = liveWorktree?.name;
      const branchName = liveWorktree?.branch ?? session.branch;

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
      };
    });
}
