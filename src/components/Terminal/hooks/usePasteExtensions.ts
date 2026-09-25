import { useEffect, useMemo, useRef } from "react";
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
import { trackUpload } from "../uploads/pendingUploads";

export function usePasteExtensions(cwd: string, uploadSurface?: string) {
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
  useEffect(() => {
    cwdRef.current = cwd;
    uploadSurfaceRef.current = uploadSurface;
  }, [cwd, uploadSurface]);

  const imagePasteExtension = useMemo(
    () =>
      createImagePasteHandler(async (view) => {
        try {
          // Tracked in a remote window, so sending waits for the image to reach the host.
          const surface = uploadSurfaceRef.current;
          const { hostPath: filePath, thumbnail } =
            surface !== undefined && isRemoteWindow()
              ? await trackUpload(surface, "Pasted image", () =>
                  materialize({ kind: "clipboard-image" })
                )
              : await materialize({ kind: "clipboard-image" });
          // The caret is read after the save, never before: typing may have
          // moved it. A view destroyed meanwhile takes the dispatch silently.
          const cursor = view.state.selection.main.head;
          if (!thumbnail) {
            // No preview to put behind an image chip, so reference it the way
            // any other file is referenced.
            const token = formatAtFileTokenForCwd(filePath, cwdRef.current);
            view.dispatch({
              changes: { from: cursor, insert: token + " " },
              effects: addFileDropChip.of({
                from: cursor,
                to: cursor + token.length,
                filePath,
                fileName: filePath.split(/[/\\]/).filter(Boolean).pop() || filePath,
              }),
              selection: { anchor: cursor + token.length + 1 },
            });
            return;
          }
          view.dispatch({
            changes: { from: cursor, insert: filePath + " " },
            effects: addImageChip.of({
              from: cursor,
              to: cursor + filePath.length,
              filePath,
              thumbnailUrl: thumbnail,
            }),
            selection: { anchor: cursor + filePath.length + 1 },
          });
        } catch {
          // Empty clipboard, editor destroyed mid-IPC, etc. — nothing to do.
        }
      }),
    []
  );

  const filePasteExtension = useMemo(
    () =>
      createFilePasteHandler(async (view, files) => {
        const surface = uploadSurfaceRef.current;
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
        // Caret and cwd are read after the await, like the image paste, so
        // typing or a `cd` in between lands the paste where the user now is.
        const cursor = view.state.selection.main.head;
        const effects: ReturnType<typeof addFileDropChip.of>[] = [];
        let insertText = "";
        files.forEach((file, index) => {
          const filePath = materialized[index]?.hostPath;
          if (!filePath) return;
          const token = formatAtFileTokenForCwd(filePath, cwdRef.current);
          const from = cursor + insertText.length;
          insertText += token + " ";
          effects.push(
            addFileDropChip.of({
              from,
              to: from + token.length,
              // Absolute on purpose — see the matching note in `useDragDrop`.
              filePath,
              fileName: file.name,
              fileSize: file.size,
            })
          );
        });
        if (insertText === "") return;
        try {
          view.dispatch({
            changes: { from: cursor, insert: insertText },
            effects,
            selection: { anchor: cursor + insertText.length },
          });
        } catch {
          // Editor destroyed while the paths resolved — nothing to do.
        }
      }),
    []
  );

  const plainPasteKeymap = useMemo(() => createPlainPasteKeymap(), []);

  return { imagePasteExtension, filePasteExtension, plainPasteKeymap };
}
