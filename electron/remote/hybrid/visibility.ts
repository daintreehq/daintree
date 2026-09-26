import { z } from "zod";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { setRemoteVisibleProjectIdsProvider } from "../../window/activeProjectIds.js";
import type { HostServer } from "../host/HostServer.js";
import type { LinkSession } from "../link/session.js";
import { getRemoteService, registerRemoteService } from "../runtime.js";

/** Shell → Host CALL: whether a view is the one its window is showing. */
export const ENDPOINT_VISIBILITY_METHOD = "endpoint.visibility";

const EndpointVisibilitySchema = z.object({
  endpointId: z.string().min(1).max(256),
  visible: z.boolean(),
});

export type EndpointVisibilityReport = z.infer<typeof EndpointVisibilitySchema>;

type Registry = Pick<ReturnType<typeof getEndpointRegistry>, "get" | "getRemote" | "onChange">;

/**
 * Host side: which remote views are on screen. Kept explicitly from the
 * Shells' reports, because a cached view keeps its endpoint (and its project
 * binding) while its window shows another one. A view that has not reported
 * yet counts as visible: every caller asks in order to protect a project, and
 * guessing "hidden" would let one Shell background a project another is
 * displaying.
 */
export class EndpointVisibility {
  private readonly hidden = new Set<string>();
  private readonly off: () => void;

  constructor(private readonly registry: Registry = getEndpointRegistry()) {
    // Forget closed endpoints so the set never outlives the views it describes.
    this.off = registry.onChange(() => {
      for (const endpointId of [...this.hidden]) {
        const endpoint = registry.get(endpointId);
        if (!endpoint || endpoint.isClosed()) this.hidden.delete(endpointId);
      }
    });
  }

  report(endpointId: string, visible: boolean): void {
    const endpoint = this.registry.get(endpointId);
    if (!endpoint || endpoint.kind !== "remote-view" || endpoint.isClosed()) return;
    if (visible) this.hidden.delete(endpointId);
    else this.hidden.add(endpointId);
  }

  isVisible(endpointId: string): boolean {
    return !this.hidden.has(endpointId);
  }

  /**
   * Projects some remote Shell is displaying right now. Read live on every
   * call, so a guard that re-checks after an await sees views that appeared
   * meanwhile.
   */
  visibleProjectIds(): Set<string> {
    const ids = new Set<string>();
    for (const endpoint of this.registry.getRemote()) {
      if (endpoint.projectId !== null && this.isVisible(endpoint.endpointId)) {
        ids.add(endpoint.projectId);
      }
    }
    return ids;
  }

  isProjectVisibleRemotely(projectId: string): boolean {
    for (const endpoint of this.registry.getRemote()) {
      if (endpoint.projectId === projectId && this.isVisible(endpoint.endpointId)) return true;
    }
    return false;
  }

  dispose(): void {
    this.off();
    this.hidden.clear();
  }
}

declare module "../runtime.js" {
  interface RemoteServices {
    endpointVisibility: EndpointVisibility;
  }
}

/**
 * Host side: answer the Shells' visibility reports on every session (a resume
 * is a new link session, so each one registers again) and publish the result
 * for the close/background guards.
 */
export function installEndpointVisibility(
  options: {
    server?: Pick<HostServer, "onSession"> | null;
    registry?: Registry;
  } = {}
): () => void {
  const visibility = new EndpointVisibility(options.registry);
  const unregister = registerRemoteService("endpointVisibility", visibility);
  // Read live on every call, so the close guard's re-check after an await sees
  // views that appeared meanwhile.
  const offGuard = setRemoteVisibleProjectIdsProvider(() => visibility.visibleProjectIds());
  const server = options.server === undefined ? getRemoteService("hostServer") : options.server;
  const offSession =
    server?.onSession(({ sessionId, session }) => {
      session.registerCallHandler(
        ENDPOINT_VISIBILITY_METHOD,
        EndpointVisibilitySchema,
        ({ endpointId, visible }) => {
          // Scoped to the calling session's own endpoints (SessionHost's id
          // scheme), so one Shell can never mark another's view hidden.
          visibility.report(`remote:${sessionId}:${endpointId}`, visible);
          return null;
        }
      );
    }) ?? (() => undefined);
  return () => {
    offSession();
    offGuard();
    unregister();
    visibility.dispose();
  };
}

interface ReportedView {
  session: LinkSession;
  endpointId: string;
}

/**
 * Shell side: tell each host which of its views are the ones their windows
 * show. Fed by the view-activation and endpoint-lifecycle hooks; a report is
 * re-sent whenever a view's endpoint lands on a (new) session, so a resume or
 * reconnect restores the host's picture.
 */
export class ViewVisibilityReporter {
  private readonly views = new Map<number, ReportedView>();
  private readonly activeByWindow = new Map<number, number>();

  noteEndpointOpened(info: { session: LinkSession; webContentsId: number; endpointId: string }) {
    this.views.set(info.webContentsId, { session: info.session, endpointId: info.endpointId });
    this.send(info.webContentsId);
  }

  noteEndpointClosed(webContentsId: number, endpointId: string): void {
    if (this.views.get(webContentsId)?.endpointId === endpointId) this.views.delete(webContentsId);
  }

  /** `webContentsId` is now the view `windowId` shows; the one it replaced is not. */
  noteViewActivated(windowId: number, webContentsId: number): void {
    const previous = this.activeByWindow.get(windowId);
    this.activeByWindow.set(windowId, webContentsId);
    if (previous !== undefined && previous !== webContentsId) this.send(previous);
    this.send(webContentsId);
  }

  noteWindowClosed(windowId: number): void {
    this.activeByWindow.delete(windowId);
  }

  private isActive(webContentsId: number): boolean {
    for (const active of this.activeByWindow.values()) {
      if (active === webContentsId) return true;
    }
    return false;
  }

  private send(webContentsId: number): void {
    const view = this.views.get(webContentsId);
    if (!view || !view.session.isOpen) return;
    const report: EndpointVisibilityReport = {
      endpointId: view.endpointId,
      visible: this.isActive(webContentsId),
    };
    view.session.call(ENDPOINT_VISIBILITY_METHOD, report).catch(() => {
      // The host re-learns on the next session; unreported views count as visible there.
    });
  }
}
