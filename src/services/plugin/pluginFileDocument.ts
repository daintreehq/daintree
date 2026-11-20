import type {
  FileEditorMode,
  PluginFileDocument,
  PluginFileDocumentChange,
  PluginFileDocumentReadResult,
  PluginFileDocumentSaveResult,
} from "@shared/types/plugin";
import {
  useFileDocumentStore,
  type FileDocumentProjection,
  type FileDocumentSaveOutcome,
} from "@/store/fileDocumentStore";
import { logWarn } from "@/utils/logger";
import { clientErrorText } from "@/utils/clientAppError";
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
  /** The ceiling a save is held to: the editor that owns the draft's, never a viewer's. */
  maxBytes: number;
  /**
   * The revision the standing draft is based on: the one its editor reported
   * when the draft started, or the one a save of that draft wrote. No read
   * moves it. Reads overlap and land in any order, and an editor can keep
   * showing older text, so only the editor knows which answer its buffer came
   * from; a guess lets the close prompt's Save write the draft over a change
   * it never saw. Null when clean, or when the editor didn't say.
   */
  revision: string | null;
  /** Moves each time a draft starts, so a save's reply only touches the draft it saved. */
  draftGen: number;
  /**
   * The latest disk state a read or a disk-change check saw: a revision, or
   * `status:<refusal>`, so a move from one to another is reported once and a
   * view showing a refusal hears when the file reads again.
   */
  observedState: string | null;
  /** The view's reads in flight: a change that lands meanwhile is news to it. */
  reading: number;
  /**
   * The latest read started. A read that lands after a later one started is
   * superseded and records nothing the later one will.
   */
  readSeq: number;
  /** The disk-change check in flight, whether another was asked for, and with what ceiling. */
  probing: Promise<void> | null;
  probeAgain: boolean;
  probeMaxBytes: number;
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

/**
 * Released by its view and replaced by a newer record: a late call from the
 * view that has gone (a debounced setDraft, say) changes nothing and never
 * speaks over the record a newer view holds. A record that is mounted again
 * still speaks, so a live view is never silenced.
 */
function superseded(record: DocumentRecord): boolean {
  const owner = records.get(record.key);
  return record.mounts === 0 && owner !== undefined && owner !== record;
}

