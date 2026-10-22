import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { broadcastToProjectRenderers } from "../utils.js";
import { WORKTREE_TITLES_METHOD_CHANNELS } from "./worktreeTitles.preload.js";
import {
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

function snapshotOf(projectId: string, stored: StoredWorktreeCustomTitles): WorktreeTitlesSnapshot {
  return { projectId, titles: { ...stored.titles }, revision: stored.revision };
}

/** Every view of the project: the sidebar and the overview can sit in different windows. */
function publish(snapshot: WorktreeTitlesSnapshot): WorktreeTitlesSnapshot {
  broadcastToProjectRenderers(snapshot.projectId, CHANNELS.WORKTREE_TITLES_CHANGED, snapshot);
  return snapshot;
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
 * Read the titles, handing over the ones the view kept in localStorage first
 * if this project has never had any here. `null` for a sender with no project
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
  const stored = importLegacyWorktreeCustomTitles(projectId, legacyTitles);
  const snapshot = snapshotOf(projectId, stored);
  return stored.revision !== before && Object.keys(stored.titles).length > 0
    ? publish(snapshot)
    : snapshot;
}

async function handleSet(
  ctx: IpcContext,
  worktreeId: string,
  title: string | null
): Promise<WorktreeTitlesSnapshot> {
  if (!ctx.projectId) throw new Error("worktree titles: sender has no project");
  const projectId = ctx.projectId;
  const before = getWorktreeCustomTitles(projectId).revision;
  const stored = setWorktreeCustomTitle(projectId, worktreeId, title);
  const snapshot = snapshotOf(projectId, stored);
  return stored.revision !== before ? publish(snapshot) : snapshot;
}

export const worktreeTitlesNamespace = defineIpcNamespace({
  name: "worktreeTitles",
  ops: {
    hydrate: op(WORKTREE_TITLES_METHOD_CHANNELS.hydrate, handleHydrate, { withContext: true }),
    set: op(WORKTREE_TITLES_METHOD_CHANNELS.set, handleSet, { withContext: true }),
  },
});

export function registerWorktreeTitlesHandlers(): () => void {
  return worktreeTitlesNamespace.register();
}
