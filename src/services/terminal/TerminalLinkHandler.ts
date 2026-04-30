import { systemClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { isLocalhostUrl, normalizeBrowserUrl } from "@/components/Browser/browserUtils";
import { usePanelStore } from "@/store/panelStore";
import { isMac } from "@/lib/platform";
import { logError } from "@/utils/logger";

export class TerminalLinkHandler {
  openLink(url: string, terminalId: string, event?: MouseEvent): void {
    const mac = isMac();
    const isModifierPressed = event ? (mac ? event.metaKey : event.ctrlKey) : false;

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
      } else {
        void store.addPanel({
          kind: "browser",
          browserUrl: normalized.url,
          worktreeId: targetWorktreeId ?? undefined,
          cwd: currentTerminal?.cwd ?? "",
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
