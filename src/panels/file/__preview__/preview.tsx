import "./installShims";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { resolveAppTheme } from "@shared/theme/themes";
import type { FilePanelData } from "@shared/types/panel";
import type { Project } from "@shared/types/project";
import { applyAppThemeToRoot } from "@/theme/applyAppTheme";
import { WorktreeStoreProvider } from "@/contexts/WorktreeStoreContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { primeRadix } from "@/components/ui/radix-loader";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { usePluginContextMenuItemsStore } from "@/store/pluginContextMenuItemsStore";
import { FilePane } from "../FilePane";
import { PROJECT_ROOT } from "./fixtures";
import "@/index.css";

/**
 * Standalone visual-review harness for the file pane's empty state: the "Open a
 * file" picker a File panel shows before it has a file.
 *
 * Mounts the real `FilePane` (and so the real `ContentPanel` frame, `EmptyState`,
 * `SearchField` and result list) against the real theme tokens, with a file panel
 * row that has no `filePath` and a project to search. `files:search` is answered
 * from `fixtures.ts`; `?search=fail` makes every search reject instead.
 *
 * Query parameters (the screenshot spec drives these):
 *   ?theme=daintree|bondi|…   built-in theme id
 *   ?w=560&h=520              the pane's size in CSS pixels
 *   ?search=fail              every search rejects
 *   ?repo=many                a repository past the picker's 50-row cap
 */

const params = new URLSearchParams(window.location.search);
const themeId = params.get("theme") ?? "daintree";
const width = Number(params.get("w") ?? 560);
const height = Number(params.get("h") ?? 520);

const PANE_ID = "file-picker-preview";
const noop = () => {};

const panelRow: FilePanelData = {
  id: PANE_ID,
  kind: "file",
  title: "File",
  location: "grid",
  fileViewMode: "source",
} as FilePanelData;

const project: Project = {
  id: "acme-platform",
  path: PROJECT_ROOT,
  name: "acme-platform",
  emoji: "🌲",
  lastOpened: 0,
};

// Seeded before the first render: React flags a store write from inside a
// component body as a cross-component update.
usePanelStore.setState({
  panelsById: { [PANE_ID]: panelRow },
  panelIds: [PANE_ID],
} as Partial<ReturnType<typeof usePanelStore.getState>>);
useProjectStore.setState({ currentProject: project } as Partial<
  ReturnType<typeof useProjectStore.getState>
>);
// The pane's context menu pulls plugin items over IPC on mount, and the shimmed
// bridge resolves `undefined` where the store expects an array.
usePluginContextMenuItemsStore.setState({ entries: [], init: () => {} });

function App() {
  const [ready, setReady] = useState(false);
  const scheme = useMemo(() => resolveAppTheme(themeId), []);

  useEffect(() => {
    applyAppThemeToRoot(document.documentElement, scheme);
    document.body.style.background = "var(--color-surface-grid, var(--color-surface-canvas))";
    document.body.style.margin = "0";
    setReady(true);
  }, [scheme]);

  if (!ready) return null;

  return (
    <div data-preview-shell style={{ padding: 16, width: "max-content" }}>
      <div style={{ width, height, display: "flex", flexDirection: "column" }}>
        <FilePane
          id={PANE_ID}
          title="File"
          isFocused
          location="grid"
          onFocus={noop}
          onClose={noop}
        />
      </div>
    </div>
  );
}

void primeRadix().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <WorktreeStoreProvider>
        <TooltipProvider delayDuration={300}>
          <App />
        </TooltipProvider>
      </WorktreeStoreProvider>
    </StrictMode>
  );
});
