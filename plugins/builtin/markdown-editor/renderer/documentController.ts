import { usePanelStore } from "@/store/panelStore";
import { isFilePanel } from "@shared/types/panel";
import { join } from "@shared/utils/path";
import { useFileDocumentStore } from "@/store/fileDocumentStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  CHANNELS,
  identityKey,
  MAX_EDITABLE_BYTES,
  PLUGIN_ID,
  PUSH_CHANNELS,
  type DocumentChangedPush,
  type DocumentIdentity,
  type DocumentReadResult,
  type DocumentRevalidateResult,
  type DocumentSaveAsResult,
  type DocumentSaveResult,
  type DraftPutResult,
  type DraftRecord,
} from "../shared/protocol.js";
import {
  createDocumentRecord,
  currentText,
  useDocumentStateStore,
  type DocumentBase,
  type DocumentRecord,
} from "./documentStateStore.js";

/**
 * One controller per file panel in Edit mode (#12323). It owns the document
 * lifecycle the editor view is too transient to own: the panel switches to
 * Rendered and back, gets maximised away, or sits in a cached project view,
 * and the draft must survive all of that. The controller lives from the first
 * Edit open until the panel itself is removed or shows another file.
 *
 * What it does with the document is published two ways: the full record in
 * the plugin's own document store (keyed by identity, so a second panel on
 * the same file shares it), and a small projection in the host's file
 * document store (keyed by panel) that the file panel reads for its dirty
 * mark, its Rendered preview, and its close prompt.
 */
export interface DocumentControllerProps {
  panelId: string;
  filePath: string;
  fileName: string;
  rootPath: string;
  worktreePath: string | null;
  projectId: string;
}

export interface EditorViewState {
  anchor: number;
  head: number;
  scrollTop: number;
}

const PERSIST_DEBOUNCE_MS = 1000;
const REVALIDATE_COALESCE_MS = 100;
const TOO_LARGE_MESSAGE = "This draft is over 2 MiB and can't be saved here";

const controllers = new Map<string, DocumentController>();
/**
 * Per-identity state shared by every controller on the same document. The
 * entry outlives its controllers: `generation` must keep climbing across a
 * close and reopen, or a put minted in the new lifetime could fall below the
 * tombstone the old one's discard left in main.
 */
interface IdentityState {
  generation: number;
  controllers: Set<DocumentController>;
  /**
   * Load requests are ordered per document, not per panel: a replacement one
   * panel started must not land over a newer one a sibling finished.
   */
  loadRequest: number;
}
const identities = new Map<string, IdentityState>();

function identityState(key: string): IdentityState {
  let shared = identities.get(key);
  if (!shared) {
    shared = { generation: 0, controllers: new Set(), loadRequest: 0 };
    identities.set(key, shared);
  }
  return shared;
}

/** A controller still bound to this document, if any. */
function survivor(key: string): DocumentController | undefined {
  return identities.get(key)?.controllers.values().next().value;
}

/**
 * Generations order a document's puts and deletes in main: a put at or below
 * the last delete is ignored there. Wall-clock based so the order survives a
 * renderer that lost its counters (a closed panel, an evicted project view),
 * with a strict-increase guard for calls inside one millisecond.
 */
function mintGeneration(key: string): number {
  const shared = identities.get(key);
  const next = Math.max(Date.now(), (shared?.generation ?? 0) + 1);
  if (shared) shared.generation = next;
  return next;
}

/** Update the shared record without the "this controller is disposed" gate. */
function updateShared(key: string, mutate: (record: DocumentRecord) => DocumentRecord): void {
  useDocumentStateStore.getState().upsert(key, mutate);
}

function invoke<T>(channel: string, args: unknown): Promise<T> {
  return window.electron.plugin.invoke(PLUGIN_ID, channel, args) as Promise<T>;
}

