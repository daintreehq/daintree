import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";

export const optimizeForDock = (id: string): void => {
  terminalInstanceService.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE);
};
