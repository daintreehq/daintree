import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

/**
 * The host's view of a file panel's editable document (#12323). A file editor
 * plugin owns the document — base text, revision, draft, conflict state — and
 * publishes this projection per panel so host surfaces can act on it without
 * importing the plugin:
 *
 * - `FilePane` shows the dirty indicator in every mode, previews `draftText`
 *   in Rendered mode, and holds the close of a dirty panel behind a
 *   Save / Discard / Cancel prompt whose Save and Discard call back into
 *   the plugin through {@link FileDocumentProjection.save} and
 *   {@link FileDocumentProjection.discard}.
 *
 * Keyed by panel id rather than document identity: two panels on the same
 * file each carry a projection, and the plugin keeps them consistent. A
 * projection outlives the editor view — it is document state, not view
 * state — and is cleared only when the plugin releases the document.
 *
 * Renderer-local and per project view, like every store under `src/store`.
 */
export interface FileDocumentProjection {
  /** Opaque identity the plugin keys the underlying document by. */
  identityKey: string;
  /** The unsaved buffer, or null when the document is clean. */
  draftText: string | null;
  dirty: boolean;
  /** Disk moved under a dirty draft, or a save was refused as stale. */
  conflict: boolean;
  /**
   * Save the draft. Resolves true once the document is clean; false when the
   * save was refused (conflict, error) and the draft is still standing.
   */
  save: () => Promise<boolean>;
  /** Drop the draft and its recovery record. */
  discard: () => Promise<void>;
}

interface FileDocumentState {
  byPanelId: Readonly<Record<string, FileDocumentProjection>>;
  setFileDocument: (panelId: string, projection: FileDocumentProjection) => void;
  clearFileDocument: (panelId: string) => void;
}

export const useFileDocumentStore = create<FileDocumentState>()((set) => ({
  byPanelId: {},
  setFileDocument: (panelId, projection) =>
    set((state) => ({ byPanelId: { ...state.byPanelId, [panelId]: projection } })),
  clearFileDocument: (panelId) =>
    set((state) => {
      if (!(panelId in state.byPanelId)) return state;
      const { [panelId]: _removed, ...rest } = state.byPanelId;
      return { byPanelId: rest };
    }),
}));

/** The draft text for a panel, or null when clean or not editable. */
export function useFileDocumentDraftText(panelId: string): string | null {
  return useFileDocumentStore((state) => state.byPanelId[panelId]?.draftText ?? null);
}

/** Dirty and conflict flags for a panel, as one stable pair. */
export function useFileDocumentFlags(panelId: string): { dirty: boolean; conflict: boolean } {
  return useFileDocumentStore(
    useShallow((state) => {
      const projection = state.byPanelId[panelId];
      return { dirty: projection?.dirty ?? false, conflict: projection?.conflict ?? false };
    })
  );
}

export function getFileDocumentProjection(panelId: string): FileDocumentProjection | undefined {
  return useFileDocumentStore.getState().byPanelId[panelId];
}
