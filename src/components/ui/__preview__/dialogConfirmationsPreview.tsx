// First: the bridge must exist before any client module reads it.
import { installPreviewShims } from "@/components/HelpPanel/__preview__/previewShims";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PluginArchiveInstallConfirmDialog } from "@/components/Plugin/PluginArchiveInstallConfirmDialog";
import { usePluginArchiveInstallStore } from "@/store/pluginArchiveInstallStore";
import { FileDocumentCloseGuardHost } from "@/panels/file/FileDocumentCloseGuardHost";
import { useFileDocumentStore } from "@/store/fileDocumentStore";
import { consultPanelCloseGuards, hasPanelCloseGuard } from "@/services/panelCloseGuard";
import { NonGitFolderDialog } from "@/components/Project/NonGitFolderDialog";
import "@/index.css";

/**
 * Visual-review harness for dialog chrome and destructive confirmations.
 *
 * Renders the product's own dialogs through their real data seams — the
 * archive-install store, the file-document projection store and the panel
 * close-guard registry — against the real theme tokens. The bridge calls they
 * make are answered here; everything above them is the product's.
 *
 * Query parameters:
 *   ?theme=daintree|bondi|…       built-in theme id
 *   ?state=archive|close-guard|non-git
 *
 * `archive` holds the install call open forever, so a click on Install leaves
 * the confirm in its busy state. `close-guard` asks the guard host to close a
 * dirty file panel on mount; its Save and Discard never settle either.
 */

const params = new URLSearchParams(window.location.search);
const state = params.get("state") ?? "archive";

const never = <T,>() => new Promise<T>(() => {});

installPreviewShims({
  plugin: new Proxy(
    { installFromPath: () => never() },
    { get: (target, key) => (key in target ? Reflect.get(target, key) : () => undefined) }
  ),
});

applyAppThemeToRoot(document.documentElement, resolveAppTheme(params.get("theme") ?? "daintree"));
document.body.style.background = "var(--color-surface-canvas)";
document.body.style.margin = "0";

const PANEL_ID = "preview-file-panel";
/** How often to look for the host's guard before asking it to close. */
const GUARD_POLL_MS = 50;

function seed() {
  if (state === "archive") {
    usePluginArchiveInstallStore.getState().enqueue({
      intentId: "preview-archive",
      archivePath: "/Users/you/Downloads/linear-sync-2.4.0.dntr",
      archiveFileName: "linear-sync-2.4.0.dntr",
      manifest: {
        name: "linear-sync",
        displayName: "Linear Sync",
        version: "2.4.0",
        category: "workspace",
        authors: [{ name: "Helios Labs" }],
        capabilities: ["network:fetch", "fs:project-read"],
        recipes: { count: 0, names: [] },
      },
    });
  }
  if (state === "close-guard") {
    useFileDocumentStore.getState().setFileDocument(PANEL_ID, {
      identityKey: PANEL_ID,
      fileName: "retry-backoff.ts",
      draftText: "export const jitter = 0.2;\n",
      dirty: true,
      conflict: false,
      save: () => never(),
      discard: () => never(),
    });
  }
}

function Preview() {
  useEffect(() => {
    if (state !== "close-guard") return;
    // Once the host has registered its guard for the dirty panel.
    let asked = false;
    const timer = setInterval(() => {
      if (asked || !hasPanelCloseGuard(PANEL_ID)) return;
      asked = true;
      clearInterval(timer);
      void consultPanelCloseGuards([PANEL_ID]);
    }, GUARD_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <div data-preview-shell className="h-screen w-screen">
      {state === "archive" && <PluginArchiveInstallConfirmDialog />}
      {state === "close-guard" && <FileDocumentCloseGuardHost />}
      {state === "non-git" && (
        <NonGitFolderDialog
          isOpen
          directoryPath="/Users/you/Code/helios-dashboard"
          initialStep="choice"
          onOpenWithoutGit={() => undefined}
          onInitSuccess={() => undefined}
          onCancel={() => undefined}
        />
      )}
    </div>
  );
}

seed();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Preview />
    </TooltipProvider>
  </StrictMode>
);
