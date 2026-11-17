import { systemClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { isLocalhostUrl, normalizeBrowserUrl } from "@/components/Browser/browserUtils";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeDevServerStore } from "@/store/worktreeDevServerStore";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import {
  isBrowserPanel,
  isDevPreviewPanel,
  isGridPanelLocation,
  type PanelInstance,
} from "@shared/types/panel";
import {
  hostForwardFailure,
  remoteHostOfView,
  resolveTerminalLinkForHost,
} from "@/services/terminal/remoteLoopbackLinks";

/** Whether activating `panel` can bring it on screen: not trashed, parked or in a dialog. */
function isReachable(panel: PanelInstance): boolean {
  return isGridPanelLocation(panel.location) || panel.location === "dock";
}

/**
 * The browser pane a localhost link takes over: the most recently used one in
 * the worktree that activating can bring on screen. Trashed, parked and dialog
 * panes stay in `panelIds`, and navigating one looks to the user like the click
 * did nothing (#14965). A pane never used, or tied, keeps `panelIds` order
 * behind any used one.
 */
export function pickReusableBrowser(
  panelIds: readonly string[],
  panelsById: Readonly<Record<string, PanelInstance>>,
  worktreeId: string | null
): PanelInstance | undefined {
  let best: PanelInstance | undefined;
  let bestUsedAt = 0;
  for (const id of panelIds) {
    const panel = panelsById[id];
    if (!panel || !isBrowserPanel(panel) || (panel.worktreeId ?? null) !== worktreeId) continue;
    if (!isReachable(panel)) continue;
    const stamp = panel.lastActiveAt;
    const usedAt = stamp !== undefined && Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
    if (best === undefined || usedAt > bestUsedAt) {
      best = panel;
      bestUsedAt = usedAt;
    }
  }
  return best;
}

function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const normalized = normalizeBrowserUrl(url);
  if (!normalized.url) return null;
  try {
    return new URL(normalized.url).origin;
  } catch {
    return null;
  }
}

/**
 * The worktree's dev preview when its server is running at `origin`. Read from
 * main's session broadcasts: the panel record's own dev-server fields are
 * never written, so they can't say whether the server is up.
 */
function servingDevPreview(
  panelsById: Readonly<Record<string, PanelInstance>>,
  worktreeId: string | null,
  origin: string
): PanelInstance | undefined {
  if (worktreeId === null) return undefined;
  const session = useWorktreeDevServerStore.getState().sessionsByWorktreeId[worktreeId];
  if (session?.status !== "running" || originOf(session.url) !== origin) return undefined;
  const panel = panelsById[session.panelId];
  if (!panel || !isDevPreviewPanel(panel) || (panel.worktreeId ?? null) !== worktreeId) {
    return undefined;
  }
  return isReachable(panel) ? panel : undefined;
}

/**
 * Bring `panelId` on screen and point it at `url`. A group renders its stored
 * tab over the focused one, so a pane behind another tab would take focus and
 * stay hidden. The store only records the address; the pane navigates (and, on
 * a host, forwards) on `browser.navigate`, which a dev preview also answers by
 * mapping the address onto its own proxy, so its stored address stays its own.
 */
export function showPanelAt(panelId: string, url: string, logPrefix: string): void {
  const store = usePanelStore.getState();
  const panel = store.panelsById[panelId];
  if (panel && isBrowserPanel(panel)) store.setBrowserUrl(panelId, url);
  const group = store.getPanelGroup(panelId);
  if (group) store.setActiveTab(group.id, panelId);
  store.activateTerminal(panelId);
  actionService
    .dispatch("browser.navigate", { url, terminalId: panelId }, { source: "user" })
    .catch((error: unknown) => logError(`${logPrefix} Failed to navigate the browser`, error));
}

/** Hand `url` to the system browser, straight through IPC if the action is refused. */
export function openUrlExternally(url: string, logPrefix: string): void {
  actionService
    .dispatch("system.openExternal", { url }, { source: "user" })
    .then((result) => {
      if (result.ok) return;
      return systemClient.openExternal(url);
    })
    .catch((error: unknown) => logError(`${logPrefix} Failed to open URL`, error));
}

const LOG_PREFIX = "[openLinkUrl]";

/**
 * The address `url` opens at in a panel: a loopback http(s) address, which the
 * strict browser rule accepts and nothing else does. Undefined for the rest.
 */
function panelAddress(url: string): string | undefined {
  const local = normalizeBrowserUrl(url);
  return local.url !== undefined && isLocalhostUrl(local.url) ? local.url : undefined;
}

/**
 * `url` as the system browser gets it: exactly as saved, so a path, query or
 * sign-in that a pane's address rules would rewrite reaches the site intact.
 * A bare host is read as https, as terminal links are. Only http(s) passes.
 */
function externalAddress(url: string): string | undefined {
  const trimmed = url.trim();
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  try {
    const { protocol } = new URL(candidate);
    return protocol === "http:" || protocol === "https:" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function linkRefused(message: string): void {
  // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
  notify({ type: "error", title: "Couldn't open link", message });
}

/** Whether {@link openLinkUrl} shows `url` in a panel, which takes focus as it comes forward. */
export function opensInPanel(url: string): boolean {
  return panelAddress(url) !== undefined;
}

/**
 * Open a saved link where it belongs: an address on this machine in a panel
 * of the active worktree (the dev preview already serving it, else the last
 * browser pane used, else a new one), anything else in the system browser.
 * Nothing here embeds an outside address, so the browser pane's attach gate
 * keeps deciding what a pane may load. In a view bound to a remote host the
 * panel keeps the host's address and forwards the port itself, and an outside
 * address whose sign-in returns to the host's localhost gets that port
 * forwarded first, as a terminal link's does.
 */
export async function openLinkUrl(url: string): Promise<void> {
  const target = panelAddress(url);
  if (target === undefined) {
    const external = externalAddress(url);
    if (external === undefined) {
      linkRefused("Only http and https addresses can be opened.");
      return;
    }
    const hostId = remoteHostOfView();
    if (hostId === null) {
      openUrlExternally(external, LOG_PREFIX);
      return;
    }
    try {
      openUrlExternally(await resolveTerminalLinkForHost(external, hostId), LOG_PREFIX);
    } catch (error) {
      logError(`${LOG_PREFIX} Failed to forward the link's port`, error);
      linkRefused(hostForwardFailure(external, error));
    }
    return;
  }

  const worktreeId = useWorktreeSelectionStore.getState().activeWorktreeId ?? null;
  const store = usePanelStore.getState();
  const origin = originOf(target);
  const existing =
    (origin === null ? undefined : servingDevPreview(store.panelsById, worktreeId, origin)) ??
    pickReusableBrowser(store.panelIds, store.panelsById, worktreeId);
  if (existing) {
    showPanelAt(existing.id, target, LOG_PREFIX);
    return;
  }
  // The store raises its own notice when the panel limit refuses the pane.
  await store.addPanel({
    kind: "browser",
    browserUrl: target,
    worktreeId: worktreeId ?? undefined,
  });
}
