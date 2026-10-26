import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { broadcastToProjectRenderers } from "../utils.js";
import { WORKTREE_TITLES_METHOD_CHANNELS } from "./worktreeTitles.preload.js";
import { confirmGoneWorktrees } from "./liveWorktrees.js";
import {
  clearWorktreeCustomTitles,
  getWorktreeCustomTitles,
  importLegacyWorktreeCustomTitles,
  setWorktreeCustomTitle,
  type StoredWorktreeCustomTitles,
} from "../../services/worktreeCustomTitles.js";
import type { WorktreeTitlesSnapshot } from "../../../shared/types/ipc/worktreeTitles.js";

/**
 * The SENDER project's custom worktree titles (#14022). No op takes a project
 * id: main resolves it from the sender's own view registration, so a view can
 * only ever read or change the titles of the project it shows.
 */

/** More stale ids than any sidebar holds; anything past it is not a prune. */
const MAX_PRUNE_IDS = 1000;

function snapshotOf(projectId: string, stored: StoredWorktreeCustomTitles): WorktreeTitlesSnapshot {
  return { projectId, titles: { ...stored.titles }, revision: stored.revision };
}

/**
 * Every view of the project gets the result of a write — the sidebar and the
 * overview can sit in different windows — and the writer gets it as its reply.
 */
function reply(projectId: string, before: number, stored: StoredWorktreeCustomTitles) {
  const snapshot = snapshotOf(projectId, stored);
  if (stored.revision !== before) {
    broadcastToProjectRenderers(projectId, CHANNELS.WORKTREE_TITLES_CHANGED, snapshot);
  }
  return snapshot;
}

function requireProjectId(ctx: IpcContext): string {
  if (!ctx.projectId) throw new Error("worktree titles: sender has no project");
  return ctx.projectId;
}

/**
 * A window attached to this host from another machine reads that machine's
 * localStorage, so its legacy titles describe the Shell's copy, never this
 * host's.
 */
function fromRemoteView(ctx: IpcContext): boolean {
  return ctx.endpoint?.kind === "remote-view" || ctx.client?.kind !== "local";
}

/**
 * Read the titles, first handing over the ones the view kept in localStorage
 * for any worktree main has no record of. `null` for a sender with no project
 * binding yet: a relaunch restores the last project before its view is
 * registered, so the view reads again rather than adopting an empty set.
 */
async function handleHydrate(
  ctx: IpcContext,
  legacyTitles: Record<string, string>
): Promise<WorktreeTitlesSnapshot | null> {
  if (!ctx.projectId) return null;
  const projectId = ctx.projectId;
  if (fromRemoteView(ctx)) return snapshotOf(projectId, getWorktreeCustomTitles(projectId));
  const before = getWorktreeCustomTitles(projectId).revision;
  return reply(projectId, before, importLegacyWorktreeCustomTitles(projectId, legacyTitles));
}

async function handleSet(
  ctx: IpcContext,
  worktreeId: string,
  title: string | null
): Promise<WorktreeTitlesSnapshot> {
  const projectId = requireProjectId(ctx);
  const before = getWorktreeCustomTitles(projectId).revision;
  return reply(projectId, before, setWorktreeCustomTitle(projectId, worktreeId, title));
}

/**
 * Clear the titles of worktrees the view no longer lists, but only those the
 * workspace host confirms are gone. A view's list can lag a sibling's: a title
 * pushed for a worktree it hasn't heard of yet is not stale, and a clear here
 * would reach every view and every plugin. Nothing is cleared when the host
 * can't answer.
 */
async function handlePrune(
  ctx: IpcContext,
  staleWorktreeIds: string[]
): Promise<WorktreeTitlesSnapshot> {
  const projectId = requireProjectId(ctx);
  if (!Array.isArray(staleWorktreeIds) || staleWorktreeIds.length > MAX_PRUNE_IDS) {
    throw new Error("worktree titles: staleWorktreeIds must be a list of worktree ids");
  }
  const held = getWorktreeCustomTitles(projectId);
  const candidates = staleWorktreeIds.filter(
    (id) => typeof id === "string" && Object.hasOwn(held.titles, id)
  );
  if (candidates.length === 0) return snapshotOf(projectId, held);
  const gone = await confirmGoneWorktrees(projectId, candidates, "worktreeTitles");
  // Re-read after the awaits, so the reply never carries an older set than a push sent meanwhile.
  const before = getWorktreeCustomTitles(projectId).revision;
  return reply(projectId, before, clearWorktreeCustomTitles(projectId, gone));
}

export const worktreeTitlesNamespace = defineIpcNamespace({
  name: "worktreeTitles",
  ops: {
    hydrate: op(WORKTREE_TITLES_METHOD_CHANNELS.hydrate, handleHydrate, { withContext: true }),
    set: op(WORKTREE_TITLES_METHOD_CHANNELS.set, handleSet, { withContext: true }),
    prune: op(WORKTREE_TITLES_METHOD_CHANNELS.prune, handlePrune, { withContext: true }),
  },
});

export function registerWorktreeTitlesHandlers(): () => void {
  return worktreeTitlesNamespace.register();
}
