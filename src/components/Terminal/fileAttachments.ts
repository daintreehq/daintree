import type { RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { basename } from "@shared/utils/path";
import {
  materializeTransferSources,
  type TransferSource,
  type TransferSourceKind,
} from "@/lib/transferSources";
import { IMAGE_EXTENSIONS } from "./useTerminalFileTransfer";
import { formatAtFileTokenForCwd } from "./hybridInputParsing";
import { addImageChip, addFileDropChip } from "./inputEditorExtensions";

/**
 * A file headed for the composer, normalized across every provenance (OS drop,
 * in-app drag, attach picker) before anything is resolved. `rawName` is the
 * untrimmed name used to classify images; `fileName` is what the chip displays
 * and can differ from it.
 */
export interface FileAttachmentEntry {
  /** Where `filePath` lives before it is materialized for the agent. */
  source: TransferSourceKind;
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
  if (transfer.kind === "host") return fileAttachmentEntryFromPath(transfer.path, "host");
  const { path: filePath, name: rawName, size: fileSize } = transfer;
  return {
    source: "local",
    filePath,
    rawName,
    fileName: rawName.trim() || filePath.split(/[/\\]/).filter(Boolean).pop() || filePath,
    fileSize,
  };
}

type ResolvedFile =
  | { type: "image"; filePath: string; thumbnailDataUrl: string }
  | { type: "file"; filePath: string; fileName: string; fileSize: number | undefined };

/**
 * Inserts `entries` at the caret of `view` as chips, in order, in a single
 * transaction: images as their absolute path behind a thumbnail chip, anything
 * else as an `@file` token. Every entry goes through `materialize` first, which
 * is the identity locally, and one that fails is skipped. `editorViewRef` is
 * the live ref `view` was read from, so an editor torn down while a path or
 * thumbnail resolves is left alone.
 */
export async function insertFileAttachments(
  editorViewRef: RefObject<EditorView | null>,
  view: EditorView,
  entries: readonly FileAttachmentEntry[],
  cwd: string
): Promise<void> {
  const materialized = await materializeTransferSources(
    entries.map(({ source, filePath }) => ({ kind: source, path: filePath }))
  );
  const resolved: ResolvedFile[] = [];

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
        resolved.push({ type: "image", filePath, thumbnailDataUrl: result.thumbnail });
        continue;
      }
      try {
        const { thumbnailDataUrl } = await window.electron.clipboard.thumbnailFromPath(filePath);
        resolved.push({ type: "image", filePath, thumbnailDataUrl });
      } catch {
        resolved.push({ type: "file", filePath, fileName, fileSize });
      }
    } else {
      resolved.push({ type: "file", filePath, fileName, fileSize });
    }
  }

  if (resolved.length === 0) return;

  // A thumbnail await above can outlive the editor it started in: the pane
  // can unmount or remount (`useEditorFactory` destroys the view and nulls
  // the ref) while an image resolves. Dispatching into the detached view
  // would insert into a document nothing is showing any more.
  if (editorViewRef.current !== view) return;

  try {
    const cursor = view.state.selection.main.head;
    const imageEffects: ReturnType<typeof addImageChip.of>[] = [];
    const fileEffects: ReturnType<typeof addFileDropChip.of>[] = [];
    // A reference only parses at a boundary: `look at this@a.ts` carries no
    // `@file` token, and an absolute path glued to a word is no path at all.
    // The button makes that the common case — the caret sits right after
    // whatever was typed before reaching for it.
    let insertText =
      cursor > 0 && !/[\s([{]/.test(view.state.doc.sliceString(cursor - 1, cursor)) ? " " : "";

    for (const entry of resolved) {
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

    view.dispatch({
      changes: { from: cursor, insert: insertText },
      effects: [...imageEffects, ...fileEffects],
      selection: { anchor: cursor + insertText.length },
    });
  } catch {
    // Editor may have been destroyed
  }
}
