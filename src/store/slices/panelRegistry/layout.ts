import { with as withTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { TerminalRefreshTier } from "@/types";

export const optimizeForDock = (id: string): void => {
  withTerminalService((service) => service.applyRendererPolicy(id, TerminalRefreshTier.VISIBLE));
};
