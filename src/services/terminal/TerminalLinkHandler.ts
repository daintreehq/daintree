import { systemClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { isLocalhostUrl, normalizeBrowserUrl } from "@/components/Browser/browserUtils";
import { usePanelStore } from "@/store/panelStore";
import { isMac } from "@/lib/platform";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { isPtyPanel } from "@shared/types/panel";
import {
  hostForwardFailure,
  parseLoopbackLink,
  remoteHostOfView,
  resolveTerminalLinkForView,
} from "./remoteLoopbackLinks";
import { activatePluginUrlLink } from "./pluginTerminalLinks";

export interface OpenLinkOptions {
  /**
   * Open in the external browser even when a plugin claims the URL — the
   * escape hatch every URL keeps (#13798).
   */
  external?: boolean;
}

export class TerminalLinkHandler {
  openLink(url: string, terminalId: string, event?: MouseEvent, options?: OpenLinkOptions): void {
    // A plugin may claim only a public http(s) host, never a loopback one, so
    // its claim needs none of the port forwarding below.
    if (!options?.external && activatePluginUrlLink(url, terminalId)) return;
    const isModifierPressed =
      !options?.external && event ? (isMac() ? event.metaKey : event.ctrlKey) : false;
    if (remoteHostOfView() === null) {
      this.openResolvedLink(url, terminalId, isModifierPressed);
      return;
    }
    // A panel keeps the host's address and forwards the port itself; handing it
    // the rewritten local port would forward that port from the host instead.
    if (
      isModifierPressed &&
      parseLoopbackLink(url) !== null &&
      usePanelStore.getState().panelsById[terminalId]
    ) {
      this.openResolvedLink(url, terminalId, true);
      return;
    }
    resolveTerminalLinkForView(url).then(
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

  private openResolvedLink(url: string, terminalId: string, isModifierPressed: boolean): void {
    const normalized = normalizeBrowserUrl(url);

    if (isModifierPressed && normalized.url && isLocalhostUrl(normalized.url)) {
      const store = usePanelStore.getState();
      const currentTerminal = store.panelsById[terminalId];

      if (!currentTerminal) {
        this.openExternal(url);
        return;
      }

      const targetWorktreeId = currentTerminal.worktreeId ?? null;

      const existingBrowser = store.panelIds
        .map((id) => store.panelsById[id])
        .find((t) => t && t.kind === "browser" && (t.worktreeId ?? null) === targetWorktreeId);

      if (existingBrowser) {
        store.setBrowserUrl(existingBrowser.id, normalized.url);
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
