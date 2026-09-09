import { usePanelStore } from "@/store/panelStore";
import { useFileDocumentStore } from "@/store/fileDocumentStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { logError } from "@/utils/logger";
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
 * Edit open until the panel itself is removed.
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
/** Per-identity state shared by every controller on the same document. */
const identities = new Map<string, { generation: number; controllers: Set<DocumentController> }>();

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
  viewState: EditorViewState | null = null;

  private disposed = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private revalidateTimer: ReturnType<typeof setTimeout> | null = null;
  private lastChangeTick: number | undefined;
  private readonly unsubscribers: Array<() => void> = [];
  /** A load in flight; a later completion for an older request is dropped. */
  private loadRequest = 0;

  static acquire(props: DocumentControllerProps): DocumentController {
    const existing = controllers.get(props.panelId);
    if (existing && existing.identity.filePath === props.filePath) return existing;
    // The panel now shows a different file: the old document's draft is
    // released with its panel binding, and its record stays only while a
    // sibling panel still holds it.
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

    let shared = identities.get(this.key);
    if (!shared) {
      shared = { generation: 0, controllers: new Set() };
      identities.set(this.key, shared);
    }
    shared.controllers.add(this);
    if (!useDocumentStateStore.getState().records[this.key]) {
      useDocumentStateStore.getState().set(this.key, createDocumentRecord(this.identity));
    }

    this.unsubscribers.push(
      useDocumentStateStore.subscribe((state, previous) => {
        if (state.records[this.key] !== previous.records[this.key]) this.publishProjection();
      }),
      window.electron.plugin.on(PLUGIN_ID, PUSH_CHANNELS.documentChanged, (payload) => {
        if ((payload as DocumentChangedPush | null)?.identityKey === this.key)
          this.scheduleRevalidate();
      }),
      usePanelStore.subscribe((state) => {
        if (state.panelsById[this.panelId] === undefined) this.release();
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
    void this.load({ restoreDraft: true });
  }

  private readonly flushOnUnload = (): void => {
    void this.flushPersist();
  };

  record(): DocumentRecord {
    return (
      useDocumentStateStore.getState().records[this.key] ?? createDocumentRecord(this.identity)
    );
  }

  private update(mutate: (record: DocumentRecord) => DocumentRecord): void {
    if (this.disposed) return;
    useDocumentStateStore.getState().upsert(this.key, mutate);
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
    const request = ++this.loadRequest;
    const result = await this.read();
    if (this.disposed || request !== this.loadRequest) return;
    if (result === null || result.status === "unavailable") {
      this.update((record) => ({ ...record, status: "unavailable" }));
      return;
    }
    if (result.status === "refused") {
      this.update((record) => ({ ...record, status: "refused", refusal: result.reason }));
      return;
    }
    const base = this.baseFrom(result);
    let draft: DocumentRecord["draft"] = null;
    let conflict: DocumentRecord["conflict"] = null;
    if (options.restoreDraft) {
      const stored = await this.readStoredDraft();
      if (this.disposed || request !== this.loadRequest) return;
      if (stored && stored.draftText !== base.text) {
        draft = { text: stored.draftText, baseRevision: stored.baseRevision };
        // A recovered draft is never written automatically: when the disk
        // moved on since it was taken, it stands as a conflict until the
        // user compares the two and decides.
        if (stored.baseRevision !== base.revision) {
          conflict = {
            revision: base.revision,
            text: base.text,
            hasBom: base.hasBom,
            eol: base.eol,
          };
        }
      } else if (stored) {
        void this.deleteStoredDraft();
      }
    } else {
      // A reload keeps a draft that is already standing; the caller decided
      // whether that is safe.
      draft = this.record().draft;
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
    if (conflict) announce("Recovered draft, file changed on disk");
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
      result = { status: "error", message: error instanceof Error ? error.message : String(error) };
    }
    if (this.disposed) return false;
    switch (result.status) {
      case "saved": {
        let clean = false;
        this.update((current) => {
          const newBase: DocumentBase = {
            ...base,
            text: snapshot,
            revision: result.revision,
            mixedEol: result.wrote ? false : base.mixedEol,
            size: utf8Length(snapshot),
          };
          // Typing that landed during the save stays dirty against the new
          // revision; otherwise the document is clean.
          const live = current.draft?.text;
          const draft =
            live !== undefined && live !== snapshot
              ? { text: live, baseRevision: result.revision }
              : null;
          clean = draft === null;
          return { ...current, base: newBase, draft, saving: false, error: null };
        });
        if (clean) {
          this.cancelPersist();
          await this.deleteStoredDraft();
        } else {
          this.schedulePersist();
        }
        announce("Saved");
        return clean;
      }
      case "conflict":
        this.update((current) => ({
          ...current,
          saving: false,
          conflict: {
            revision: result.revision,
            text: result.text,
            hasBom: result.hasBom,
            eol: result.eol,
          },
        }));
        announce("File changed on disk");
        return false;
      case "unavailable":
        this.update((current) => ({ ...current, saving: false, status: "unavailable" }));
        announce("File is no longer available");
        return false;
      case "refused":
        this.update((current) => ({
          ...current,
          saving: false,
          error:
            result.reason === "TOO_LARGE"
              ? TOO_LARGE_MESSAGE
              : "This file can't be saved as Markdown",
        }));
        return false;
      case "error":
        this.update((current) => ({ ...current, saving: false, error: result.message }));
        return false;
    }
  }

  async saveAs(targetPath: string): Promise<DocumentSaveAsResult> {
    const record = this.record();
    const text = currentText(record);
    if (text === null || !record.base) return { status: "error", message: "Nothing to save" };
    try {
      return await invoke<DocumentSaveAsResult>(CHANNELS.saveAs, {
        identity: this.identity,
        targetPath,
        text,
        hasBom: record.base.hasBom,
        eol: record.base.eol,
      });
    } catch (error) {
      return { status: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async discard(): Promise<void> {
    const record = this.record();
    if (!record.draft && !record.conflict) return;
    this.cancelPersist();
    this.update((current) => ({
      ...current,
      draft: null,
      conflict: null,
      error: null,
      storageWarning: null,
      loadGeneration: current.loadGeneration + 1,
      textVersion: current.textVersion + 1,
    }));
    await this.deleteStoredDraft();
    // The base may be stale if the discard resolved a conflict: take the
    // disk version so the editor shows what is actually there.
    if (record.conflict) await this.load({ restoreDraft: false });
    announce("Draft discarded");
  }

  /** Resolve a conflict by taking the disk version and dropping the draft. */
  async loadDiskVersion(): Promise<void> {
    const record = this.record();
    if (!record.conflict) return;
    this.cancelPersist();
    this.update((current) => ({ ...current, draft: null, conflict: null, error: null }));
    await this.deleteStoredDraft();
    await this.load({ restoreDraft: false });
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
    if (current.status === "unavailable") {
      // Back, possibly rewritten: treat it as an external change below.
      this.update((r) => ({ ...r, status: "ready" }));
    }
    if (!current.base || result.revision === current.base.revision) return;
    if (current.conflict && current.conflict.revision === result.revision) return;
    if (current.draft === null) {
      await this.load({ restoreDraft: false });
      announce("File changed on disk, reloaded");
      return;
    }
    const fresh = await this.read();
    if (this.disposed || !fresh || fresh.status !== "ok") return;
    this.update((r) => ({
      ...r,
      conflict: {
        revision: fresh.revision,
        text: fresh.text,
        hasBom: fresh.hasBom,
        eol: fresh.eol,
      },
    }));
    announce("File changed on disk");
  }

  // ── Draft recovery ─────────────────────────────────────────────────

  private nextGeneration(): number {
    const shared = identities.get(this.key);
    if (!shared) return 0;
    shared.generation += 1;
    return shared.generation;
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

  /** Write the draft record now; a no-op when the document is clean. */
  async flushPersist(): Promise<void> {
    if (this.persistTimer === null) return;
    this.cancelPersist();
    await this.persistNow();
  }

  private async persistNow(): Promise<void> {
    const record = this.record();
    if (this.disposed || !record.draft || !record.base) return;
    const draft: DraftRecord = {
      stateVersion: 1,
      identity: this.identity,
      baseRevision: record.draft.baseRevision,
      baseText: record.base.text,
      draftText: record.draft.text,
      hasBom: record.base.hasBom,
      eol: record.base.eol,
      updatedAt: Date.now(),
    };
    let result: DraftPutResult;
    try {
      result = await invoke<DraftPutResult>(CHANNELS.draftPut, {
        record: draft,
        generation: this.nextGeneration(),
      });
    } catch (error) {
      result = { status: "error", message: error instanceof Error ? error.message : String(error) };
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

  private async deleteStoredDraft(): Promise<void> {
    try {
      await invoke(CHANNELS.draftDelete, {
        identity: this.identity,
        generation: this.nextGeneration(),
      });
    } catch (error) {
      logError("[markdown-editor] drafts.delete failed", error);
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** The panel is gone: flush, drop the binding, and release the document. */
  release(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.persistTimer !== null) {
      // The draft outlives the panel in recovery storage: write it now, on
      // the record as it stood, so an orphaned draft is what Recover finds.
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
      if (shared.controllers.size === 0) {
        identities.delete(this.key);
        useDocumentStateStore.getState().remove(this.key);
      }
    }
  }

  private async persistRecordDirect(): Promise<void> {
    const record = useDocumentStateStore.getState().records[this.key];
    if (!record?.draft || !record.base) return;
    const shared = identities.get(this.key);
    const generation = shared ? ++shared.generation : 0;
    const draft: DraftRecord = {
      stateVersion: 1,
      identity: this.identity,
      baseRevision: record.draft.baseRevision,
      baseText: record.base.text,
      draftText: record.draft.text,
      hasBom: record.base.hasBom,
      eol: record.base.eol,
      updatedAt: Date.now(),
    };
    try {
      await invoke(CHANNELS.draftPut, { record: draft, generation });
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