function publish(record: DocumentRecord): void {
  if (superseded(record)) return;
  const owner = records.get(record.key);
  const store = useFileDocumentStore.getState();
  if (record.mounts === 0 && record.draft === null && record.pending === 0) {
    // No draft and nobody editing: the document is released. Only this
    // record's own projection and map entry go — a newer record for the same
    // panel and file may already hold both.
    if (record.projection !== null && store.byPanelId[record.panelId] === record.projection) {
      store.clearFileDocument(record.panelId, record.identityKey);
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
  // A draft reported after its view released the record keeps the record, so
  // the next view for this panel and file restores it.
  if (owner === undefined) records.set(record.key, record);
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

function stateOf(result: PluginFileDocumentReadResult): string {
  return result.status === "ok" ? result.revision : `status:${result.status}`;
}

/** The disk moved off the revision a standing draft is based on: the host's conflict. */
function reconcileDraft(record: DocumentRecord, state: string): void {
  if (
    record.draft !== null &&
    record.revision !== null &&
    state !== record.revision &&
    !record.hostConflict
  ) {
    record.hostConflict = true;
    publish(record);
  }
}

async function read(
  record: DocumentRecord,
  maxBytes: number
): Promise<PluginFileDocumentReadResult> {
  const seq = ++record.readSeq;
  record.reading += 1;
  let result: PluginFileDocumentReadResult;
  try {
    result = await window.electron.fileDocument.read({
      rootPath: record.rootPath,
      filePath: record.filePath,
      maxBytes,
    });
  } catch (err) {
    logWarn("[PluginFileDocument] Read failed", { error: err });
    result = { status: "unavailable" };
  } finally {
    record.reading -= 1;
  }
  if (seq !== record.readSeq) return result;
  // A refused read is an observation too, so the next disk change that makes
  // the file readable again reaches a view still showing the refusal.
  record.observedState = stateOf(result);
  if (result.status === "ok" && record.draft === null && record.hostConflict) {
    record.hostConflict = false;
    publish(record);
  }
  return result;
}

/** One disk-change check: re-read, and tell the view when the disk moved. */
async function probe(record: DocumentRecord, maxBytes: number): Promise<void> {
  let state: string;
  try {
    // A file that grew past the ceiling or stopped decoding changed too; the
    // view hears about it as a change with no readable revision.
    state = stateOf(
      await window.electron.fileDocument.read({
        rootPath: record.rootPath,
        filePath: record.filePath,
        maxBytes,
      })
    );
  } catch {
    return;
  }
  const previous = record.observedState;
  record.observedState = state;
  // Only a check that could read as much as the draft's owner speaks for the
  // draft: a viewer's tighter ceiling refusing the file says nothing about it.
  if (maxBytes >= record.maxBytes) reconcileDraft(record, state);
  if (state === previous) return;
  // Nothing observed and nothing being read means nothing to be stale
  // against: the view's first read sees whatever is there now.
  if (previous === null && record.reading === 0) return;
  emit(record, { reason: "disk", revision: diskRevisionOf(record) });
}

async function save(
  record: DocumentRecord,
  text: string,
  expectedRevision: string
): Promise<PluginFileDocumentSaveResult> {
  let result: PluginFileDocumentSaveResult;
  const gen = record.draftGen;
  const ofDraft = record.draft === text;
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
    // The host's own words, so a save refused while another screen drives
    // says to take control rather than showing the wire-encoded error.
    result = { status: "error", message: clientErrorText(err, "Save failed") };
  } finally {
    record.pending -= 1;
  }
  if (result.status === "saved") {
    record.observedState = result.revision;
    // Only a save of the standing draft speaks for it. A draft started after
    // the save began has its own base, even with the same text, and a save of
    // other text (a merge, a queued save of a discarded draft) leaves the
    // draft on the base its editor reported.
    if (record.draftGen === gen) {
      if (record.draft === text) {
        record.draft = null;
        record.revision = null;
      } else if (record.draft !== null && ofDraft) {
        // Typing that landed while the save was in flight stays a draft, now
        // on top of what the save wrote.
        record.revision = result.revision;
      }
      if (record.draft === null || ofDraft) {
        record.hostConflict = false;
        record.viewConflict = false;
      }
    }
    publish(record);
  } else if (result.status === "conflict") {
    record.observedState = result.revision;
    // A draft started since keeps its own base: it conflicts only if the disk
    // is off that base.
    if (record.draftGen === gen) record.hostConflict = true;
    else reconcileDraft(record, result.revision ?? "status:unavailable");
    publish(record);
  } else {
    publish(record);
  }
  return result;
}

function refusedOutcome(
  reason: Extract<PluginFileDocumentSaveResult, { status: "refused" }>["reason"]
): FileDocumentSaveOutcome {
  switch (reason) {
    case "unavailable":
      return { status: "unavailable", reason: "The file isn't where it was" };
    case "too-large":
      return { status: "refused", reason: "The draft is too large for this editor to save" };
    case "read-only":
      return { status: "refused", reason: "This file is read-only here" };
    default:
      return { status: "refused", reason: "The save was refused" };
  }
}

/**
 * The close prompt's Save: the host's draft against the revision it was based
 * on. A failure names its reason, since the editor that would show it may not
 * be on screen.
 */
async function saveDraft(record: DocumentRecord): Promise<FileDocumentSaveOutcome> {
  const draft = record.draft;
  if (draft === null) return { status: "saved" };
  if (record.revision === null) {
    return {
      status: "refused",
      reason: "The editor didn't say which version of the file these edits are based on",
    };
  }
  const gen = record.draftGen;
  const result = await save(record, draft, record.revision);
  switch (result.status) {
    case "saved": {
      // A draft started meanwhile has its own base, which the file just moved off.
      const replaced = record.draftGen !== gen;
      if (replaced) reconcileDraft(record, result.revision);
      // Nothing stands that the save didn't write. Checked before and after
      // the editor hears of it, so its reaction can neither hide edits the
      // save missed nor slip new ones past the close.
      const covered = record.draft === null;
      // "saved" tells the editor its text is on disk; with edits still
      // standing it only hears that the file moved.
      emit(record, {
        reason: covered && !replaced ? "saved" : "disk",
        revision: result.revision,
      });
      return covered && record.draft === null
        ? { status: "saved" }
        : { status: "refused", reason: "Edits made during the save are still unsaved" };
    }
    case "conflict":
      return { status: "conflict", reason: "The file changed on disk" };
    case "refused":
      return refusedOutcome(result.reason);
    case "error":
      return { status: "error", reason: result.message };
  }
}

function discardDraft(record: DocumentRecord): void {
  record.draft = null;
  record.revision = null;
  record.hostConflict = false;
  record.viewConflict = false;
  emit(record, { reason: "discarded", revision: diskRevisionOf(record) });
  publish(record);
}

function createDocument(
  record: DocumentRecord,
  mode: FileEditorMode,
  maxBytes: number
): PluginFileDocument {
  const readOnly = mode === "view";
  return Object.freeze({
    filePath: record.filePath,
    relativePath:
      relativeFilePath(record.rootPath, record.filePath) ?? record.filePath.replace(/\\/g, "/"),
    fileName: record.fileName,
    mode,
    readOnly,
    read: () => read(record, maxBytes),
    save: async (text: string, options: { expectedRevision: string }) => {
      if (readOnly) return { status: "refused", reason: "read-only" } as const;
      if (typeof text !== "string" || typeof options?.expectedRevision !== "string") {
        return { status: "error", message: "save(text, { expectedRevision }) needs both" } as const;
      }
      return save(record, text, options.expectedRevision);
    },
    getDraft: () => record.draft,
    getDraftBaseRevision: () => (record.draft === null ? null : record.revision),
    setDraft: (text: string | null, options?: { baseRevision?: string }) => {
      if (readOnly || superseded(record)) return;
      const next = typeof text === "string" ? text : null;
      if (next === record.draft) return;
      if (next === null) {
        // The conflicts were the draft's.
        record.revision = null;
        record.hostConflict = false;
        record.viewConflict = false;
      } else if (record.draft === null) {
        // The base binds when the draft starts. A remounted editor that read
        // the file again can't move it by naming what it just read.
        record.draftGen += 1;
        const base = options?.baseRevision;
        record.revision = typeof base === "string" && base.length > 0 ? base : null;
      }
      record.draft = next;
      publish(record);
    },
    setConflict: (conflict: boolean) => {
      if (readOnly || superseded(record) || record.viewConflict === Boolean(conflict)) return;
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
      draftGen: 0,
      observedState: null,
      reading: 0,
      readSeq: 0,
      probing: null,
      probeAgain: false,
      probeMaxBytes: target.maxBytes,
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
  // The editor in front decides the save ceiling; a draft from a roomier one is
  // refused at save rather than dropped. A viewer saves nothing, so it reads
  // with its own ceiling and leaves the draft owner's alone.
  if (target.mode === "edit") record.maxBytes = target.maxBytes;
  record.rootPath = target.rootPath;
  const live = record;
  return {
    document: createDocument(live, target.mode, target.maxBytes),
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
    notifyDiskChange: () => {
      // One check at a time per document, with one more after it for changes
      // meanwhile: a burst of writes costs two reads, not one per tick. The
      // runner clears its own slot in the same turn its loop ends, so a request
      // can never land on a runner that has already stopped looking.
      live.probeAgain = true;
      live.probeMaxBytes = target.maxBytes;
      live.probing ??= (async () => {
        try {
          while (live.probeAgain) {
            live.probeAgain = false;
            await probe(live, live.probeMaxBytes);
          }
        } finally {
          live.probing = null;
        }
      })();
      return live.probing;
    },
  };
}

/** Test-only: drop every record. */
export function _resetPluginFileDocumentsForTest(): void {
  records.clear();
}
