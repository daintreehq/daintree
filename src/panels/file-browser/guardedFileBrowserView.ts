import { isFileBrowserPanel, type FileBrowserPanelData } from "@shared/types/panel";
import { consultPanelCloseGuards } from "@/services/panelCloseGuard";
import { getFileDocumentProjection } from "@/store/fileDocumentStore";
import { usePanelStore } from "@/store/panelStore";
import type { FileBrowserViewPatch } from "@/store/slices/panelRegistry/fileBrowser";

export type FileBrowserNavigationOutcome = "applied" | "cancelled" | "superseded" | "unavailable";

/**
 * The selection change each browser is waiting to apply. Module-level rather
 * than per pane, so a reveal dispatched from elsewhere and a click in the tree
 * supersede each other: whichever asked last lands, and an older request that
 * shared the same Save / Discard / Cancel answer never writes over it.
 */
const latestNavigation = new Map<string, symbol>();

/**
 * The name of the file whose unsaved edits moving `panel`'s selection to
 * `selectedPath` would leave behind, or null when the move leaves nothing (no
 * selection change, the same file, or a clean document).
 */
export function unsavedDraftLeftBy(
  panel: FileBrowserPanelData,
  selectedPath: string | null | undefined
): string | null {
  if (selectedPath === undefined || (selectedPath ?? undefined) === panel.browserSelectedPath) {
    return null;
  }
  const projection = getFileDocumentProjection(panel.id);
  if (!projection?.dirty) return null;
  return projection.fileName ?? panel.browserSelectedPath?.split("/").pop() ?? "this file";
}

/**
 * Writes `patch` to a file-browser panel, holding any selection change behind
 * the panel's close guard while its document has unsaved edits (#17197). The
 * editor releases its document the moment `browserSelectedPath` moves, so
 * every route that moves it — the tree, the folder listing, a reveal — has to
 * ask first.
 *
 * A patch without a selection writes straight through. A selection that leaves
 * nothing dirty behind also writes synchronously, before this returns its
 * promise. Only a dirty move waits, and it builds its patch again from the
 * record as it stands once the prompt is answered: expansions or a root the
 * user changed meanwhile are theirs to keep.
 *
 * `isTarget` re-checks, after the wait, that the panel is still the one the
 * caller meant; a panel that closed or moved answers "unavailable".
 */
export function navigateFileBrowserView(
  panelId: string,
  patch: FileBrowserViewPatch | ((panel: FileBrowserPanelData) => FileBrowserViewPatch),
  isTarget?: (panel: FileBrowserPanelData) => boolean
): Promise<FileBrowserNavigationOutcome> {
  const read = (): FileBrowserPanelData | undefined => {
    const panel = usePanelStore.getState().panelsById[panelId];
    return panel !== undefined && isFileBrowserPanel(panel) && (isTarget?.(panel) ?? true)
      ? panel
      : undefined;
  };
  const build = (panel: FileBrowserPanelData) =>
    typeof patch === "function" ? patch(panel) : patch;
  const write = (next: FileBrowserViewPatch) =>
    usePanelStore.getState().setFileBrowserView(panelId, next);

  const panel = read();
  if (!panel) return Promise.resolve("unavailable");
  const first = build(panel);
  if (first.browserSelectedPath === undefined) {
    write(first);
    return Promise.resolve("applied");
  }
  const token = Symbol(panelId);
  latestNavigation.set(panelId, token);
  if (unsavedDraftLeftBy(panel, first.browserSelectedPath) === null) {
    latestNavigation.delete(panelId);
    write(first);
    return Promise.resolve("applied");
  }
  return consultPanelCloseGuards([panelId])
    .then((proceed): FileBrowserNavigationOutcome => {
      if (latestNavigation.get(panelId) !== token) return "superseded";
      if (!proceed) return "cancelled";
      const current = read();
      if (!current) return "unavailable";
      write(build(current));
      return "applied";
    })
    .finally(() => {
      if (latestNavigation.get(panelId) === token) latestNavigation.delete(panelId);
    });
}

export function __resetFileBrowserNavigationForTests(): void {
  latestNavigation.clear();
}
