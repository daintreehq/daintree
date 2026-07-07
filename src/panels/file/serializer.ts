import type { FilePanelData } from "@shared/types/panel";
import type { PanelSnapshot } from "@shared/types/project";

export function serializeFile(t: FilePanelData): Partial<PanelSnapshot> {
  return {
    ...(t.filePath != null && { filePath: t.filePath }),
    ...(t.fileViewMode != null && { fileViewMode: t.fileViewMode }),
  };
}
