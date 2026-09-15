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
  /**
   * Bare display title: the agent's own task title when it had one, else
   * `<Agent> session`. This is what a surface dedicated to resuming shows —
   * "Resume" is that surface's title, not every row's.
   */
  title: string;
  /** Whether {@link title} is the agent's task title rather than the untitled fallback. */
  hasTitle: boolean;
  /**
   * Action label for surfaces that list resuming beside other verbs (the panel
   * palette, the launcher line): `Resume: <title>` / `Resume <Agent> session`.
   */
  name: string;
  /**
   * Agent display name. The glyph carries it visually; this is for the
   * accessible name, since the glyph is `aria-hidden` and two agents' rows
   * would otherwise read identically.
   */
  agentName: string;
  /** Agent icon id for {@link PanelKindIcon}. */
  iconId: string;
  /** Agent accent color for the icon. */
  color: string;
  /** Readable model label, when the record carries a model id. */
  modelName: string | null;
  /**
   * Where the session ran: the live worktree's name, else the branch it was
   * captured on, else the cwd's last segment. Null when nothing was recorded.
   * A stale row's location is what was recorded — the section it sits in says
   * the worktree is gone, so the row does not have to.
   */
  location: string | null;
  /** Coarse relative age of the record ("5m ago"). */
  timeAgo: string;
  /** One-line metadata for surfaces without a time column: location · model · time-ago. */
  description: string;
  /** Extra fuzzy-search haystack (agent, model, branch, worktree, cwd). */
  searchAliases: string[];
  /**
   * Recorded worktree no longer resolves in the live map (deleted/removed).
   * Rendered muted under a "Worktree removed" heading and excluded from
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

/**
 * An agent's own product name is as empty a title as its binary: Claude Code
 * sits on "Claude Code" until it has a task to summarise, and a resume row
 * titled that way says nothing the agent glyph beside it does not. Exact
 * matches only — a task that merely mentions the product is a task.
 *
 * Deliberately NOT in `isUselessTitle`: the live pane title treats the same
 * echo as an identity to show in place of the default one, and that surface
 * has its own ruling.
 */
export function isAgentPlaceholderTitle(
  title: string,
  agent: { name?: string; command?: string } | undefined
): boolean {
  const normalized = title.trim().toLowerCase();
  const labels = [agent?.name, agent?.command]
    .filter((label): label is string => !!label)
    .map((label) => label.toLowerCase());
  return labels.some(
    (label) =>
      normalized === label || normalized === `${label} code` || normalized === `${label} cli`
  );
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
    // A dash between short digit runs is a version separator ("opus-4-8"),
    // not a word break; a long run after it is a date stamp and stays apart.
    .replace(/(\d)-(?=\d{1,2}(?:-|$))/g, "$1.")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/^Gpt\b/, "GPT");
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
      const modelName = session.agentModelId ? prettifyModelId(session.agentModelId) : null;
      const agentName = agentConfig?.name ?? session.agentId;
      // Glyph-stripped so the resume label matches how the live tab rendered
      // the same task title.
      const taskTitle = cleanTaskTitle(session.title);
      const hasTitle =
        !!taskTitle &&
        !isUselessTitle(taskTitle) &&
        // An unregistered agent is named by its id, so that is its placeholder too.
        !isAgentPlaceholderTitle(taskTitle, agentConfig ?? { name: agentName, command: agentName });
      const title = hasTitle ? taskTitle : `${agentName} session`;
      const name = hasTitle ? `Resume: ${title}` : `Resume ${title}`;

      const liveWorktree = resolvedWorktreeId ? worktrees.get(resolvedWorktreeId) : undefined;
      // Stale means the RECORDED worktree no longer resolves — an inferred id
      // always resolves (it came from the live map), so inference never
      // produces a stale row.
      const isStale = !!session.worktreeId && !liveWorktree;
      const worktreeName = liveWorktree?.name;
      const branchName = liveWorktree?.branch ?? session.branch;

      const location = worktreeName ?? branchName ?? pathBasename(session.cwd) ?? null;
      // The agent is not in here: every surface that shows this line draws
      // the agent glyph beside it, and the word said what the glyph already had.
      const description = [location || null, modelName, timeAgo]
        .filter((part): part is string => !!part)
        .join(" · ");

      const searchAliases = [
        session.agentId,
        agentName,
        modelName,
        worktreeName,
        branchName,
        pathBasename(session.cwd),
      ].filter((alias): alias is string => !!alias);

      return {
        id: `resume:${session.sessionId}`,
        session,
        title,
        hasTitle,
        name,
        agentName,
        iconId: agentConfig?.iconId ?? "terminal",
        color: agentConfig?.color ?? "var(--color-text-primary)",
        modelName,
        location: location || null,
        timeAgo,
        description,
        searchAliases,
        isStale,
        worktreeName,
        branchName,
      };
    });
}
