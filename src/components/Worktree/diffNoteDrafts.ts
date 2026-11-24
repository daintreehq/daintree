import { createContext, use, useEffect, useState, useSyncExternalStore } from "react";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import type { DiffNoteAnchor } from "./diffNotes";

export type DiffNoteLineAnchor = Extract<DiffNoteAnchor, { kind: "lines" }>;

/**
 * Which note editors are open. Typed text is kept apart (see `readBody`) so a
 * keystroke never rebuilds the diff's widget map under the caret.
 */
interface DiffNoteDraftState {
  /**
   * Each file's open line composer, with the hash of the rows it was opened
   * on. A refresh that changes those rows leaves the draft pointing at what the
   * reviewer was reading, rather than rehashing whatever now sits there.
   */
  lines: Readonly<Record<string, DiffNoteLineAnchor>>;
  /** Files with an open file-note composer. */
  files: Readonly<Record<string, true>>;
  /** Saved notes being rewritten, by note id. */
  edits: Readonly<Record<string, true>>;
  /**
   * The editor a gesture just opened or moved, until it has taken focus. Held
   * for the view that made the gesture (`owner`), and only that view's editor
   * claims it: after the commit that shows it, so it reaches a composer moved
   * to another row or one whose row mounts frames later, but never an editor
   * restored by another view — a refresh's remount, the fallback list after a
   * layout switch, a return to the file — which stays out of the way.
   */
  focus: { key: string; owner: object } | null;
}

/**
 * Unsaved note drafts for one diff pane. Owned above everything that comes and
 * goes while the reviewer writes — a refresh's skeleton, the rendered Markdown
 * layout, a revision change that remounts the file, a visit to another file —
 * so none of them takes typed text with it. Never persisted: a draft lasts as
 * long as its pane, which the store's pending notes outlive.
 */
export interface DiffNoteDraftSession {
  subscribe: (listener: () => void) => () => void;
  getState: () => DiffNoteDraftState;
  /** Opens a file's line composer, or moves it; its typed text goes with it. */
  openLine: (fileKey: string, anchor: DiffNoteLineAnchor) => void;
  closeLine: (fileKey: string) => void;
  openFile: (fileKey: string) => void;
  closeFile: (fileKey: string) => void;
  openEdit: (noteId: string) => void;
  closeEdit: (noteId: string) => void;
  readBody: (bodyKey: string) => string | undefined;
  writeBody: (bodyKey: string, body: string) => void;
  requestFocus: (bodyKey: string, owner: object) => void;
  /** Called by the editor once it has taken the focus asked for it. */
  consumeFocus: (bodyKey: string) => void;
}

const EMPTY_STATE: DiffNoteDraftState = { lines: {}, files: {}, edits: {}, focus: null };

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

export function diffNoteFileKey(worktreePath: string, filePath: string): string {
  return `${worktreePath}\u0000${filePath}`;
}

export function lineDraftBodyKey(fileKey: string): string {
  return `line\u0000${fileKey}`;
}

export function fileDraftBodyKey(fileKey: string): string {
  return `file\u0000${fileKey}`;
}

export function editDraftBodyKey(noteId: string): string {
  return `edit\u0000${noteId}`;
}

export function createDiffNoteDraftSession(): DiffNoteDraftSession {
  let state = EMPTY_STATE;
  const listeners = new Set<() => void>();
  const bodies = new Map<string, string>();

  const update = (next: DiffNoteDraftState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  // A closed draft drops its text and any focus still waiting for its editor.
  const discard = (bodyKey: string): Pick<DiffNoteDraftState, "focus"> => {
    bodies.delete(bodyKey);
    return { focus: state.focus?.key === bodyKey ? null : state.focus };
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    openLine: (fileKey, anchor) =>
      update({ ...state, lines: { ...state.lines, [fileKey]: anchor } }),
    closeLine: (fileKey) => {
      const rest = discard(lineDraftBodyKey(fileKey));
      if (fileKey in state.lines) {
        update({ ...state, ...rest, lines: without(state.lines, fileKey) });
      }
    },
    openFile: (fileKey) => {
      if (!state.files[fileKey]) update({ ...state, files: { ...state.files, [fileKey]: true } });
    },
    closeFile: (fileKey) => {
      const rest = discard(fileDraftBodyKey(fileKey));
      if (fileKey in state.files) {
        update({ ...state, ...rest, files: without(state.files, fileKey) });
      }
    },
    openEdit: (noteId) => {
      if (!state.edits[noteId]) update({ ...state, edits: { ...state.edits, [noteId]: true } });
    },
    closeEdit: (noteId) => {
      const rest = discard(editDraftBodyKey(noteId));
      if (noteId in state.edits) {
        update({ ...state, ...rest, edits: without(state.edits, noteId) });
      }
    },
    readBody: (bodyKey) => bodies.get(bodyKey),
    writeBody: (bodyKey, body) => {
      bodies.set(bodyKey, body);
    },
    requestFocus: (bodyKey, owner) => {
      if (state.focus?.key !== bodyKey || state.focus.owner !== owner) {
        update({ ...state, focus: { key: bodyKey, owner } });
      }
    },
    consumeFocus: (bodyKey) => {
      if (state.focus?.key === bodyKey) update({ ...state, focus: null });
    },
  };
}

export const DiffNoteDraftContext = createContext<DiffNoteDraftSession | null>(null);

/**
 * Holds the store's send guard on every note this session is rewriting, for as
 * long as the edit is open — not just while its card is mounted, so a note
 * whose editor is between placements (a refresh, a layout switch) isn't sent
 * out from under it. Released when the edit closes or the session goes.
 */
function useEditGuards(session: DiffNoteDraftSession | null): void {
  useEffect(() => {
    if (!session) return;
    const held = new Set<string>();
    const reconcile = () => {
      const { edits } = session.getState();
      const { setEditing } = useDiffNotesStore.getState();
      for (const id of Object.keys(edits)) {
        if (held.has(id)) continue;
        held.add(id);
        setEditing(id, true);
      }
      for (const id of [...held]) {
        if (edits[id]) continue;
        held.delete(id);
        setEditing(id, false);
      }
    };
    reconcile();
    const unsubscribe = session.subscribe(reconcile);
    return () => {
      unsubscribe();
      const { setEditing } = useDiffNotesStore.getState();
      for (const id of held) setEditing(id, false);
      held.clear();
    };
  }, [session]);
}

/** A session for a pane to own and provide. */
export function useOwnDiffNoteDraftSession(): DiffNoteDraftSession {
  const [session] = useState(createDiffNoteDraftSession);
  useEditGuards(session);
  return session;
}

/**
 * The pane's session, or — for a viewer or list mounted without one — a session
 * of the caller's own, which lasts only as long as the caller does.
 */
export function useDiffNoteDraftSession(): DiffNoteDraftSession {
  const provided = use(DiffNoteDraftContext);
  const [own] = useState(createDiffNoteDraftSession);
  useEditGuards(provided ? null : own);
  return provided ?? own;
}

export function useDiffNoteDraftState<T>(
  session: DiffNoteDraftSession,
  select: (state: DiffNoteDraftState) => T
): T {
  return useSyncExternalStore(session.subscribe, () => select(session.getState()));
}
