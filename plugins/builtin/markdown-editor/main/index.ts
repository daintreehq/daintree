import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginHostApi } from "../../../../shared/types/plugin.js";
import {
  CHANNELS,
  DocumentAttachArgsSchema,
  DocumentAttachResultSchema,
  DocumentReadArgsSchema,
  DocumentReadResultSchema,
  DocumentReleaseArgsSchema,
  DocumentRevalidateArgsSchema,
  DocumentRevalidateResultSchema,
  DocumentSaveArgsSchema,
  DocumentSaveAsArgsSchema,
  DocumentSaveAsResultSchema,
  DocumentSaveResultSchema,
  DraftDeleteArgsSchema,
  DraftDeleteResultSchema,
  DraftGetArgsSchema,
  DraftGetResultSchema,
  DraftListArgsSchema,
  DraftListResultSchema,
  DraftPutArgsSchema,
  DraftPutResultSchema,
  identityKey,
  isEditableFilePath,
  MAX_EDITABLE_BYTES,
  PUSH_CHANNELS,
  RECOVER_DRAFTS_ACTION_ID,
  RecoverAckArgsSchema,
  RecoverAckResultSchema,
  type DocumentChangedPush,
  type DocumentIdentity,
  type DocumentReadResult,
  type DocumentRevalidateResult,
  type DocumentSaveAsResult,
  type DocumentSaveResult,
  type RecoverDraftPush,
} from "../shared/protocol.js";
import { assembleDocument, decodeDocument, sha256Hex, utf8ByteLength } from "./documentCodec.js";
import { DraftStore } from "./drafts.js";
import { z } from "zod";
import { formatErrorMessage } from "../../../../shared/utils/errorMessage.js";

/**
 * Main-side half of the Markdown editor (#12323). Owns every read, save,
 * watch and recovery record; the renderer view holds the CodeMirror buffer and
 * calls in here through typed channels. Every call names the document by its
 * full identity, so nothing here consults the active project or worktree.
 *
 * Document reads and writes go through `host.fs`, which contains paths to the
 * declared project and worktree roots and audits every write. There is no raw
 * `node:fs` on a document path anywhere in this plugin.
 */

interface OpenDocument {
  identity: DocumentIdentity;
  panelIds: Set<string>;
  /** Last revision this side observed, so a wake resync can tell a change from a re-read. */
  lastRevision: string | null;
  /** The watch being created or already created; one per document, shared by every panel. */
  watch: Promise<() => void> | null;
}

