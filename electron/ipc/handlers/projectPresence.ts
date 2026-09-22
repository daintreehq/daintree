import { CHANNELS } from "../channels.js";
import { broadcastToRenderer } from "../utils.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import { defineIpcNamespace, op } from "../define.js";
import { buildProjectPresence } from "../../window/projectPresence.js";
import { onProjectPresenceChanged } from "../../window/projectPresenceChanges.js";
import type { ProjectPresenceSnapshot } from "../../../shared/types/ipc/projectPresence.js";
import { PROJECT_PRESENCE_METHOD_CHANNELS } from "./projectPresence.preload.js";

/**
 * One switch moves the inventory, the active pointer and a claim within a few
 * ticks of each other. Held from the first change rather than restarted by each
 * one, so a steady stream of changes still reaches an open switcher.
 */
export const PROJECT_PRESENCE_BROADCAST_DELAY_MS = 50;

const EMPTY_SNAPSHOT: ProjectPresenceSnapshot = { thisWindow: [], otherWindows: [] };

export function createProjectPresenceNamespace(deps: HandlerDependencies) {
  /**
   * Relative to the window that asked, resolved from the sender itself. A
   * sender with no window can't be placed, and guessing one — the primary, say
   * — would mark that window's own projects as open somewhere else.
   */
  const getSnapshot = (ctx: IpcContext): ProjectPresenceSnapshot => {
    const windowId = ctx.senderWindow?.id;
    if (windowId === undefined) return EMPTY_SNAPSHOT;
    const projectViewManager =
      deps.windowRegistry?.getByWindowId(windowId)?.services.projectViewManager;
    return buildProjectPresence(deps.windowRegistry, { windowId, projectViewManager });
  };

  return defineIpcNamespace({
    name: "projectPresence",
    ops: {
      getSnapshot: op(
        PROJECT_PRESENCE_METHOD_CHANNELS.getSnapshot,
        async (ctx): Promise<ProjectPresenceSnapshot> => getSnapshot(ctx),
        { withContext: true }
      ),
    },
  });
}

export function registerProjectPresenceHandlers(deps: HandlerDependencies): () => void {
  // Namespace first, so a duplicate-channel throw leaves no listener behind.
  const namespaceCleanup = createProjectPresenceNamespace(deps).register();

  // Payload-free: each renderer asks again for its own window's view, which
  // only main can compute. Every renderer, cached ones included — a switcher
  // left open in a view that went to the background still has to be right
  // when the view comes back, and nothing replays this on reactivation.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = onProjectPresenceChanged(() => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      broadcastToRenderer(CHANNELS.PROJECT_PRESENCE_CHANGED);
    }, PROJECT_PRESENCE_BROADCAST_DELAY_MS);
  });

  return () => {
    unsubscribe();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    namespaceCleanup();
  };
}
