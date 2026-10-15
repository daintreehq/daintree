import type { HostId } from "../../../shared/types/remoteHosts.js";
import type { BackgroundRestoreResult } from "../../window/ProjectViewRestoreController.js";

export type HostProjectViewResult =
  | { status: "ready"; webContentsId: number; created: boolean }
  /** No window here shows the host, so there is nowhere to keep a view without taking one over. */
  | { status: "no-window" }
  /** Every window on the host is at its cached-view ceiling or under memory pressure. */
  | { status: "no-room" }
  /** A window is opening that project right now, or its view is still loading. */
  | { status: "busy" }
  | { status: "failed" };

/** Where a project's one view stands in some window, as the window registry sees it. */
export interface HostProjectViewOwner {
  state: "foreground" | "activating" | "cached";
  /** The view entry, once registered: its load state and its live WebContents id. */
  entry: { state: string; webContentsId: number | null } | null;
}

export interface HostProjectViewDeps {
  /** The window with a view of the key, or one opening it; null when no window has it. */
  owner(key: string): HostProjectViewOwner | null;
  /** The windows showing the host, in the order they were bound to it. */
  windowsOn(hostId: HostId): readonly number[];
  /** Restores the key in the background in that window; null when the window has no views. */
  restore(
    windowId: number,
    key: string,
    projectPath: string
  ): Promise<BackgroundRestoreResult | null>;
  /** Marks the window as opening the key, so no other window opens it meanwhile. */
  claim(key: string, windowId: number): () => void;
}

/**
 * A live view of a host's project: the one some window already has, or one
 * restored in the background into a window already on that host, never shown
 * and never taking focus. A view is what a host assistant's tool calls run
 * through, so starting one on the person's behalf needs one; kept in a window
 * on that host, opening the project there later just shows it.
 */
export async function prepareHostProjectView(
  deps: HostProjectViewDeps,
  key: string,
  hostId: HostId,
  projectPath: string
): Promise<HostProjectViewResult> {
  /** Where the project's one view stands now: usable, on its way, or nowhere. */
  const current = (): HostProjectViewResult | null => {
    const owner = deps.owner(key);
    if (!owner) return null;
    // Registered before it loads: a view still loading has no renderer to dispatch into yet.
    if (
      owner.state === "activating" ||
      !owner.entry ||
      owner.entry.state === "loading" ||
      owner.entry.webContentsId === null
    ) {
      return { status: "busy" };
    }
    return { status: "ready", webContentsId: owner.entry.webContentsId, created: false };
  };
  const existing = current();
  if (existing) return existing;
  const windows = deps.windowsOn(hostId);
  if (windows.length === 0) return { status: "no-window" };
  let deferred = false;
  for (const windowId of windows) {
    // Checked before every window: the person may have opened it meanwhile.
    const now = current();
    if (now) return now;
    const release = deps.claim(key, windowId);
    try {
      const result = await deps.restore(windowId, key, projectPath);
      if (result === null) continue;
      if (result.status === "deferred") {
        deferred = true;
        continue;
      }
      // Cancelled (the person switched to it) or failed: never try another
      // window, which could leave the project with two views.
      if (result.status === "skipped") return { status: "busy" };
      const made = current();
      if (made?.status === "ready") return { ...made, created: result.status === "restored" };
      return made ?? { status: "failed" };
    } finally {
      release();
    }
  }
  return { status: deferred ? "no-room" : "failed" };
}
