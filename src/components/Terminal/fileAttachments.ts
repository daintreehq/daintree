import type { RefObject } from "react";
import { Transaction } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { basename } from "@shared/utils/path";
import type { HostId, MaterializeOptions } from "@shared/types/remoteHosts";
import {
  materializeTransferSources,
  type TransferSource,
  type TransferSourceKind,
} from "@/lib/transferSources";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import {
  holdBackAttachments,
  holdComposerSend,
  trackUpload,
  type PreparedAttachment,
} from "./uploads/pendingUploads";
import { IMAGE_EXTENSIONS } from "./useTerminalFileTransfer";
import { formatAtFileTokenForCwd } from "./hybridInputParsing";
import type { PendingImageRange } from "@/lib/composerPendingImages";
import {
  addImageChip,
  addFileDropChip,
  restoredImageChipEffects,
  setImageChipPreview,
} from "./inputEditorExtensions";
import { composerDraftGeneration } from "./inputEditorExtensions/composerDraftGeneration";
import { userEdit } from "./inputEditorExtensions/userEdit";
import { referenceSeparatorAt } from "./referenceSeparator";

/**
 * A file headed for the composer, normalized across every provenance (OS drop,
 * in-app drag, attach picker) before anything is resolved. `rawName` is the
 * untrimmed name used to classify images; `fileName` is what the chip displays
 * and can differ from it.
 */
export interface FileAttachmentEntry {
  /** Where `filePath` lives before it is materialized for the agent. */
  source: TransferSourceKind;
  /** For a `host` entry from a remote window's tree: the host it lives on. */
  hostId?: HostId;
  filePath: string;
  rawName: string;
  fileName: string;
  fileSize: number | undefined;
}

/**
 * An entry for a bare absolute path — an in-app drag or the attach picker,
 * neither of which has a `File` behind it. The name comes from the path and
 * there is no size, which the chip already treats as optional: the tooltip
 * just omits the size line rather than this reaching for a stat over IPC.
 */
export function fileAttachmentEntryFromPath(
  filePath: string,
  source: TransferSourceKind
): FileAttachmentEntry {
  const rawName = basename(filePath);
  return { source, filePath, rawName, fileName: rawName || filePath, fileSize: undefined };
}

/**
 * An entry for a resolved drop. An OS `File` carries its own name and size;
 * the display name falls back to the path's last segment when the OS name is
 * blank. An in-app drag takes {@link fileAttachmentEntryFromPath}'s spelling.
 */
export function fileAttachmentEntryFromSource(transfer: TransferSource): FileAttachmentEntry {
  if (transfer.kind === "host") {
    const entry = fileAttachmentEntryFromPath(transfer.path, "host");
    return transfer.hostId === undefined ? entry : { ...entry, hostId: transfer.hostId };
  }
  const { path: filePath, name: rawName, size: fileSize } = transfer;
  return {
    source: "local",
    filePath,
    rawName,
    fileName: rawName.trim() || filePath.split(/[/\\]/).filter(Boolean).pop() || filePath,
    fileSize,
  };
}

export interface InsertFileAttachmentsOptions {
  /**
   * Where uploads to a remote host show their progress chips. Sending from the
   * composer waits until every attachment is in the draft, and attachments
   * whose draft is gone by then are held back here.
   */
  uploadSurface?: string;
  /** Add to project: upload into this folder of the project instead of the inbox. */
  destination?: MaterializeOptions["destination"];
  /** The terminal's cwd when the references are inserted, read after the uploads land. */
  cwdProvider?: () => string;
}

/**
 * Inserts `entries` at the caret of `view` as chips, in order, in a single
 * transaction: images as their absolute path behind a thumbnail chip, anything
 * else as an `@file` token. Every entry goes through `materialize` first, which
 * is the identity locally, and one that fails is skipped. `editorViewRef` is
 * the live ref `view` was read from, so an editor torn down while a path or
 * thumbnail resolves is left alone.
 *
 * In a remote window each upload runs under a chip on `uploadSurface`, and
 * nothing is inserted until every upload has settled. A draft sent or replaced
 * in the meantime gets none of them: they are held back on `uploadSurface`
 * for the composer to offer.
 */
