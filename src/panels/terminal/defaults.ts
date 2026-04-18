import type { PtyPanelData } from "@shared/types/panel";
import type { TerminalPanelOptions } from "@shared/types/addPanelOptions";

export function createTerminalDefaults(_options: TerminalPanelOptions): Partial<PtyPanelData> {
  return {};
}
