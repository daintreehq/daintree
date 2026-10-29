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
/**
 * How a {@link FileDocumentProjection.save} came out. `reason` is one
 * user-facing clause: `conflict` is disk moving under the draft, `unavailable`
 * the file gone or unreadable, `refused` a save that never started (too large,
 * still loading, newer edits left over), `error` a write that failed.
 */
export type FileDocumentSaveOutcome =
  | { status: "saved" }
  | { status: "conflict" | "unavailable" | "refused" | "error"; reason: string };

export interface FileDocumentProjection {
  /** Opaque identity the plugin keys the underlying document by. */
  identityKey: string;
  /** The selected document's name, including when hosted by a file browser. */
  fileName?: string;
  /** The unsaved buffer, or null when the document is clean. */
  draftText: string | null;
  dirty: boolean;
  /**
   * The current draft is held in durable recovery storage. Absent means the
   * plugin does not say, which reads as not recoverable.
   */
  recoveryStored?: boolean;
  /** Disk moved under a dirty draft, or a save was refused as stale. */
  conflict: boolean;
  /**
   * Save the draft. Resolves `saved` once the document is clean; anything
   * else means the draft is still standing, with the reason in words the
   * close prompt can show where the editor's own banner isn't on screen.
   */
  save: () => Promise<FileDocumentSaveOutcome>;
  /** Drop the draft and its recovery record. */
  discard: () => Promise<void>;
}

interface FileDocumentState {
  byPanelId: Readonly<Record<string, FileDocumentProjection>>;
  /**
   * Publish a panel's projection. A standing draft belongs to its document:
   * a projection for a different document never replaces a dirty one, so an
   * editor the user has moved away from — the built-in editor beside a plugin
   * editor (#13809) — can't wipe the other's draft out of the dirty mark and
   * the close prompt.
   */
  setFileDocument: (panelId: string, projection: FileDocumentProjection) => void;
  /** Drop a panel's projection; with `identityKey`, only if it is still that document's. */
  clearFileDocument: (panelId: string, identityKey?: string) => void;
}

export const useFileDocumentStore = create<FileDocumentState>()((set) => ({
  byPanelId: {},
  setFileDocument: (panelId, projection) =>
    set((state) => {
      const current = state.byPanelId[panelId];
      if (current?.dirty && current.identityKey !== projection.identityKey) return state;
      return { byPanelId: { ...state.byPanelId, [panelId]: projection } };
    }),
  clearFileDocument: (panelId, identityKey) =>
    set((state) => {
      const current = state.byPanelId[panelId];
      if (current === undefined) return state;
      if (identityKey !== undefined && current.identityKey !== identityKey) return state;
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

/** A dirty draft that nothing durable would bring back after the view is destroyed. */
export function hasUnrecoverableFileDraft(): boolean {
  return Object.values(useFileDocumentStore.getState().byPanelId).some(
    (projection) => projection.dirty && projection.recoveryStored !== true
  );
}
