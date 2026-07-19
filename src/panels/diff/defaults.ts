import type { DiffPanelData } from "@shared/types/panel";
import type { DiffPanelOptions } from "@shared/types/addPanelOptions";

export function createDiffDefaults(options: DiffPanelOptions): Partial<DiffPanelData> {
  return {
    filePath: options.filePath,
    fileStatus: options.fileStatus ?? "modified",
    diffSource: options.diffSource ?? "working-tree",
    ...(options.baseBranch != null && { baseBranch: options.baseBranch }),
    ...(options.changeSet != null && { changeSet: options.changeSet }),
  };
}