/** Paths as the watcher and the identity spell them, on this platform. */
function samePath(a: string, b: string): boolean {
  const left = path.normalize(a);
  const right = path.normalize(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isUnder(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const RECOVER_ACK_TIMEOUT_MS = 10_000;
const RECOVER_ACK_RETRY_MS = 500;

export interface ActivateOptions {
  /** Test seams for the recover command's acknowledgement wait. */
  recoverAckTimeoutMs?: number;
  recoverAckRetryMs?: number;
}

export async function activate(
  host: PluginHostApi,
  options: ActivateOptions = {}
): Promise<() => void> {
  const ackTimeoutMs = options.recoverAckTimeoutMs ?? RECOVER_ACK_TIMEOUT_MS;
  const ackRetryMs = options.recoverAckRetryMs ?? RECOVER_ACK_RETRY_MS;
  const documents = new Map<string, OpenDocument>();
  const drafts = new DraftStore({ fs: host.fs });
  const pendingRecoveries = new Map<string, () => void>();

  const notifyChanged = (key: string): void => {
    const payload: DocumentChangedPush = { identityKey: key };
    void host.postToPanel(PUSH_CHANNELS.documentChanged, payload, null).catch((error) => {
      host.logger.warn("document-changed push failed", { error: String(error) });
    });
  };

  const readCurrentRevision = async (identity: DocumentIdentity): Promise<string | null> => {
    try {
      const bytes = await host.fs.readFileBytes(identity.filePath);
      return sha256Hex(bytes);
    } catch {
      return null;
    }
  };

  const isSymlinkTarget = async (filePath: string): Promise<boolean | null> => {
    // `stat` follows links, so the directory listing's own classification is
    // the one that sees the link itself — the same answer the file browser
    // gives (#12323).
    try {
      const entries = await host.fs.readdir(path.dirname(filePath), { detail: true });
      const entry = entries.find((candidate) => candidate.name === path.basename(filePath));
      if (!entry) return null;
      return entry.isSymbolicLink;
    } catch {
      return null;
    }
  };

  const ensureWatch = (doc: OpenDocument): void => {
    // One creation per document, shared: concurrent reads before the first
    // watch resolves would otherwise each start a watcher and keep only the
    // last disposer.
    if (doc.watch) return;
    const key = identityKey(doc.identity);
    const target = doc.identity.filePath;
    doc.watch = host.fs.watch([path.dirname(target)], (changedPath) => {
      if (!samePath(changedPath, target)) return;
      notifyChanged(key);
    });
    doc.watch.then(
      (dispose) => {
        // The document may have been released while the watch was being set up.
        if (documents.get(key) !== doc) dispose();
      },
      (error) => {
        // The watcher is an optimisation; revalidation on focus and before
        // every save is the authority, so a failed watch is not a failed open.
        doc.watch = null;
        host.logger.warn("directory watch failed", { path: target, error: String(error) });
      }
    );
  };

  const disposeWatch = (doc: OpenDocument): void => {
    const pending = doc.watch;
    doc.watch = null;
    pending?.then(
      (dispose) => dispose(),
      () => {}
    );
  };

  /** The document record for an identity, registering the panel on it. */
  const openDocument = (identity: DocumentIdentity, panelId: string): OpenDocument => {
    const key = identityKey(identity);
    let doc = documents.get(key);
    if (!doc) {
      doc = { identity, panelIds: new Set(), lastRevision: null, watch: null };
      documents.set(key, doc);
    }
    doc.panelIds.add(panelId);
    return doc;
  };

  const releaseDocument = (key: string, panelId: string): void => {
    const doc = documents.get(key);
    if (!doc) return;
    doc.panelIds.delete(panelId);
    if (doc.panelIds.size > 0) return;
    documents.delete(key);
    disposeWatch(doc);
  };

  await host.registerHandler(
    CHANNELS.read,
    {
      args: DocumentReadArgsSchema,
      result: DocumentReadResultSchema,
      requires: ["fs:project-read"],
    },
    async (_ctx, { identity, panelId }): Promise<DocumentReadResult> => {
      if (!isEditableFilePath(identity.filePath))
        return { status: "refused", reason: "NOT_MARKDOWN" };
      // Registered before any I/O: a release that lands while the read is in
      // flight then finds the record and can retire it, instead of the read
      // completing into a document nobody holds.
      const doc = openDocument(identity, panelId);
      const key = identityKey(identity);
      const stillOpen = () => documents.get(key) === doc && doc.panelIds.has(panelId);
      const symlink = await isSymlinkTarget(identity.filePath);
      if (symlink === true) return { status: "refused", reason: "SYMLINK" };
      let bytes: Uint8Array;
      try {
        bytes = await host.fs.readFileBytes(identity.filePath);
      } catch (error) {
        if (/EISDIR|NOT_A_FILE/i.test(String(error)))
          return { status: "refused", reason: "NOT_A_FILE" };
        return { status: "unavailable" };
      }
      if (bytes.length > MAX_EDITABLE_BYTES) return { status: "refused", reason: "TOO_LARGE" };
      const decoded = decodeDocument(bytes);
      if (!decoded.ok) return { status: "refused", reason: decoded.reason };

      if (stillOpen()) {
        doc.lastRevision = decoded.document.revision;
        ensureWatch(doc);
      }
      const { text, revision, hasBom, eol, mixedEol, size } = decoded.document;
      return { status: "ok", text, revision, hasBom, eol, mixedEol, size };
    }
  );

  await host.registerHandler(
    CHANNELS.attach,
    { args: DocumentAttachArgsSchema, result: DocumentAttachResultSchema },
    (_ctx, { identity, panelId }) => {
      const doc = openDocument(identity, panelId);
      if (doc.lastRevision !== null) ensureWatch(doc);
      return { attached: true };
    }
  );

  await host.registerHandler(
    CHANNELS.revalidate,
    {
      args: DocumentRevalidateArgsSchema,
      result: DocumentRevalidateResultSchema,
      requires: ["fs:project-read"],
    },
    async (_ctx, { identity }): Promise<DocumentRevalidateResult> => {
      const revision = await readCurrentRevision(identity);
      if (revision === null) return { status: "unavailable" };
      const doc = documents.get(identityKey(identity));
      if (doc) doc.lastRevision = revision;
      return { status: "ok", revision };
    }
  );

  await host.registerHandler(
    CHANNELS.save,
    {
      args: DocumentSaveArgsSchema,
      result: DocumentSaveResultSchema,
      requires: ["fs:project-read", "fs:project-write"],
    },
    async (_ctx, args): Promise<DocumentSaveResult> => {
      const { identity, text, expectedRevision, unchanged, hasBom, eol } = args;
      // The write boundary re-checks what the UI already gated: the allowlist
      // and the size, against the bytes that would actually land on disk.
      if (!isEditableFilePath(identity.filePath))
        return { status: "refused", reason: "NOT_MARKDOWN" };
      const contents = assembleDocument(text, { hasBom, eol });
      if (utf8ByteLength(contents) > MAX_EDITABLE_BYTES)
        return { status: "refused", reason: "TOO_LARGE" };

      const doc = documents.get(identityKey(identity));
      const conflictFromDisk = async (): Promise<DocumentSaveResult> => {
        let bytes: Uint8Array;
        try {
          bytes = await host.fs.readFileBytes(identity.filePath);
        } catch {
          return { status: "unavailable" };
        }
        const revision = sha256Hex(bytes);
        if (doc) doc.lastRevision = revision;
        const decoded = decodeDocument(bytes);
        return {
          status: "conflict",
          revision,
          text: decoded.ok ? decoded.document.text : null,
          hasBom: decoded.ok ? decoded.document.hasBom : hasBom,
          eol: decoded.ok ? decoded.document.eol : eol,
        };
      };

      if (unchanged) {
        // An unedited save writes nothing — but it still proves the disk is
        // where the caller thinks it is, because "nothing to do" must never
        // read as "saved" over an external change.
        const current = await readCurrentRevision(identity);
        if (current === null) return { status: "unavailable" };
        if (current !== expectedRevision) return conflictFromDisk();
        return { status: "saved", revision: current, wrote: false };
      }

      try {
        const { revision } = await host.fs.writeFile(identity.filePath, contents, {
          expectedRevision,
        });
        if (doc) doc.lastRevision = revision;
        return { status: "saved", revision, wrote: true };
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const message = formatErrorMessage(error, "Save failed");
        if (code === "REVISION_MISMATCH" || message.startsWith("REVISION_MISMATCH")) {
          return conflictFromDisk();
        }
        if (code === "TARGET_UNAVAILABLE" || message.startsWith("TARGET_UNAVAILABLE")) {
          return { status: "unavailable" };
        }
        return { status: "error", message };
      }
    }
  );

  await host.registerHandler(
    CHANNELS.saveAs,
    {
      args: DocumentSaveAsArgsSchema,
      result: DocumentSaveAsResultSchema,
      requires: ["fs:project-write"],
    },
    async (_ctx, { identity, targetPath, text, hasBom, eol }): Promise<DocumentSaveAsResult> => {
      if (!isEditableFilePath(targetPath)) return { status: "refused", reason: "NOT_MARKDOWN" };
      // The host contains the target to every root this plugin may write; the
      // editor's own promise is narrower — a new file beside the original, in
      // the same worktree (or the same directory when there is no worktree).
      const root = identity.worktreePath ?? path.dirname(identity.filePath);
      if (!isUnder(root, path.resolve(targetPath)))
        return { status: "refused", reason: "OUTSIDE_ROOT" };
      const contents = assembleDocument(text, { hasBom, eol });
      if (utf8ByteLength(contents) > MAX_EDITABLE_BYTES)
        return { status: "refused", reason: "TOO_LARGE" };
      try {
        const { revision } = await host.fs.writeFile(targetPath, contents, {
          expectedRevision: null,
        });
        return { status: "saved", path: targetPath, revision };
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const message = formatErrorMessage(error, "Save failed");
        if (code === "TARGET_EXISTS" || message.startsWith("TARGET_EXISTS"))
          return { status: "exists" };
        return { status: "error", message };
      }
    }
  );

  await host.registerHandler(
    CHANNELS.release,
    { args: DocumentReleaseArgsSchema, result: z.object({ released: z.boolean() }) },
    (_ctx, { identity, panelId }) => {
      releaseDocument(identityKey(identity), panelId);
      return { released: true };
    }
  );

  await host.registerHandler(
    CHANNELS.draftPut,
    { args: DraftPutArgsSchema, result: DraftPutResultSchema, requires: ["fs:user-data-write"] },
    (_ctx, { record, generation }) => drafts.put(record, generation)
  );
  await host.registerHandler(
    CHANNELS.draftGet,
    { args: DraftGetArgsSchema, result: DraftGetResultSchema, requires: ["fs:user-data-read"] },
    async (_ctx, { identity }) => ({ record: await drafts.get(identity) })
  );
  await host.registerHandler(
    CHANNELS.draftList,
    { args: DraftListArgsSchema, result: DraftListResultSchema, requires: ["fs:user-data-read"] },
    async () => ({ drafts: await drafts.list() })
  );
  await host.registerHandler(
    CHANNELS.draftDelete,
    {
      args: DraftDeleteArgsSchema,
      result: DraftDeleteResultSchema,
      requires: ["fs:user-data-write"],
    },
    async (_ctx, { identity, generation }) => ({
      deleted: await drafts.delete(identity, generation),
    })
  );

  await host.registerHandler(
    CHANNELS.recoverAck,
    { args: RecoverAckArgsSchema, result: RecoverAckResultSchema },
    (_ctx, { requestId }) => {
      const settle = pendingRecoveries.get(requestId);
      if (!settle) return { acknowledged: false };
      settle();
      return { acknowledged: true };
    }
  );

  // Declared in the manifest so the palette lists it before activation; the
  // handler binds here on the first dispatch, which activates the plugin.
  await host.registerAction(
    {
      id: RECOVER_DRAFTS_ACTION_ID,
      title: "Markdown: Recover drafts…",
      description:
        "List unsaved Markdown drafts whose panel is gone and reopen one in Edit mode in its own project and worktree.",
      category: "files",
      kind: "command",
      danger: "safe",
      keywords: ["markdown", "draft", "recover", "unsaved", "restore"],
      requires: ["fs:user-data-read"],
    },
    async () => {
      const list = await drafts.list();
      if (list.length === 0) {
        await host.showToast({
          type: "info",
          title: "No Markdown drafts to recover",
          message: "Every draft has been saved or discarded.",
        });
        return { recovered: false };
      }
      const picked = await host.showQuickPick(
        list.map((draft) => ({
          id: identityKey(draft.identity),
          label: path.basename(draft.identity.filePath),
          description: draft.identity.worktreePath ?? draft.identity.filePath,
          detail: `Last saved draft ${new Date(draft.updatedAt).toLocaleString()} · ${draft.identity.filePath}`,
        })),
        { title: "Recover a Markdown draft", placeholder: "Search drafts by file name" }
      );
      if (!picked) return { recovered: false };
      const draft = list.find((candidate) => identityKey(candidate.identity) === picked.id);
      if (!draft) return { recovered: false };

      // The panel opens in the renderer of the draft's own project. Switch
      // there first when the user is looking at another project, then keep
      // asking until a view for that project acknowledges the request — a
      // single broadcast could land before the switched-to view is ready.
      const active = await host.getWorktreesResult();
      if (active.status !== "ok" || active.projectId !== draft.identity.projectId) {
        await host.dispatch("project.switch", { projectId: draft.identity.projectId });
      }
      const requestId = randomUUID();
      const payload: RecoverDraftPush = { requestId, identity: draft.identity };
      const acknowledged = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          clearInterval(retry);
          clearTimeout(timeout);
          pendingRecoveries.delete(requestId);
          resolve(value);
        };
        pendingRecoveries.set(requestId, () => finish(true));
        const send = () => void host.postToPanel(PUSH_CHANNELS.recoverDraft, payload, null);
        send();
        const retry = setInterval(send, ackRetryMs);
        const timeout = setTimeout(() => finish(false), ackTimeoutMs);
      });
      if (!acknowledged) {
        await host.showToast({
          type: "warning",
          title: "Couldn't open the draft",
          message: `Open ${draft.identity.filePath} in a file panel and switch it to Edit — the draft is still stored.`,
        });
      }
      return { recovered: acknowledged };
    }
  );

  // A sleep hides every external change that happened while suspended; the
  // watcher may or may not have caught up. Re-hash each open document and let
  // the views revalidate where the disk moved.
  const disposeWake = await host.onDidWake(() => {
    for (const [key, doc] of documents) {
      void readCurrentRevision(doc.identity).then((revision) => {
        if (revision === null || revision !== doc.lastRevision) notifyChanged(key);
      });
    }
  });

  return () => {
    disposeWake();
    for (const doc of documents.values()) disposeWatch(doc);
    documents.clear();
    for (const settle of pendingRecoveries.values()) settle();
    pendingRecoveries.clear();
  };
}