function announce(message: string): void {
  useAnnouncerStore.getState().announce(message);
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export class DocumentController {
  readonly panelId: string;
  readonly identity: DocumentIdentity;
  readonly key: string;
  readonly fileName: string;
  readonly rootPath: string;
  /** Caret and scroll the last editor view left behind, restored on remount. */
  private viewState: EditorViewState | null = null;

  private disposed = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private revalidateTimer: ReturnType<typeof setTimeout> | null = null;
  private lastChangeTick: number | undefined;
  private readonly unsubscribers: Array<() => void> = [];

  static acquire(props: DocumentControllerProps): DocumentController {
    const existing = controllers.get(props.panelId);
    if (
      existing &&
      existing.identity.filePath === props.filePath &&
      existing.identity.worktreePath === props.worktreePath &&
      existing.identity.projectId === props.projectId
    ) {
      return existing;
    }
    // The panel now shows a different document: the old binding is released
    // with its panel, and its record stays only while a sibling still holds it.
    existing?.release();
    const controller = new DocumentController(props);
    controllers.set(props.panelId, controller);
    return controller;
  }

  static get(panelId: string): DocumentController | undefined {
    return controllers.get(panelId);
  }

  private constructor(props: DocumentControllerProps) {
    this.panelId = props.panelId;
    this.fileName = props.fileName;
    this.rootPath = props.rootPath;
    this.identity = {
      projectId: props.projectId,
      worktreePath: props.worktreePath,
      filePath: props.filePath,
    };
    this.key = identityKey(this.identity);

    identityState(this.key).controllers.add(this);
    const existing = useDocumentStateStore.getState().records[this.key];
    if (!existing) {
      useDocumentStateStore.getState().set(this.key, createDocumentRecord(this.identity));
    }

    this.unsubscribers.push(
      useDocumentStateStore.subscribe((state, previous) => {
        if (state.records[this.key] !== previous.records[this.key]) this.publishProjection();
      }),
      window.electron.plugin.on(PLUGIN_ID, PUSH_CHANNELS.documentChanged, (payload) => {
        if ((payload as DocumentChangedPush | null)?.identityKey === this.key) {
          this.scheduleRevalidate();
        }
      }),
      usePanelStore.subscribe((state) => {
        const panel = state.panelsById[this.panelId];
        // Gone, or now showing another file: either way this binding is over.
        if (
          panel === undefined ||
          (isFilePanel(panel) && panel.filePath !== this.identity.filePath) ||
          (panel.kind === "file-browser" &&
            join(this.rootPath, panel.browserSelectedPath ?? "") !== this.identity.filePath)
        ) {
          this.release();
        }
      })
    );
    const onFocus = () => this.scheduleRevalidate();
    const onVisibility = () => {
      if (document.visibilityState === "visible") this.scheduleRevalidate();
      else void this.flushPersist();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", this.flushOnUnload);
    this.unsubscribers.push(
      () => window.removeEventListener("focus", onFocus),
      () => document.removeEventListener("visibilitychange", onVisibility),
      () => window.removeEventListener("pagehide", this.flushOnUnload)
    );

    this.publishProjection();
    // A sibling panel already holds (or is loading) this document: join it
    // rather than reloading over its draft. Main still needs this panel on its
    // refcount so the watch outlives whichever panel opened first.
    if (existing) void this.attach();
    else void this.load({ restoreDraft: true });
  }

  private readonly flushOnUnload = (): void => {
    void this.flushPersist();
  };

  rememberViewState(state: EditorViewState): void {
    this.viewState = state;
  }

  takeViewState(): EditorViewState | null {
    return this.viewState;
  }

  /** Mint the next load request for this document; a stale completion checks it. */
  private beginLoad(): number {
    const shared = identityState(this.key);
    shared.loadRequest += 1;
    return shared.loadRequest;
  }

  private loadIsCurrent(request: number): boolean {
    return !this.disposed && identityState(this.key).loadRequest === request;
  }

  private async attach(): Promise<void> {
    try {
      await invoke(CHANNELS.attach, { identity: this.identity, panelId: this.panelId });
    } catch (error) {
      logError("[markdown-editor] document.attach failed", error);
    }
  }

  record(): DocumentRecord {
    return (
      useDocumentStateStore.getState().records[this.key] ?? createDocumentRecord(this.identity)
    );
  }

  private update(mutate: (record: DocumentRecord) => DocumentRecord): void {
    if (this.disposed) return;
    updateShared(this.key, mutate);
  }

  /** Inputs from the panel that change over the controller's life. */
  sync(props: { changeTick: number | undefined }): void {
    if (props.changeTick !== this.lastChangeTick) {
      const first = this.lastChangeTick === undefined;
      this.lastChangeTick = props.changeTick;
      if (!first) this.scheduleRevalidate();
    }
  }

  private publishProjection(): void {
    if (this.disposed) return;
    const record = this.record();
    useFileDocumentStore.getState().setFileDocument(this.panelId, {
      identityKey: this.key,
      fileName: this.fileName,
      draftText: record.draft?.text ?? null,
      dirty: record.draft !== null,
      conflict: record.conflict !== null || record.status === "unavailable",
      save: () => this.save(),
      discard: () => this.discard(),
    });
  }

  // ── Loading ────────────────────────────────────────────────────────

  private async read(): Promise<DocumentReadResult | null> {
    try {
      return await invoke<DocumentReadResult>(CHANNELS.read, {
        identity: this.identity,
        panelId: this.panelId,
      });
    } catch (error) {
      logError("[markdown-editor] document.read failed", error);
      return null;
    }
  }

  private baseFrom(result: Extract<DocumentReadResult, { status: "ok" }>): DocumentBase {
    return {
      text: result.text,
      revision: result.revision,
      hasBom: result.hasBom,
      eol: result.eol,
      mixedEol: result.mixedEol,
      size: result.size,
    };
  }

  async load(options: { restoreDraft: boolean }): Promise<void> {
    const request = this.beginLoad();
    const result = await this.read();
    if (!this.loadIsCurrent(request)) return;
    if (result === null || result.status === "unavailable") {
      // The file is not there, but a stored draft may be: surface it so the
      // panel shows the unsaved mark and the draft can be copied, rather than
      // hiding it behind a file that never loads.
      let draft = this.record().draft;
      if (options.restoreDraft && draft === null) {
        const stored = await this.readStoredDraft();
        if (!this.loadIsCurrent(request)) return;
        if (stored) draft = { text: stored.draftText, baseRevision: stored.baseRevision };
      }
      this.update((record) => ({
        ...record,
        status: "unavailable",
        draft,
        textVersion: draft === record.draft ? record.textVersion : record.textVersion + 1,
      }));
      return;
    }
    if (result.status === "refused") {
      this.update((record) => ({ ...record, status: "refused", refusal: result.reason }));
      return;
    }
    const base = this.baseFrom(result);
    let draft: DocumentRecord["draft"] = null;
    if (options.restoreDraft) {
      const stored = await this.readStoredDraft();
      if (!this.loadIsCurrent(request)) return;
      if (stored && stored.draftText !== base.text) {
        draft = { text: stored.draftText, baseRevision: stored.baseRevision };
      } else if (stored) {
        void this.deleteStoredDraft();
      }
    } else {
      // A reload keeps whatever draft is standing — including one typed while
      // this read was in flight. Such a draft was written against the old
      // base, so it cannot simply adopt the new one.
      draft = this.record().draft;
    }
    // A draft standing on a base that is no longer the disk's is a conflict
    // until the user compares the two: a recovered draft from an earlier
    // session, or typing that raced a reload. Never written automatically.
    if (draft !== null && draft.baseRevision !== base.revision) {
      const conflict = {
        revision: base.revision,
        text: base.text,
        hasBom: base.hasBom,
        eol: base.eol,
      };
      const previous = this.record().base;
      // Keep the base the draft was typed against when it is still here, so
      // the editor keeps showing the user's edit; the recovered case has no
      // such base and takes the disk as its reference document.
      if (previous !== null && previous.revision === draft.baseRevision) {
        this.update((record) => ({ ...record, status: "ready", conflict, error: null }));
        announce("File changed on disk");
        return;
      }
      this.update((record) => ({
        ...record,
        status: "ready",
        refusal: null,
        base,
        draft,
        conflict,
        error: null,
        loadGeneration: record.loadGeneration + 1,
        textVersion: record.textVersion + 1,
      }));
      announce("Recovered draft, file changed on disk");
      return;
    }
    this.update((record) => ({
      ...record,
      status: "ready",
      refusal: null,
      base,
      draft,
      conflict: null,
      error: null,
      loadGeneration: record.loadGeneration + 1,
      textVersion: record.textVersion + 1,
    }));
  }

  // ── Editing ────────────────────────────────────────────────────────

  /** The editor buffer changed. `text` is the whole buffer, CodeMirror's `\n`-joined lines. */
  setText(text: string): void {
    const record = this.record();
    if (record.status !== "ready" || !record.base) return;
    const base = record.base;
    if (text === (record.draft?.text ?? base.text)) return;
    if (text === base.text) {
      this.update((current) => ({
        ...current,
        draft: null,
        error: current.error === TOO_LARGE_MESSAGE ? null : current.error,
        textVersion: current.textVersion + 1,
      }));
      this.cancelPersist();
      void this.deleteStoredDraft();
      return;
    }
    const tooLarge = utf8Length(text) > MAX_EDITABLE_BYTES;
    this.update((current) => ({
      ...current,
      draft: { text, baseRevision: current.draft?.baseRevision ?? base.revision },
      error: tooLarge
        ? TOO_LARGE_MESSAGE
        : current.error === TOO_LARGE_MESSAGE
          ? null
          : current.error,
      textVersion: current.textVersion + 1,
    }));
    if (!tooLarge) this.schedulePersist();
  }

  // ── Saving ─────────────────────────────────────────────────────────

  async save(): Promise<boolean> {
    const record = this.record();
    if (record.status !== "ready" || !record.base || record.saving) return false;
    if (record.conflict) return false;
    const base = record.base;
    const snapshot = record.draft?.text ?? base.text;
    if (utf8Length(snapshot) > MAX_EDITABLE_BYTES) {
      this.update((current) => ({ ...current, error: TOO_LARGE_MESSAGE }));
      return false;
    }
    this.update((current) => ({ ...current, saving: true, error: null }));
    let result: DocumentSaveResult;
    try {
      result = await invoke<DocumentSaveResult>(CHANNELS.save, {
        identity: this.identity,
        text: snapshot,
        expectedRevision: base.revision,
        unchanged: snapshot === base.text,
        hasBom: base.hasBom,
        eol: base.eol,
      });
    } catch (error) {
      result = { status: "error", message: formatErrorMessage(error, "Save failed") };
    }
    // Settled on the shared record, not this controller: a sibling panel on
    // the same document must never be left in "Saving…" because the panel
    // that pressed Save closed first.
    const key = this.key;
    switch (result.status) {
      case "saved": {
        let clean = false;
        updateShared(key, (current) => {
          const newBase: DocumentBase = {
            ...base,
            text: snapshot,
            revision: result.revision,
            mixedEol: result.wrote ? false : base.mixedEol,
            size: utf8Length(snapshot),
          };
          // Whatever the buffer holds now — typing that landed during the
          // save, or an undo back to the old base — stays dirty against the
          // new revision unless it is exactly what was written.
          const live = currentText(current) ?? snapshot;
          const draft = live !== snapshot ? { text: live, baseRevision: result.revision } : null;
          clean = draft === null;
          return { ...current, base: newBase, draft, saving: false, error: null };
        });
        if (clean) {
          this.cancelPersist();
          await this.deleteStoredDraft();
          // Typing that arrived while the record was being cleared makes the
          // document dirty again; report what is true now.
          clean = (useDocumentStateStore.getState().records[key]?.draft ?? null) === null;
        } else {
          // The draft that remains belongs to the document; if this panel has
          // closed meanwhile, a sibling carries its persistence.
          (this.disposed ? survivor(key) : this)?.schedulePersist();
        }
        if (!this.disposed) announce("Saved");
        return clean;
      }
      case "conflict":
        updateShared(key, (current) => ({
          ...current,
          saving: false,
          conflict: {
            revision: result.revision,
            text: result.text,
            hasBom: result.hasBom,
            eol: result.eol,
          },
        }));
        if (!this.disposed) announce("File changed on disk");
        return false;
      case "unavailable":
        updateShared(key, (current) => ({ ...current, saving: false, status: "unavailable" }));
        if (!this.disposed) announce("File is no longer available");
        return false;
      case "refused":
        updateShared(key, (current) => ({
          ...current,
          saving: false,
          error:
            result.reason === "TOO_LARGE"
              ? TOO_LARGE_MESSAGE
              : "This file can't be saved as Markdown",
        }));
        return false;
      case "error":
        updateShared(key, (current) => ({ ...current, saving: false, error: result.message }));
        return false;
    }
  }

  async saveAs(targetPath: string): Promise<DocumentSaveAsResult> {
    const record = this.record();
    const text = currentText(record);
    if (text === null) return { status: "error", message: "Nothing to save" };
    try {
      return await invoke<DocumentSaveAsResult>(CHANNELS.saveAs, {
        identity: this.identity,
        targetPath,
        text,
        hasBom: record.base?.hasBom ?? false,
        eol: record.base?.eol ?? "\n",
      });
    } catch (error) {
      return { status: "error", message: formatErrorMessage(error, "Save as failed") };
    }
  }

  /**
   * Drop the draft. The recovery record goes first: while it cannot be
   * removed the in-memory draft stays and the call rejects, so a close that
   * asked to discard is cancelled rather than reported done.
   */
  async discard(): Promise<void> {
    const record = this.record();
    if (!record.draft && !record.conflict) return;
    this.cancelPersist();
    const removed = await this.deleteStoredDraft();
    if (!removed) {
      this.update((current) => ({
        ...current,
        error: "Couldn't remove the draft's recovery copy, so the draft is kept",
      }));
      throw new Error("markdown-editor: draft recovery record could not be removed");
    }
    this.update((current) => ({
      ...current,
      draft: null,
      conflict: null,
      error: null,
      storageWarning: null,
      loadGeneration: current.loadGeneration + 1,
      textVersion: current.textVersion + 1,
    }));
    // The base may be stale if the discard resolved a conflict, or absent if
    // the file was never readable: take the disk version where there is one.
    if (record.conflict || record.base === null) await this.load({ restoreDraft: false });
    announce("Draft discarded");
  }

  /**
   * Resolve a conflict by taking the disk version and dropping the draft. The
   * replacement is read and proven first; the draft and its recovery record
   * go only once there is something to put in their place.
   */
  async loadDiskVersion(): Promise<void> {
    const record = this.record();
    if (!record.conflict) return;
    const request = this.beginLoad();
    const result = await this.read();
    if (!this.loadIsCurrent(request)) return;
    if (result === null || result.status !== "ok") {
      this.update((current) => ({
        ...current,
        error:
          result?.status === "refused"
            ? "The disk version can't be loaded here; your draft is kept"
            : "The file isn't available; your draft is kept",
      }));
      return;
    }
    this.cancelPersist();
    const base = this.baseFrom(result);
    this.update((current) => ({
      ...current,
      status: "ready",
      refusal: null,
      base,
      draft: null,
      conflict: null,
      error: null,
      loadGeneration: current.loadGeneration + 1,
      textVersion: current.textVersion + 1,
    }));
    await this.deleteStoredDraft();
  }

  // ── External change detection ──────────────────────────────────────

  private scheduleRevalidate(): void {
    if (this.disposed || this.revalidateTimer !== null) return;
    this.revalidateTimer = setTimeout(() => {
      this.revalidateTimer = null;
      void this.revalidate();
    }, REVALIDATE_COALESCE_MS);
  }

  async revalidate(): Promise<void> {
    const record = this.record();
    if (record.status === "refused" || record.saving) return;
    if (record.status === "loading") return;
    let result: DocumentRevalidateResult;
    try {
      result = await invoke<DocumentRevalidateResult>(CHANNELS.revalidate, {
        identity: this.identity,
      });
    } catch {
      return;
    }
    if (this.disposed) return;
    const current = this.record();
    if (current.saving) return;
    if (result.status === "unavailable") {
      if (current.status !== "unavailable") {
        this.update((r) => ({ ...r, status: "unavailable" }));
        announce("File is no longer available");
      }
      return;
    }
    if (!current.base) {
      // Never loaded (opened while the file was missing). Now that it
      // answers, load it for real; a standing draft rides along and is
      // compared against the new base there.
      await this.load({ restoreDraft: current.draft === null });
      return;
    }
    if (current.status === "unavailable") {
      // Back, possibly rewritten: treat it as an external change below.
      this.update((r) => ({ ...r, status: "ready" }));
    }
    if (result.revision === current.base.revision) return;
    if (current.conflict && current.conflict.revision === result.revision) return;
    if (current.draft === null) {
      await this.load({ restoreDraft: false });
      announce("File changed on disk, reloaded");
      return;
    }
    const fresh = await this.read();
    if (this.disposed) return;
    const base = current.base;
    this.update((r) => ({
      ...r,
      // A disk version that cannot be shown (undecodable, gone again) is
      // still a conflict: the draft's base has moved and Save must hold.
      conflict:
        fresh && fresh.status === "ok"
          ? { revision: fresh.revision, text: fresh.text, hasBom: fresh.hasBom, eol: fresh.eol }
          : { revision: result.revision, text: null, hasBom: base.hasBom, eol: base.eol },
    }));
    announce("File changed on disk");
  }

  // ── Draft recovery ─────────────────────────────────────────────────

  private nextGeneration(): number {
    return mintGeneration(this.key);
  }

  private async readStoredDraft(): Promise<DraftRecord | null> {
    try {
      const result = await invoke<{ record: DraftRecord | null }>(CHANNELS.draftGet, {
        identity: this.identity,
      });
      return result.record;
    } catch (error) {
      logError("[markdown-editor] drafts.get failed", error);
      return null;
    }
  }

  private schedulePersist(): void {
    this.cancelPersist();
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }

  private cancelPersist(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  /** Write the draft record now; a no-op when nothing is pending. */
  async flushPersist(): Promise<void> {
    if (this.persistTimer === null) return;
    this.cancelPersist();
    await this.persistNow();
  }

  private draftRecord(record: DocumentRecord): DraftRecord | null {
    if (!record.draft) return null;
    return {
      stateVersion: 1,
      identity: this.identity,
      baseRevision: record.draft.baseRevision,
      baseText: record.base?.text ?? "",
      draftText: record.draft.text,
      hasBom: record.base?.hasBom ?? false,
      eol: record.base?.eol ?? "\n",
      updatedAt: Date.now(),
    };
  }

  private async persistNow(): Promise<void> {
    const draft = this.draftRecord(this.record());
    if (this.disposed || !draft) return;
    let result: DraftPutResult;
    try {
      result = await invoke<DraftPutResult>(CHANNELS.draftPut, {
        record: draft,
        generation: this.nextGeneration(),
      });
    } catch (error) {
      result = { status: "error", message: formatErrorMessage(error, "Draft could not be stored") };
    }
    if (this.disposed) return;
    const warning =
      result.status === "full"
        ? "Draft recovery storage is full, so this draft lives only in this panel until you save it"
        : result.status === "error"
          ? `Couldn't store the draft for recovery: ${result.message}`
          : null;
    this.update((current) =>
      current.storageWarning === warning ? current : { ...current, storageWarning: warning }
    );
  }

  /** Remove the recovery record. Resolves false when main could not. */
  private async deleteStoredDraft(): Promise<boolean> {
    try {
      await invoke(CHANNELS.draftDelete, {
        identity: this.identity,
        generation: this.nextGeneration(),
      });
      return true;
    } catch (error) {
      logError("[markdown-editor] drafts.delete failed", error);
      return false;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** The panel is gone: flush, drop the binding, and release the document. */
  release(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.persistTimer !== null) {
      // The draft outlives the panel in recovery storage: write it now, on
      // the record as it stands, so an orphaned draft is what Recover finds.
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      void this.persistRecordDirect();
    }
    if (this.revalidateTimer !== null) clearTimeout(this.revalidateTimer);
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    controllers.delete(this.panelId);
    useFileDocumentStore.getState().clearFileDocument(this.panelId);
    void invoke(CHANNELS.release, { identity: this.identity, panelId: this.panelId }).catch(
      () => {}
    );
    const shared = identities.get(this.key);
    if (shared) {
      shared.controllers.delete(this);
      // The identity entry stays for its generation counter; only the record
      // goes when the last panel leaves.
      if (shared.controllers.size === 0) {
        useDocumentStateStore.getState().remove(this.key);
      } else if (useDocumentStateStore.getState().records[this.key]?.status === "loading") {
        // This panel was the one loading the document; a sibling that only
        // attached would otherwise wait forever.
        void survivor(this.key)?.load({ restoreDraft: true });
      }
    }
  }

  private async persistRecordDirect(): Promise<void> {
    const record = useDocumentStateStore.getState().records[this.key];
    const draft = record ? this.draftRecord(record) : null;
    if (!draft) return;
    try {
      await invoke(CHANNELS.draftPut, { record: draft, generation: mintGeneration(this.key) });
    } catch (error) {
      logError("[markdown-editor] final draft persist failed", error);
    }
  }
}

export function __resetDocumentControllersForTests(): void {
  for (const controller of [...controllers.values()]) controller.release();
  controllers.clear();
  identities.clear();
}
