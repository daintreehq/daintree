import { systemClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { isLocalhostUrl, normalizeBrowserUrl } from "@/components/Browser/browserUtils";
import { usePanelStore } from "@/store/panelStore";
import { isMac } from "@/lib/platform";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import {
  isBrowserPanel,
  isGridPanelLocation,
  isPtyPanel,
  type PanelInstance,
} from "@shared/types/panel";
import { isLocalHostId, type HostId } from "@shared/types/remoteHosts";
import {
  hostForwardFailure,
  parseLoopbackLink,
  remoteHostOfView,
  resolveTerminalLinkForHost,
} from "./remoteLoopbackLinks";
import { activatePluginUrlLink } from "./pluginTerminalLinks";

export interface OpenLinkOptions {
  /**
   * Open in the external browser even when a plugin claims the URL — the
   * escape hatch every URL keeps (#13798).
   */
  external?: boolean;
  /**
   * The host the terminal that printed the link runs on, when that need not be
   * this view's: Canopy shows other hosts' runs, and their `localhost` is theirs.
   */
  hostId?: HostId;
}

/**
 * The browser pane a modifier-clicked localhost link takes over: the most
 * recently used one in the worktree that activating can bring on screen.
 * Trashed, parked and dialog panes stay in `panelIds`, and navigating one looks
 * to the user like the click did nothing (#14965). A pane never used, or tied,
 * keeps `panelIds` order behind any used one.
 */
function pickReusableBrowser(
  panelIds: readonly string[],
  panelsById: Readonly<Record<string, PanelInstance>>,
  worktreeId: string | null
): PanelInstance | undefined {
  let best: PanelInstance | undefined;
  let bestUsedAt = 0;
  for (const id of panelIds) {
    const panel = panelsById[id];
    if (!panel || !isBrowserPanel(panel) || (panel.worktreeId ?? null) !== worktreeId) continue;
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

export class TerminalLinkHandler {
  /**
   * `terminalId` is the terminal as this view's panels know it, or null for
   * one this view doesn't hold (another project's or host's run in Canopy):
   * no plugin, browser pane or worktree here is its, so its links open on
   * their own.
   */
  openLink(
    url: string,
    terminalId: string | null,
    event?: MouseEvent,
    options?: OpenLinkOptions
  ): void {
    // A plugin may claim only a public http(s) host, never a loopback one, so
    // its claim needs none of the port forwarding below.
    if (!options?.external && terminalId !== null && activatePluginUrlLink(url, terminalId)) {
      return;
    }
    const isModifierPressed =
      !options?.external && event ? (isMac() ? event.metaKey : event.ctrlKey) : false;
    const hostId =
      options?.hostId === undefined
        ? remoteHostOfView()
        : isLocalHostId(options.hostId)
          ? null
          : options.hostId;
    if (hostId === null) {
      this.openResolvedLink(url, terminalId, isModifierPressed);
      return;
    }
    // A panel keeps the host's address and forwards the port itself; handing it
    // the rewritten local port would forward that port from the host instead.
    if (
      isModifierPressed &&
      parseLoopbackLink(url) !== null &&
      terminalId !== null &&
      usePanelStore.getState().panelsById[terminalId]
    ) {
      this.openResolvedLink(url, terminalId, true);
      return;
    }
    resolveTerminalLinkForHost(url, hostId).then(
      (resolved) => this.openResolvedLink(resolved, terminalId, isModifierPressed),
      (error: unknown) => {
        logError("[TerminalLinkHandler] Failed to forward the link's port", error);
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Couldn't open link",
          message: hostForwardFailure(url, error),
        });
      }
    );
  }

  private openResolvedLink(
    url: string,
    terminalId: string | null,
    isModifierPressed: boolean
  ): void {
    const normalized = normalizeBrowserUrl(url);

    if (isModifierPressed && normalized.url && isLocalhostUrl(normalized.url)) {
      const store = usePanelStore.getState();
      const currentTerminal = terminalId === null ? undefined : store.panelsById[terminalId];

      if (!currentTerminal) {
        this.openExternal(url);
        return;
      }

      const targetWorktreeId = currentTerminal.worktreeId ?? null;

      const existingBrowser = pickReusableBrowser(
        store.panelIds,
        store.panelsById,
        targetWorktreeId
      );

      if (existingBrowser) {
        store.setBrowserUrl(existingBrowser.id, normalized.url);
        // A group renders its stored tab over the focused one, so a pane behind
        // another tab would take focus and stay hidden.
        const group = store.getPanelGroup(existingBrowser.id);
        if (group) store.setActiveTab(group.id, existingBrowser.id);
        store.activateTerminal(existingBrowser.id);
        // The store only records the address; the pane navigates (and, on a host, forwards) on this.
        actionService
          .dispatch(
            "browser.navigate",
            { url: normalized.url, terminalId: existingBrowser.id },
            { source: "user" }
          )
          .catch((error) =>
            logError("[TerminalLinkHandler] Failed to navigate the browser", error)
          );
      } else {
        void store.addPanel({
          kind: "browser",
          browserUrl: normalized.url,
          worktreeId: targetWorktreeId ?? undefined,
          cwd: (isPtyPanel(currentTerminal) ? currentTerminal.cwd : undefined) ?? "",
        });
      }
    } else {
      this.openExternal(url);
    }
  }

  private openExternal(url: string): void {
    const normalizedUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    actionService
      .dispatch("system.openExternal", { url: normalizedUrl }, { source: "user" })
      .then((result) => {
        if (result.ok) return;
        return systemClient.openExternal(normalizedUrl);
      })
      .catch((error) => {
        logError("[TerminalLinkHandler] Failed to open URL", error);
      });
  }
}
