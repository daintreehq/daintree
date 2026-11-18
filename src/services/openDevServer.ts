import type { DevPreviewSessionState } from "@shared/types/ipc/devPreview";
import { isDevPreviewPanel, type PanelInstance } from "@shared/types/panel";
import ipaddr from "ipaddr.js";
import { isLoopbackHostname } from "@shared/utils/urlUtils";
import { focusPanelInItsWorktree } from "@/lib/panelNavigation";
import { notify } from "@/lib/notify";
import { isReachable, openUrlExternally } from "@/services/openLinkUrl";
import {
  hostForwardFailure,
  parseLoopbackLink,
  remoteHostOfView,
  resolveExternalPageForView,
} from "@/services/terminal/remoteLoopbackLinks";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { getWorktreeIdSet } from "@/store/storeAccessors";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { logError, logWarn } from "@/utils/logger";

const LOG_PREFIX = "[openDevServer]";

type DevServerSession = Pick<DevPreviewSessionState, "panelId" | "projectId" | "status" | "url">;

/**
 * The address a dev server opens at: its own, while it runs and has one that
 * a browser can load. Undefined for every other row, which opens nothing.
 */
export function devServerAddress(session: DevServerSession): string | undefined {
  if (session.status !== "running" || !session.url) return undefined;
  try {
    const { protocol } = new URL(session.url);
    return protocol === "http:" || protocol === "https:" ? session.url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The server's own dev preview, when it is a panel of this view that coming
 * forward can put on screen. Sessions are keyed by project and panel: another
 * project's panel id can be this one's too, and a trashed, parked or dialog
 * panel, or one whose worktree this view doesn't show, has nowhere to appear.
 */
export function devServerPanelInView(
  session: Pick<DevPreviewSessionState, "panelId" | "projectId">
): PanelInstance | undefined {
  const viewId = getViewWorkspaceId() ?? useProjectStore.getState().currentProject?.id;
  if (!viewId || session.projectId !== viewId) return undefined;
  const panel = usePanelStore.getState().panelsById[session.panelId];
  if (!panel || !isDevPreviewPanel(panel) || !isReachable(panel)) return undefined;
  const worktreeId = panel.worktreeId;
  if (
    worktreeId &&
    !getWorktreeIdSet()?.has(worktreeId) &&
    !useWorktreeSelectionStore.getState().deletedWorktrees.has(worktreeId)
  ) {
    return undefined;
  }
  return panel;
}

function devServerRefused(message: string): void {
  // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
  notify({ type: "error", title: "Couldn't open dev server", message });
}

function isWildcardAddress(host: string): boolean {
  const literal = host.replace(/^\[|\]$/g, "");
  try {
    return ipaddr.isValid(literal) && ipaddr.process(literal).range() === "unspecified";
  } catch {
    return false;
  }
}

/**
 * Whether a host's `hostname` names that host itself, so opened here it would
 * land on this machine instead: any loopback or wildcard spelling, and the
 * `.localhost` names a browser resolves to its own loopback.
 */
function namesTheHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    isLoopbackHostname(host) ||
    isWildcardAddress(host) ||
    host === "localhost" ||
    host.endsWith(".localhost")
  );
}

/**
 * Hand a dev server's address to the system browser. In a view bound to a
 * Remote Host the server is the host's, so its port is forwarded here first,
 * at the same port as the browser panel's own forward is: a dev server's
 * absolute URLs, redirects and sockets name that port, and on any other one
 * they would come back to whatever this machine runs there. When the port is
 * taken here, or the address can't be forwarded, nothing opens.
 */
export async function openDevServerExternally(url: string): Promise<void> {
  const hostId = remoteHostOfView();
  if (hostId === null) {
    openUrlExternally(url, LOG_PREFIX);
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    devServerRefused("The dev server's address isn't a valid URL.");
    return;
  }
  // Read as the system browser would read it, so a spelling the forwarding
  // doesn't parse (`http:localhost:5824`) can't slip past it unforwarded.
  const address = parsed.href;
  // The forward reaches the host's own localhost and nothing else, so any
  // other spelling of the host itself (127.0.0.2, app.localhost) has no
  // forward that reaches it, and opened as it is would reach this machine.
  if (parseLoopbackLink(address) === null && namesTheHost(parsed.hostname)) {
    devServerRefused(
      `${parsed.hostname} on the host can't be forwarded to this machine. Open it from the dev preview instead.`
    );
    return;
  }
  try {
    openUrlExternally(await resolveExternalPageForView(address, "Dev server"), LOG_PREFIX);
  } catch (error) {
    logError(`${LOG_PREFIX} Failed to forward the dev server's port`, error);
    devServerRefused(hostForwardFailure(address, error));
  }
}

/**
 * Bring `panel` on screen with the keyboard in it, switching to its worktree
 * when it lives in another. A group renders its stored tab over the focused
 * one, so a preview behind another tab would take focus and stay hidden.
 * Nothing navigates: the preview keeps whatever page it was showing.
 */
async function showDevServerPanel(panel: PanelInstance): Promise<void> {
  const store = usePanelStore.getState();
  const group = store.getPanelGroup(panel.id);
  if (group) store.setActiveTab(group.id, panel.id);
  if (!(await focusPanelInItsWorktree(panel.id, panel.worktreeId))) {
    logWarn(`${LOG_PREFIX} The dev preview couldn't be brought forward`, { panelId: panel.id });
  }
}

/**
 * Open a running dev server where it lives: its own dev preview when that is
 * a panel of this view, else its address in the system browser.
 */
export async function openDevServer(session: DevServerSession): Promise<void> {
  const url = devServerAddress(session);
  if (url === undefined) return;
  const panel = devServerPanelInView(session);
  if (panel) {
    await showDevServerPanel(panel);
    return;
  }
  await openDevServerExternally(url);
}