export async function insertFileAttachments(
  editorViewRef: RefObject<EditorView | null>,
  view: EditorView,
  entries: readonly FileAttachmentEntry[],
  cwd: string,
  options: InsertFileAttachmentsOptions = {}
): Promise<void> {
  const { uploadSurface, destination, cwdProvider } = options;
  const release = uploadSurface === undefined ? undefined : holdComposerSend(uploadSurface);
  const generation = composerDraftGeneration(view);
  try {
    const tracked = uploadSurface !== undefined && isRemoteWindow();
    const materialized = await materializeTransferSources(
      entries.map(({ source, filePath, hostId }) =>
        hostId === undefined
          ? { kind: source, path: filePath }
          : { kind: source, path: filePath, hostId }
      ),
      tracked
        ? (source, run) =>
            trackUpload(uploadSurface, basename(source.path) || source.path, (progress) =>
              run(destination ? { ...progress, destination } : progress)
            )
        : destination
          ? (_source, run) => run({ destination })
          : undefined
    );
    const prepared: PreparedAttachment[] = [];

    for (const [index, { rawName, fileName, fileSize }] of entries.entries()) {
      const result = materialized[index];
      if (!result) continue;
      const filePath = result.hostPath;
      // Classified on the untrimmed name every provenance agrees on, never on
      // the display name: a real file called `shot.png ` is not an image, and
      // trimming first would make the same file classify one way from Finder
      // and the other way from the tree.
      //
      // A dragged folder reaches this too. One whose name ends in an image
      // extension fails the thumbnail and falls back to the file chip, which
      // is the same recovery a corrupt image already takes.
      if (IMAGE_EXTENSIONS.test(rawName)) {
        if (result.thumbnail) {
          prepared.push({ type: "image", filePath, thumbnailDataUrl: result.thumbnail });
          continue;
        }
        try {
          const { thumbnailDataUrl } = await window.electron.clipboard.thumbnailFromPath(filePath);
          prepared.push({ type: "image", filePath, thumbnailDataUrl });
        } catch {
          prepared.push({ type: "file", filePath, fileName, fileSize });
        }
      } else {
        prepared.push({ type: "file", filePath, fileName, fileSize });
      }
    }

    if (prepared.length === 0) return;

    // A thumbnail await above can outlive the editor it started in: the pane
    // can unmount or remount (`useEditorFactory` destroys the view and nulls
    // the ref) while an image resolves. Dispatching into the detached view
    // would insert into a document nothing is showing any more.
    if (editorViewRef.current !== view) return;

    // The same editor can be showing a different draft by now, the one after
    // a send that was already on its way. These were never meant for it.
    if (composerDraftGeneration(view) !== generation) {
      if (uploadSurface !== undefined) holdBackAttachments(uploadSurface, prepared);
      return;
    }

    insertPreparedAttachments(view, prepared, cwdProvider?.() ?? cwd);
  } finally {
    release?.();
  }
}

/**
 * Inserts `prepared` at the caret of `view` as chips, in order, in a single
 * transaction: images as their absolute path behind a thumbnail chip, anything
 * else as an `@file` token relative to `cwd`. False when nothing went in.
 */
export function insertPreparedAttachments(
  view: EditorView,
  prepared: readonly PreparedAttachment[],
  cwd: string
): boolean {
  if (prepared.length === 0) return false;
  try {
    const cursor = view.state.selection.main.head;
    const imageEffects: ReturnType<typeof addImageChip.of>[] = [];
    const fileEffects: ReturnType<typeof addFileDropChip.of>[] = [];
    let insertText = referenceSeparatorAt(view.state, cursor);

    for (const entry of prepared) {
      const from = cursor + insertText.length;
      if (entry.type === "image") {
        insertText += entry.filePath + " ";
        imageEffects.push(
          addImageChip.of({
            from,
            to: from + entry.filePath.length,
            filePath: entry.filePath,
            thumbnailUrl: entry.thumbnailDataUrl,
          })
        );
      } else {
        const token = formatAtFileTokenForCwd(entry.filePath, cwd);
        insertText += token + " ";
        fileEffects.push(
          addFileDropChip.of({
            from,
            to: from + token.length,
            // Chip metadata stays absolute: it feeds the hover tooltip and
            // the remove-by-path lookup, neither of which has a cwd to
            // resolve against.
            filePath: entry.filePath,
            fileName: entry.fileName,
            fileSize: entry.fileSize,
          })
        );
      }
    }

    const before = view.state.doc;
    view.dispatch({
      changes: { from: cursor, insert: insertText },
      effects: [...imageEffects, ...fileEffects],
      selection: { anchor: cursor + insertText.length },
      annotations: userEdit.of(true),
    });
    // Refused at a caret among words still being corrected.
    return view.state.doc !== before;
  } catch {
    // Editor may have been destroyed
    return false;
  }
}

async function readPreview(filePath: string): Promise<string | null> {
  try {
    const { thumbnailDataUrl } = await window.electron.clipboard.thumbnailFromPath(filePath);
    return thumbnailDataUrl;
  } catch {
    return null;
  }
}

/**
 * Puts the chips for `images` back on the text `view` shows (#16786): at once,
 * so a send straight away attaches them, with their previews filled in as they
 * arrive. A preview that can't be read leaves its chip without one, still
 * attaching the image. `isCurrent` says whether `view` is still the composer's.
 */
export function restoreImageChips(
  view: EditorView,
  images: readonly PendingImageRange[],
  isCurrent: () => boolean
): void {
  const effects = restoredImageChipEffects(view.state, images);
  if (effects.length === 0) return;
  view.dispatch({ effects });
  const generation = composerDraftGeneration(view);
  for (const filePath of new Set(effects.map((effect) => effect.value.filePath))) {
    void readPreview(filePath).then((thumbnailUrl) => {
      if (thumbnailUrl === null || !isCurrent() || composerDraftGeneration(view) !== generation) {
        return;
      }
      view.dispatch({
        effects: setImageChipPreview.of({ filePath, thumbnailUrl }),
        annotations: Transaction.addToHistory.of(false),
      });
    });
  }
}
