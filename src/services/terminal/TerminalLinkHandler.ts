import { isLocalhostUrl, normalizeBrowserUrl } from "@/components/Browser/browserUtils";
import { usePanelStore } from "@/store/panelStore";
import { isMac } from "@/lib/platform";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { isPtyPanel } from "@shared/types/panel";
import { isLocalHostId, type HostId } from "@shared/types/remoteHosts";
import {
  hostForwardFailure,
  parseLoopbackLink,
  remoteHostOfView,
  resolveTerminalLinkForHost,
} from "./remoteLoopbackLinks";
import { activatePluginUrlLink } from "./pluginTerminalLinks";
import { openUrlExternally, pickReusableBrowser, showPanelAt } from "@/services/openLinkUrl";

const LOG_PREFIX = "[TerminalLinkHandler]";

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
        showPanelAt(existingBrowser.id, normalized.url, LOG_PREFIX);
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
    openUrlExternally(normalizedUrl, LOG_PREFIX);
  }
}
