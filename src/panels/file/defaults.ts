import type { FilePanelData } from "@shared/types/panel";
import type { FilePanelOptions } from "@shared/types/addPanelOptions";

export function createFileDefaults(options: FilePanelOptions): Partial<FilePanelData> {
  return {
    filePath: options.filePath,
    // Left out unless asked for: an unset mode is Source, except where a viewer
    // that ships with Daintree can show the file (a CSV's table), which the
    // pane learns only once the file and the plugin snapshot have loaded.
    ...(options.fileViewMode && { fileViewMode: options.fileViewMode }),
    ...(options.initialLine != null && { initialLine: options.initialLine }),
    ...(options.fileContainmentRoot && { fileContainmentRoot: options.fileContainmentRoot }),
    ...(options.fileEditorChoice && { fileEditorChoice: options.fileEditorChoice }),
  };
}
