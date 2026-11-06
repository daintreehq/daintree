import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import {
  createImagePasteHandler,
  addImageChip,
  createFilePasteHandler,
  addFileDropChip,
  createPlainPasteKeymap,
} from "../inputEditorExtensions";
import { formatAtFileTokenForCwd } from "../hybridInputParsing";
import { materializeTransferSources } from "@/lib/transferSources";
import { materialize } from "@/services/materialize";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { holdBackAttachments, holdComposerSend, trackUpload } from "../uploads/pendingUploads";
import { composerDraftGeneration } from "../inputEditorExtensions/composerDraftGeneration";
import { userEdit } from "../inputEditorExtensions/userEdit";
import { referenceSeparatorAt } from "../referenceSeparator";

/**
 * `thisMachineOff`: the composer types to a terminal on another host, where a
 * pasted image or file saved on this machine would be a path to nothing, so
 * neither is taken. `editorViewRef` is the composer's live editor: a paste
 * that resolves after it is gone is dropped, as a drop is.
 */
export function usePasteExtensions(
  cwd: string,
  uploadSurface?: string,
  thisMachineOff = false,
  editorViewRef?: RefObject<EditorView | null>
) {
  // `useEditorFactory` reads these extensions once, while building the initial
  // `EditorState`, under an effect keyed on `terminalId` alone — and no
  // compartment wraps them. A memo that rebuilt the extension when `cwd`
  // changed would produce an object the editor never installs, so the file-
  // drop handler has to reach the current cwd through a ref instead. React
  // Compiler can't prove `createFilePasteHandler` defers invoking its
  // callback, so it flags the ref read as unsafe — opting the hook out of
  // compilation is the same fix `useEditorDomHandlers` uses for its own
  // installed-once handlers.
  "use no memo";
  const cwdRef = useRef(cwd);
  const uploadSurfaceRef = useRef(uploadSurface);
  const offRef = useRef(thisMachineOff);
  useEffect(() => {
    cwdRef.current = cwd;
    uploadSurfaceRef.current = uploadSurface;
    offRef.current = thisMachineOff;
  }, [cwd, uploadSurface, thisMachineOff]);

  const imagePasteExtension = useMemo(
    () =>
      createImagePasteHandler(async (view) => {
        if (offRef.current) return;
        // Sending waits until the image is in the draft, saved locally or
        // uploaded to the host.
        const surface = uploadSurfaceRef.current;
        const release = surface === undefined ? undefined : holdComposerSend(surface);
        const generation = composerDraftGeneration(view);
        try {
          const { hostPath: filePath, thumbnail } =
            surface !== undefined && isRemoteWindow()
              ? await trackUpload(surface, "Pasted image", (options) =>
                  materialize({ kind: "clipboard-image" }, options)
                )
              : await materialize({ kind: "clipboard-image" });
          const fileName = filePath.split(/[/\\]/).filter(Boolean).pop() || filePath;
          if (editorViewRef && editorViewRef.current !== view) return;
          // Pasted into a draft that has been sent or replaced since.
          if (composerDraftGeneration(view) !== generation) {
            if (surface !== undefined) {
              holdBackAttachments(surface, [
                thumbnail
                  ? { type: "image", filePath, thumbnailDataUrl: thumbnail }
                  : { type: "file", filePath, fileName, fileSize: undefined },
              ]);
            }
            return;
          }
          // The caret is read after the save, never before: typing may have
          // moved it. A view destroyed meanwhile takes the dispatch silently.
          const cursor = view.state.selection.main.head;
          const lead = referenceSeparatorAt(view.state, cursor);
          const from = cursor + lead.length;
          if (!thumbnail) {
            // No preview to put behind an image chip, so reference it the way
            // any other file is referenced.
            const token = formatAtFileTokenForCwd(filePath, cwdRef.current);
            view.dispatch({
              changes: { from: cursor, insert: lead + token + " " },
              effects: addFileDropChip.of({
                from,
                to: from + token.length,
                filePath,
                fileName,
              }),
              selection: { anchor: from + token.length + 1 },
              annotations: userEdit.of(true),
            });
            return;
          }
          view.dispatch({
            changes: { from: cursor, insert: lead + filePath + " " },
            effects: addImageChip.of({
              from,
              to: from + filePath.length,
              filePath,
              thumbnailUrl: thumbnail,
            }),
            selection: { anchor: from + filePath.length + 1 },
            annotations: userEdit.of(true),
          });
        } catch {
          // Empty clipboard, editor destroyed mid-IPC, etc. — nothing to do.
        } finally {
          release?.();
        }
      }),
    [editorViewRef]
  );

  const filePasteExtension = useMemo(
    () =>
      createFilePasteHandler(async (view, files) => {
        if (offRef.current) return;
        const surface = uploadSurfaceRef.current;
        const release = surface === undefined ? undefined : holdComposerSend(surface);
        const generation = composerDraftGeneration(view);
        try {
          const materialized = await materializeTransferSources(
            files.map((file) => ({ kind: "local", path: file.path })),
            surface !== undefined && isRemoteWindow()
              ? (source, run) =>
                  trackUpload(
                    surface,
                    files.find((file) => file.path === source.path)?.name ?? source.path,
                    run
                  )
              : undefined
          );
          const pasted = files.flatMap((file, index) => {
            const filePath = materialized[index]?.hostPath;
            return filePath ? [{ filePath, fileName: file.name, fileSize: file.size }] : [];
          });
          if (pasted.length === 0) return;
          if (editorViewRef && editorViewRef.current !== view) return;
          if (composerDraftGeneration(view) !== generation) {
            if (surface !== undefined) {
              holdBackAttachments(
                surface,
                pasted.map((file) => ({ type: "file" as const, ...file }))
              );
            }
            return;
          }
          // Caret and cwd are read after the await, like the image paste, so
          // typing or a `cd` in between lands the paste where the user now is.
          const cursor = view.state.selection.main.head;
          const effects: ReturnType<typeof addFileDropChip.of>[] = [];
          let insertText = referenceSeparatorAt(view.state, cursor);
          for (const { filePath, fileName, fileSize } of pasted) {
            const token = formatAtFileTokenForCwd(filePath, cwdRef.current);
            const from = cursor + insertText.length;
            insertText += token + " ";
            effects.push(
              addFileDropChip.of({
                from,
                to: from + token.length,
                // Absolute on purpose — see the matching note in `useDragDrop`.
                filePath,
                fileName,
                fileSize,
              })
            );
          }
          try {
            view.dispatch({
              changes: { from: cursor, insert: insertText },
              effects,
              selection: { anchor: cursor + insertText.length },
              annotations: userEdit.of(true),
            });
          } catch {
            // Editor destroyed while the paths resolved — nothing to do.
          }
        } finally {
          release?.();
        }
      }),
    [editorViewRef]
  );

  const plainPasteKeymap = useMemo(() => createPlainPasteKeymap(), []);

  return { imagePasteExtension, filePasteExtension, plainPasteKeymap };
}
