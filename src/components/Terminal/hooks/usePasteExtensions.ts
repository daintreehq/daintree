import { useEffect, useMemo, useRef } from "react";
import {
  createImagePasteHandler,
  addImageChip,
  createFilePasteHandler,
  addFileDropChip,
  createPlainPasteKeymap,
} from "../inputEditorExtensions";
import { formatAtFileTokenForCwd } from "../hybridInputParsing";

export function usePasteExtensions(cwd: string) {
  // `useEditorFactory` reads these extensions once, while building the initial
  // `EditorState`, under an effect keyed on `terminalId` alone — and no
  // compartment wraps them. A memo that rebuilt the extension when `cwd`
  // changed would produce an object the editor never installs, so the handler
  // has to reach the current cwd through a ref instead. Same latest-value ref
  // pattern `useEditorDomHandlers` uses for its own installed-once handlers.
  const cwdRef = useRef(cwd);
  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);

  const imagePasteExtension = useMemo(
    () =>
      createImagePasteHandler(async (view) => {
        try {
          const { filePath, thumbnailDataUrl } = await window.electron.clipboard.saveImage();
          const cursor = view.state.selection.main.head;
          view.dispatch({
            changes: { from: cursor, insert: filePath + " " },
            effects: addImageChip.of({
              from: cursor,
              to: cursor + filePath.length,
              filePath,
              thumbnailUrl: thumbnailDataUrl,
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
      createFilePasteHandler((view, files) => {
        const cursor = view.state.selection.main.head;
        const effects: ReturnType<typeof addFileDropChip.of>[] = [];
        let insertText = "";
        for (const file of files) {
          const token = formatAtFileTokenForCwd(file.path, cwdRef.current);
          const from = cursor + insertText.length;
          insertText += token + " ";
          effects.push(
            addFileDropChip.of({
              from,
              to: from + token.length,
              // Absolute on purpose — see the matching note in `useDragDrop`.
              filePath: file.path,
              fileName: file.name,
              fileSize: file.size,
            })
          );
        }
        view.dispatch({
          changes: { from: cursor, insert: insertText },
          effects,
          selection: { anchor: cursor + insertText.length },
        });
      }),
    []
  );

  const plainPasteKeymap = useMemo(() => createPlainPasteKeymap(), []);

  return { imagePasteExtension, filePasteExtension, plainPasteKeymap };
}
