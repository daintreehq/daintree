import { useCallback, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { IMAGE_EXTENSIONS } from "../useTerminalFileTransfer";
import { formatAtFileToken } from "../hybridInputParsing";
import { addImageChip, addFileDropChip } from "../inputEditorExtensions";

export function useDragDrop(editorViewRef: React.RefObject<EditorView | null>) {
  const dragDepthRef = useRef(0);
  const [isDragOverFiles, setIsDragOverFiles] = useState(false);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current++;
    if (dragDepthRef.current === 1) setIsDragOverFiles(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.stopPropagation();
    dragDepthRef.current--;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setIsDragOverFiles(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = 0;
      setIsDragOverFiles(false);

      const view = editorViewRef.current;
      if (!view || !e.dataTransfer.files.length) return;

      type ResolvedFile =
        | { type: "image"; filePath: string; thumbnailDataUrl: string }
        | { type: "file"; filePath: string; fileName: string };

      const resolved: ResolvedFile[] = [];

      for (const file of Array.from(e.dataTransfer.files)) {
        const filePath = window.electron.webUtils.getPathForFile(file);
        if (!filePath) continue;
        const name = file.name.trim() || filePath.split(/[/\\]/).filter(Boolean).pop() || filePath;

        if (IMAGE_EXTENSIONS.test(file.name)) {
          try {
            const result = await window.electron.clipboard.thumbnailFromPath(filePath);
            if (result.ok) {
              resolved.push({ type: "image", filePath, thumbnailDataUrl: result.thumbnailDataUrl });
            } else {
              resolved.push({ type: "file", filePath, fileName: name });
            }
          } catch {
            resolved.push({ type: "file", filePath, fileName: name });
          }
        } else {
          resolved.push({ type: "file", filePath, fileName: name });
        }
      }

      if (resolved.length === 0) return;

      try {
        const cursor = view.state.selection.main.head;
        const imageEffects: ReturnType<typeof addImageChip.of>[] = [];
        const fileEffects: ReturnType<typeof addFileDropChip.of>[] = [];
        let insertText = "";

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
            const token = formatAtFileToken(entry.filePath);
            insertText += token + " ";
            fileEffects.push(
              addFileDropChip.of({
                from,
                to: from + token.length,
                filePath: entry.filePath,
                fileName: entry.fileName,
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
    },
    [editorViewRef]
  );

  return { handleDragEnter, handleDragOver, handleDragLeave, handleDrop, isDragOverFiles };
}
