import type { DiffPanelData } from "@shared/types/panel";
import type { PanelSnapshot } from "@shared/types/project";

export function serializeDiff(t: DiffPanelData): Partial<PanelSnapshot> {
  return {
    ...(t.filePath != null && { filePath: t.filePath }),
    ...(t.fileStatus != null && { fileStatus: t.fileStatus }),
    ...(t.diffSource != null && { diffSource: t.diffSource }),
    ...(t.baseBranch != null && { baseBranch: t.baseBranch }),
  };
}
