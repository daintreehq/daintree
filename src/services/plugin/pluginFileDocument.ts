import type {
  FileEditorMode,
  PluginFileDocument,
  PluginFileDocumentChange,
  PluginFileDocumentReadResult,
  PluginFileDocumentSaveResult,
} from "@shared/types/plugin";
import { useFileDocumentStore, type FileDocumentProjection } from "@/store/fileDocumentStore";
import { logWarn } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { relativeFilePath } from "@/registry/fileEditorGlob";
import { pluginFileDocumentIdentity } from "./pluginFileDocumentIdentity";

/**
 * The host-owned document behind a view-backed file editor (#13809).
 *
 * One record per panel and file. The record — not the plugin view — owns the
 * draft, the revision it was based on and the conflict state, so:
 *
 * - switching to Source and back, or swapping one editor for another, keeps
 *   the draft (the next view reads it back with `getDraft`);
 * - the record publishes the same `fileDocumentStore` projection the built-in
 *   Markdown editor does, so the dirty dot, Rendered draft preview and the
 *   Save / Discard / Cancel prompt on close apply unchanged — and the prompt's
 *   Save works after the view has unmounted;
 * - reads and writes go through main's `fileDocument` namespace, which
 *   confines the file to the panel's root and does the revision compare at
 *   write time.
 *
 * Renderer-local and per project view, like `fileDocumentStore`.
 */
export interface PluginFileDocumentTarget {
  panelId: string;
  projectId: string;
  filePath: string;
  fileName: string;
  rootPath: string;
  mode: FileEditorMode;
  maxBytes: number;
}

interface DocumentRecord {
  key: string;
  panelId: string;
  identityKey: string;
  filePath: string;
  fileName: string;
  rootPath: string;
  maxBytes: number;
  /**
   * The revision the draft is based on: the last one read or saved while
   * clean. A read while a draft stands does not move it — otherwise the close
   * prompt's Save would quietly write the draft over a change it never saw.
   */
  revision: string | null;
  /** The last disk state a disk-change check saw, so one change is reported once. */
  observedState: string | null;
  draft: string | null;
  /** Observed by the host: a save refused as stale, or the disk moving under a draft. */
  hostConflict: boolean;
  /** Reported by the editor itself. */
  viewConflict: boolean;
  listeners: Set<(change: PluginFileDocumentChange) => void>;
  mounts: number;
  /** Saves in flight: the record outlives its views until they settle. */
  pending: number;
  /** The projection this record last published, so it only ever clears its own. */
  projection: FileDocumentProjection | null;
}

const records = new Map<string, DocumentRecord>();

function recordKey(panelId: string, filePath: string): string {
  return `${panelId}\u0000${filePath}`;
}

function publish(record: DocumentRecord): void {
  const store = useFileDocumentStore.getState();
  if (record.mounts === 0 && record.draft === null && record.pending === 0) {
    // No draft and nobody editing: the document is released. Only this
    // record's own projection and map entry go — a newer record for the same
    // panel and file may already hold both.
    if (record.projection !== null && store.byPanelId[record.panelId] === record.projection) {
      store.clearFileDocument(record.panelId);
    }
    record.projection = null;
    if (records.get(record.key) === record) records.delete(record.key);
    return;
  }
  const projection: FileDocumentProjection = {
    identityKey: record.identityKey,
    fileName: record.fileName,
    draftText: record.draft,
    dirty: record.draft !== null,
    conflict: record.hostConflict || record.viewConflict,
    save: () => saveDraft(record),
    discard: async () => discardDraft(record),
  };
  record.projection = projection;
  store.setFileDocument(record.panelId, projection);
}

/** The revision on disk as last observed; null when gone or unreadable as text. */
function diskRevisionOf(record: DocumentRecord): string | null {
  const state = record.observedState;
  return state === null || state.startsWith("status:") ? null : state;
}

function emit(record: DocumentRecord, change: PluginFileDocumentChange): void {
  for (const listener of [...record.listeners]) {
    try {
      listener(change);
    } catch (err) {
      logWarn("[PluginFileDocument] A file editor's change listener threw", { error: err });
    }
  }
}

async function read(record: DocumentRecord): Promise<PluginFileDocumentReadResult> {
  try {
    const result = await window.electron.fileDocument.read({
      rootPath: record.rootPath,
      filePath: record.filePath,
      maxBytes: record.maxBytes,
    });
    if (result.status === "ok") {
      record.observedState = result.revision;
      if (record.draft === null) {
        record.revision = result.revision;
        if (record.hostConflict) {
          record.hostConflict = false;
          publish(record);
        }
      }
    }
    return result;
  } catch (err) {
    logWarn("[PluginFileDocument] Read failed", { error: err });
    return { status: "unavailable" };
  }
}

