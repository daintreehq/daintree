import { create } from "zustand";
import type { DocumentIdentity, Eol } from "../shared/protocol.js";

/**
 * The renderer's document model for the Markdown editor (#12323), keyed by
 * document identity so two panels on the same file share one record. The
 * CodeMirror view is deliberately not in here: this is what a document *is*
 * — its base, its draft, whether the disk moved under it — and it is testable
 * without mounting an editor. Per project view, like every renderer store.
 */
export interface DocumentBase {
  text: string;
  revision: string;
  hasBom: boolean;
  eol: Eol;
  mixedEol: boolean;
  size: number;
}

export type DocumentRefusal = "NOT_MARKDOWN" | "NOT_UTF8" | "TOO_LARGE" | "SYMLINK" | "NOT_A_FILE";

export interface DocumentConflict {
  /** The revision on disk when the conflict was detected. */
  revision: string;
  /** The disk text, when it decoded; null when it did not or could not be read. */
  text: string | null;
  hasBom: boolean;
  eol: Eol;
}

export interface DocumentRecord {
  identity: DocumentIdentity;
  status: "loading" | "ready" | "refused" | "unavailable";
  refusal: DocumentRefusal | null;
  base: DocumentBase | null;
  /** The unsaved buffer and the base it was typed against; null when clean. */
  draft: { text: string; baseRevision: string } | null;
  conflict: DocumentConflict | null;
  saving: boolean;
  /** The last save or persistence failure, in the words the banner shows. */
  error: string | null;
  /** Recovery storage refused the draft; the in-memory draft is all there is. */
  storageWarning: string | null;
  /**
   * Bumped whenever the editor must take a fresh state — and a fresh undo
   * history: first load, a clean reload after an external change, loading
   * the disk version over a conflict, discarding a draft.
   */
  loadGeneration: number;
  /** Bumped when the draft text moved, so a sibling view can catch up. */
  textVersion: number;
}

interface DocumentStateStore {
  records: Readonly<Record<string, DocumentRecord>>;
  upsert: (key: string, update: (record: DocumentRecord) => DocumentRecord) => void;
  set: (key: string, record: DocumentRecord) => void;
  remove: (key: string) => void;
}

export function createDocumentRecord(identity: DocumentIdentity): DocumentRecord {
  return {
    identity,
    status: "loading",
    refusal: null,
    base: null,
    draft: null,
    conflict: null,
    saving: false,
    error: null,
    storageWarning: null,
    loadGeneration: 0,
    textVersion: 0,
  };
}

export const useDocumentStateStore = create<DocumentStateStore>()((set) => ({
  records: {},
  upsert: (key, update) =>
    set((state) => {
      const current = state.records[key];
      if (!current) return state;
      return { records: { ...state.records, [key]: update(current) } };
    }),
  set: (key, record) => set((state) => ({ records: { ...state.records, [key]: record } })),
  remove: (key) =>
    set((state) => {
      if (!(key in state.records)) return state;
      const { [key]: _removed, ...rest } = state.records;
      return { records: rest };
    }),
}));

/** The text the editor should show: the draft while one exists, else the base. */
export function currentText(record: DocumentRecord): string | null {
  return record.draft?.text ?? record.base?.text ?? null;
}
