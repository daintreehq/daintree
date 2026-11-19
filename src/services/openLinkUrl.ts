import { systemClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { isLocalhostUrl, normalizeBrowserUrl } from "@/components/Browser/browserUtils";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
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

const LOG_PREFIX = "[openLinkUrl]";

/** Whether activating `panel` can bring it on screen: not trashed, parked or in a dialog. */
export function isReachable(panel: PanelInstance): boolean {
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
 * The dev preview in this worktree whose server is running at `origin`, the
 * most recently used when several are. Asked of main at the moment of the
 * click: the panel record's own dev-server fields are never written, and the
 * renderer's per-worktree session cache holds one session and fills only as
 * rows hydrate. A failed ask falls back to a browser pane.
 */
async function findServingDevPreview(
  worktreeId: string | null,
  origin: string
): Promise<PanelInstance | undefined> {
  let sessions: Awaited<ReturnType<typeof window.electron.devPreview.getAllSessions>>;
  try {
    sessions = await window.electron.devPreview.getAllSessions();
  } catch (error) {
    logError(`${LOG_PREFIX} Failed to read the dev servers`, error);
    return undefined;
  }
  // Read after the ask: a preview closed while it was out is in the trash now.
  const { panelsById } = usePanelStore.getState();
  let best: PanelInstance | undefined;
  let bestUsedAt = -1;
  for (const session of sessions) {
    if (session.status !== "running" || originOf(session.url) !== origin) continue;
    const panel = panelsById[session.panelId];
    if (!panel || !isDevPreviewPanel(panel) || (panel.worktreeId ?? null) !== worktreeId) continue;
    if (!isReachable(panel)) continue;
    const stamp = panel.lastActiveAt;
    const usedAt = stamp !== undefined && Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
    if (usedAt > bestUsedAt) {
      best = panel;
      bestUsedAt = usedAt;
    }
  }
  return best;
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

/**
 * `url` parsed as an absolute http(s) URL, in canonical form: a saved
 * `http:localhost:5173` (which URL parsing accepts) reads as the address it
 * names. Undefined for anything else, a bare host included.
 */
function absoluteWebUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The address `url` opens at in a panel: a loopback http(s) address, which the
 * strict browser rule accepts and nothing else does. Undefined for the rest.
 */
function panelAddress(url: string): string | undefined {
  const local = normalizeBrowserUrl(absoluteWebUrl(url) ?? url);
  return local.url !== undefined && isLocalhostUrl(local.url) ? local.url : undefined;
}

/**
 * `url` as the system browser gets it: exactly as saved, so a path, query or
 * sign-in that a pane's address rules would rewrite reaches the site intact.
 * Only http(s) passes. A bare host (`example.com/x`, `example.com:8080`, which
 * parses with the host as its scheme) is read as https, as terminal links are.
 */
function externalAddress(url: string): string | undefined {
  const trimmed = url.trim();
  if (absoluteWebUrl(trimmed) !== undefined) return trimmed;
  try {
    // Any other parsed scheme is refused, unless it is a bare host's name.
    if (!new URL(trimmed).protocol.includes(".")) return undefined;
  } catch {
    // Not absolute: a bare host, tried below.
  }
  const withScheme = `https://${trimmed}`;
  return absoluteWebUrl(withScheme) !== undefined ? withScheme : undefined;
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
  const origin = originOf(target);
  const preview = origin === null ? undefined : await findServingDevPreview(worktreeId, origin);
  const store = usePanelStore.getState();
  const existing = preview ?? pickReusableBrowser(store.panelIds, store.panelsById, worktreeId);
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
