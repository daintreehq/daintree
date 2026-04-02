import { systemClient } from "@/clients";
import { actionService } from "@/services/ActionService";
import { isLocalhostUrl, normalizeBrowserUrl } from "@/components/Browser/browserUtils";
import { useTerminalStore } from "@/store/terminalStore";
import { isMac } from "@/lib/platform";

export class TerminalLinkHandler {
  openLink(url: string, terminalId: string, event?: MouseEvent): void {
    const mac = isMac();
    const isModifierPressed = event ? (mac ? event.metaKey : event.ctrlKey) : false;

    const normalized = normalizeBrowserUrl(url);

    if (isModifierPressed && normalized.url && isLocalhostUrl(normalized.url)) {
      const store = useTerminalStore.getState();
      const currentTerminal = store.terminals.find((t) => t.id === terminalId);

      if (!currentTerminal) {
        this.openExternal(url);
        return;
      }

      const targetWorktreeId = currentTerminal.worktreeId ?? null;

      const existingBrowser = store.terminals.find(
        (t) => t.kind === "browser" && (t.worktreeId ?? null) === targetWorktreeId
      );

      if (existingBrowser) {
        store.setBrowserUrl(existingBrowser.id, normalized.url);
        store.activateTerminal(existingBrowser.id);
      } else {
        void store.addTerminal({
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
        console.error("[TerminalLinkHandler] Failed to open URL:", error);
      });
  }
}
