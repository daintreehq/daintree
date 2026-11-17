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

/**
 * The most recently used panel `matches` accepts in the worktree that
 * activating can bring on screen. Trashed, parked and dialog panes stay in
 * `panelIds`, and navigating one looks to the user like the click did nothing
 * (#14965). A pane never used, or tied, keeps `panelIds` order behind any used one.
 */
function pickMostRecentPanel(
  panelIds: readonly string[],
  panelsById: Readonly<Record<string, PanelInstance>>,
  worktreeId: string | null,
  matches: (panel: PanelInstance) => boolean
): PanelInstance | undefined {
  let best: PanelInstance | undefined;
  let bestUsedAt = 0;
  for (const id of panelIds) {
    const panel = panelsById[id];
    if (!panel || (panel.worktreeId ?? null) !== worktreeId || !matches(panel)) continue;
    if (!isGridPanelLocation(panel.location) && panel.location !== "dock") continue;
    const stamp = panel.lastActiveAt;
    const usedAt = stamp !== undefined && Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
    if (best === undefined || usedAt > bestUsedAt) {
      best = panel;
      bestUsedAt = usedAt;
    }
  }
  return best;
}

/** The browser pane a localhost link takes over, when there is one to take. */
export function pickReusableBrowser(
  panelIds: readonly string[],
  panelsById: Readonly<Record<string, PanelInstance>>,
  worktreeId: string | null
): PanelInstance | undefined {
  return pickMostRecentPanel(panelIds, panelsById, worktreeId, isBrowserPanel);
}

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  const normalized = normalizeBrowserUrl(url);
  if (!normalized.url) return null;
  try {
    return new URL(normalized.url).origin;
  } catch {
    return null;
  }
}

/** A dev preview whose running server answers at `origin`. */
function pickServingDevPreview(
  panelIds: readonly string[],
  panelsById: Readonly<Record<string, PanelInstance>>,
  worktreeId: string | null,
  origin: string
): PanelInstance | undefined {
  return pickMostRecentPanel(
    panelIds,
    panelsById,
    worktreeId,
    (panel) =>
      isDevPreviewPanel(panel) &&
      panel.devServerStatus === "running" &&
      originOf(panel.devServerUrl) === origin
  );
}

/**
 * Bring `panelId` on screen and point it at `url`. A group renders its stored
 * tab over the focused one, so a pane behind another tab would take focus and
 * stay hidden. The store only records the address; the pane navigates (and, on
 * a host, forwards) on `browser.navigate`, which a dev preview also answers by
 * mapping the address onto its own proxy.
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
 * panel keeps the host's address and forwards the port itself.
 */
export async function openLinkUrl(url: string): Promise<void> {
  const target = panelAddress(url);
  if (target === undefined) {
    // Any http(s) host, which only the system browser is handed.
    const web = normalizeBrowserUrl(url, {});
    if (web.url === undefined) {
      // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
      notify({
        type: "error",
        title: "Couldn't open link",
        message: web.error ?? "The saved address isn't a web address.",
      });
      return;
    }
    openUrlExternally(web.url, LOG_PREFIX);
    return;
  }

  const worktreeId = useWorktreeSelectionStore.getState().activeWorktreeId ?? null;
  const store = usePanelStore.getState();
  const origin = originOf(target);
  const preview =
    origin === null
      ? undefined
      : pickServingDevPreview(store.panelIds, store.panelsById, worktreeId, origin);
  const existing = preview ?? pickReusableBrowser(store.panelIds, store.panelsById, worktreeId);
  if (existing) {
    showPanelAt(existing.id, target, LOG_PREFIX);
    return;
  }
  // The store raises its own notice when the panel limit refuses the pane.
  await store.addPanel({ kind: "browser", browserUrl: target, worktreeId: worktreeId ?? undefined });
}
