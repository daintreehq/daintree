import { useCallback, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { basename } from "@shared/utils/path";
import {
  FILE_DRAG_MIME,
  decodeFileDragPaths,
  hasFileDrag,
  hasInternalFileDrag,
} from "@/lib/fileDragPayload";
import { IMAGE_EXTENSIONS } from "../useTerminalFileTransfer";
import { formatAtFileTokenForCwd } from "../hybridInputParsing";
import { addImageChip, addFileDropChip } from "../inputEditorExtensions";

/**
 * A dropped entry, normalized across the two provenances before anything is
 * resolved. `rawName` is the untrimmed name used to classify images; `fileName`
 * is what the chip displays and can differ from it.
 */
interface DroppedEntry {
  filePath: string;
  rawName: string;
  fileName: string;
  fileSize: number | undefined;
}

export function useDragDrop(editorViewRef: React.RefObject<EditorView | null>, cwd: string) {
  const dragDepthRef = useRef(0);
  const [isDragOverFiles, setIsDragOverFiles] = useState(false);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFileDrag(e.dataTransfer.types)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current++;
    if (dragDepthRef.current === 1) setIsDragOverFiles(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!hasFileDrag(e.dataTransfer.types)) return;
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
      if (!view) return;

      // Both provenances reduce to the same three fields before anything is
      // resolved, so an in-app drag (#11576) and an OS drop cannot disagree
      // about what they insert. An in-app drag has no `File` behind it: the
      // name comes from the path and there is no size, which the chip already
      // treats as optional — the tooltip just omits the size line rather than
      // this reaching for a stat over IPC.
      //
      // The internal type wins when both are somehow present; decoding it and
      // then also draining `files` would insert every reference twice.
      const dropped: DroppedEntry[] = hasInternalFileDrag(e.dataTransfer.types)
        ? (decodeFileDragPaths(e.dataTransfer.getData(FILE_DRAG_MIME)) ?? []).map((filePath) => {
            const rawName = basename(filePath);
            return {
              filePath,
              rawName,
              fileName: rawName || filePath,
              fileSize: undefined,
            };
          })
        : Array.from(e.dataTransfer.files)
            .map((file) => ({
              filePath: window.electron.webUtils.getPathForFile(file),
              rawName: file.name,
              fileSize: file.size,
            }))
            // A file the OS declines to resolve to a path is not referenceable.
            .filter((entry) => entry.filePath !== "")
            .map(({ filePath, rawName, fileSize }) => ({
              filePath,
              rawName,
              fileName: rawName.trim() || filePath.split(/[/\\]/).filter(Boolean).pop() || filePath,
              fileSize,
            }));

      if (dropped.length === 0) return;

      type ResolvedFile =
        | { type: "image"; filePath: string; thumbnailDataUrl: string }
        | {
            type: "file";
            filePath: string;
            fileName: string;
            fileSize: number | undefined;
          };

      const resolved: ResolvedFile[] = [];

      for (const { filePath, rawName, fileName, fileSize } of dropped) {
        // Classified on the untrimmed name both provenances agree on, never on
        // the display name: a real file called `shot.png ` is not an image, and
        // trimming first would make the same file classify one way from Finder
        // and the other way from the tree.
        //
        // A dragged folder reaches this too. One whose name ends in an image
        // extension fails the thumbnail and falls back to the file chip, which
        // is the same recovery a corrupt image already takes.
        if (IMAGE_EXTENSIONS.test(rawName)) {
          try {
            const { thumbnailDataUrl } =
              await window.electron.clipboard.thumbnailFromPath(filePath);
            resolved.push({ type: "image", filePath, thumbnailDataUrl });
          } catch {
            resolved.push({ type: "file", filePath, fileName, fileSize });
          }
        } else {
          resolved.push({ type: "file", filePath, fileName, fileSize });
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
    },
    [editorViewRef, cwd]
  );

  return { handleDragEnter, handleDragOver, handleDragLeave, handleDrop, isDragOverFiles };
}
