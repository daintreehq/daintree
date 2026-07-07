import type { FilePanelData } from "@shared/types/panel";
import type { FilePanelOptions } from "@shared/types/addPanelOptions";

export function createFileDefaults(options: FilePanelOptions): Partial<FilePanelData> {
  return {
    filePath: options.filePath,
    fileViewMode: options.fileViewMode ?? "source",
  };
}