async function save(
  record: DocumentRecord,
  text: string,
  expectedRevision: string
): Promise<PluginFileDocumentSaveResult> {
  let result: PluginFileDocumentSaveResult;
  record.pending += 1;
  try {
    result = await window.electron.fileDocument.save({
      rootPath: record.rootPath,
      filePath: record.filePath,
      maxBytes: record.maxBytes,
      text,
      expectedRevision,
    });
  } catch (err) {
    result = { status: "error", message: formatErrorMessage(err, "Save failed") };
  } finally {
    record.pending -= 1;
  }
  if (result.status === "saved") {
    record.revision = result.revision;
    record.observedState = result.revision;
    // Typing that landed while the save was in flight stays a draft.
    if (record.draft === text) record.draft = null;
    record.hostConflict = false;
    record.viewConflict = false;
    publish(record);
  } else if (result.status === "conflict") {
    record.observedState = result.revision;
    record.hostConflict = true;
    publish(record);
  } else {
    publish(record);
  }
  return result;
}

/** The close prompt's Save: the host's draft against the revision it was based on. */
async function saveDraft(record: DocumentRecord): Promise<boolean> {
  const draft = record.draft;
  if (draft === null) return true;
  if (record.revision === null) return false;
  const result = await save(record, draft, record.revision);
  if (result.status !== "saved") return false;
  emit(record, { reason: "saved", revision: result.revision });
  return record.draft === null;
}

function discardDraft(record: DocumentRecord): void {
  record.draft = null;
  record.hostConflict = false;
  record.viewConflict = false;
  emit(record, { reason: "discarded", revision: diskRevisionOf(record) });
  publish(record);
}

function createDocument(record: DocumentRecord, mode: FileEditorMode): PluginFileDocument {
  const readOnly = mode === "view";
  return Object.freeze({
    filePath: record.filePath,
    relativePath:
      relativeFilePath(record.rootPath, record.filePath) ?? record.filePath.replace(/\\/g, "/"),
    fileName: record.fileName,
    mode,
    readOnly,
    read: () => read(record),
    save: async (text: string, options: { expectedRevision: string }) => {
      if (readOnly) return { status: "refused", reason: "read-only" } as const;
      if (typeof text !== "string" || typeof options?.expectedRevision !== "string") {
        return { status: "error", message: "save(text, { expectedRevision }) needs both" } as const;
      }
      return save(record, text, options.expectedRevision);
    },
    getDraft: () => record.draft,
    setDraft: (text: string | null) => {
      if (readOnly) return;
      const next = typeof text === "string" ? text : null;
      if (next === record.draft) return;
      record.draft = next;
      publish(record);
    },
    setConflict: (conflict: boolean) => {
      if (readOnly || record.viewConflict === Boolean(conflict)) return;
      record.viewConflict = Boolean(conflict);
      publish(record);
    },
    onDidChange: (listener: (change: PluginFileDocumentChange) => void) => {
      if (typeof listener !== "function") return () => {};
      record.listeners.add(listener);
      return () => {
        record.listeners.delete(listener);
      };
    },
  });
}

export interface PluginFileDocumentHandle {
  document: PluginFileDocument;
  /** Hold the document open while a view shows it. Returns the release. */
  retain: () => () => void;
  /** The panel saw the file change on disk: re-check its revision. */
  notifyDiskChange: () => Promise<void>;
}

/**
 * The document for a panel's file, created on first use and shared by every
 * editor that opens it from that panel. The returned facade is per mode, so a
 * `view` editor's is read-only even when an `edit` editor holds a draft.
 */
export function openPluginFileDocument(target: PluginFileDocumentTarget): PluginFileDocumentHandle {
  const key = recordKey(target.panelId, target.filePath);
  let record = records.get(key);
  if (!record) {
    record = {
      key,
      panelId: target.panelId,
      identityKey: pluginFileDocumentIdentity(target.projectId, target.filePath),
      filePath: target.filePath,
      fileName: target.fileName,
      rootPath: target.rootPath,
      maxBytes: target.maxBytes,
      revision: null,
      observedState: null,
      draft: null,
      hostConflict: false,
      viewConflict: false,
      listeners: new Set(),
      mounts: 0,
      pending: 0,
      projection: null,
    };
    records.set(key, record);
  }
  // The editor in front decides the ceiling; a draft from a roomier one is
  // refused at save rather than dropped.
  record.maxBytes = target.maxBytes;
  record.rootPath = target.rootPath;
  const live = record;
  return {
    document: createDocument(live, target.mode),
    retain: () => {
      live.mounts += 1;
      if (!records.has(live.key)) records.set(live.key, live);
      publish(live);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        live.mounts -= 1;
        publish(live);
      };
    },
    notifyDiskChange: async () => {
      let state: string;
      try {
        const result = await window.electron.fileDocument.read({
          rootPath: live.rootPath,
          filePath: live.filePath,
          maxBytes: live.maxBytes,
        });
        // A file that grew past the ceiling or stopped decoding changed too;
        // the view hears about it as a change with no readable revision.
        state = result.status === "ok" ? result.revision : `status:${result.status}`;
      } catch {
        return;
      }
      if (state === live.observedState) return;
      live.observedState = state;
      // Nothing read yet means nothing to be stale against; the view's first
      // read sees whatever is there now.
      if (live.revision === null || state === live.revision) return;
      if (live.draft !== null && !live.hostConflict) {
        live.hostConflict = true;
        publish(live);
      }
      emit(live, { reason: "disk", revision: diskRevisionOf(live) });
    },
  };
}

/** Test-only: drop every record. */
export function _resetPluginFileDocumentsForTest(): void {
  records.clear();
}
