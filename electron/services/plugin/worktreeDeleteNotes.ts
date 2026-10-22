import { PLUGIN_WORKTREE_DELETE_NOTES_TIMEOUT_MS } from "../../../shared/config/pluginBudgets.js";
import type {
  PluginManifest,
  PluginWorktreeSnapshot,
  WorktreeDeleteNoteSource,
  WorktreeDeleteNotesAnswer,
  WorktreeDeleteNotesReport,
} from "../../../shared/types/plugin.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { validatePluginWorktreeDeleteNotes } from "../../../shared/utils/pluginWorktreeDeleteNotes.js";
import { selectContributionsForProject } from "./PluginContributionBroadcaster.js";
import { getWorktreeDeleteNotesBinding } from "./worktreeDeleteNotesRegistry.js";

/** The worktree about to be deleted, read from the project the confirmation is in. */
export type WorktreeDeleteNotesTarget =
  | { status: "ok"; worktree: PluginWorktreeSnapshot }
  /** Not one of the project's worktrees (any more): there is nothing to ask about. */
  | { status: "missing" }
  /** The read failed, so no plugin could be asked. */
  | { status: "unavailable" };

/** What the note checks need from the plugin service. */
export interface WorktreeDeleteNotesHost {
  /** The loaded plugins by instance id. An entry's identity marks one load of it. */
  readonly plugins: ReadonlyMap<string, { readonly manifest: PluginManifest }>;
  /** Idempotent and never rejects, like `PluginService.activatePlugin`. */
  activatePlugin(pluginId: string): Promise<void>;
  readWorktree(projectId: string, worktreeId: string): Promise<WorktreeDeleteNotesTarget>;
  isMuted(pluginId: string): boolean;
  timeoutMs?: number;
}

const NO_ANSWER: WorktreeDeleteNotesAnswer = { status: "no-answer" };

/**
 * The plugins a delete confirmation in a view of `projectId` asks for notes
 * (#13805): those that declare the check, that the project shows, and whose
 * notes the user hasn't turned off. Nothing is activated to answer this.
 */
export function listWorktreeDeleteNoteSources(
  host: WorktreeDeleteNotesHost,
  projectId: string
): WorktreeDeleteNoteSource[] {
  const declaring: string[] = [];
  for (const [pluginId, plugin] of host.plugins) {
    if ((plugin.manifest.contributes.worktreeDeleteNotes?.length ?? 0) > 0)
      declaring.push(pluginId);
  }
  return selectContributionsForProject(declaring, (id) => id, projectId)
    .filter((pluginId) => !host.isMuted(pluginId))
    .map((pluginId) => {
      const manifest = host.plugins.get(pluginId)!.manifest;
      return { pluginId, pluginName: manifest.displayName ?? manifest.name };
    });
}

/**
 * Ask one plugin for its notes on one of `projectId`'s worktrees, activating
 * it first if it isn't running. Activation counts against the deadline: the
 * confirmation is already open, and a plugin that can't start in time hasn't
 * answered.
 *
 * `null` when the plugin is no longer one this confirmation asks — unloaded,
 * hidden or muted since the list was read — or the worktree isn't the
 * project's: the row goes rather than reading "didn't answer". Never rejects.
 */
export async function getWorktreeDeleteNotes(
  host: WorktreeDeleteNotesHost,
  projectId: string,
  pluginId: string,
  worktreeId: string
): Promise<WorktreeDeleteNotesAnswer | null> {
  const isAsked = () =>
    listWorktreeDeleteNoteSources(host, projectId).some((s) => s.pluginId === pluginId);
  const plugin = host.plugins.get(pluginId);
  if (!plugin || !isAsked()) return null;
  const current = () => host.plugins.get(pluginId) === plugin && isAsked();

  const timeoutMs = host.timeoutMs ?? PLUGIN_WORKTREE_DELETE_NOTES_TIMEOUT_MS;
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => {
      deadline.abort(new Error(`timed out after ${timeoutMs}ms`));
      resolve("expired");
    }, timeoutMs);
  });

  const ask = async (): Promise<WorktreeDeleteNotesAnswer | null> => {
    const [target] = await Promise.all([
      host.readWorktree(projectId, worktreeId),
      host.activatePlugin(pluginId),
    ]);
    if (deadline.signal.aborted) return NO_ANSWER;
    if (target.status === "missing" || !current()) return null;
    if (target.status === "unavailable") throw new Error("the worktree couldn't be read");
    // Activation resolving is not proof it worked: a failed one resolves too,
    // and leaves no binding behind.
    const binding = getWorktreeDeleteNotesBinding(pluginId);
    if (!binding) throw new Error("no worktree delete notes provider bound after activation");
    const answer = await binding.provideNotes(target.worktree, deadline.signal);
    const vetted = validatePluginWorktreeDeleteNotes(answer);
    if (!vetted.ok) throw new Error(vetted.error);
    return current() ? { status: "answered", notes: vetted.notes } : null;
  };

  try {
    const outcome = await Promise.race([ask(), expired]);
    if (outcome !== "expired") return outcome;
    console.warn(
      `[Plugin] worktree delete notes from "${pluginId}" timed out after ${timeoutMs}ms`
    );
    return current() ? NO_ANSWER : null;
  } catch (err) {
    console.warn(
      `[Plugin] worktree delete notes from "${pluginId}" failed: ${formatErrorMessage(err, "provider failed")}`
    );
    return current() ? NO_ANSWER : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every source's answer for one worktree, for the confirmation that can't
 * stream (the one put to someone when no window is open). Bounded by the same
 * per-plugin deadline, since the sources are asked side by side.
 */
export async function collectWorktreeDeleteNotes(
  host: WorktreeDeleteNotesHost,
  projectId: string,
  worktreeId: string
): Promise<WorktreeDeleteNotesReport[]> {
  const sources = listWorktreeDeleteNoteSources(host, projectId);
  const answers = await Promise.all(
    sources.map((source) => getWorktreeDeleteNotes(host, projectId, source.pluginId, worktreeId))
  );
  const reports: WorktreeDeleteNotesReport[] = [];
  sources.forEach((source, i) => {
    const answer = answers[i];
    if (answer) reports.push({ ...source, answer });
  });
  return reports;
}
