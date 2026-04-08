import type { TerminalInstance } from "@shared/types/panel";
import type { TerminalSnapshot } from "@shared/types/project";

export function serializeDevPreview(t: TerminalInstance): Partial<TerminalSnapshot> {
  return {
    type: t.type,
    cwd: t.cwd,
    command: t.devCommand?.trim() || undefined,
    ...(t.browserUrl != null && { browserUrl: t.browserUrl }),
    ...(t.browserHistory && { browserHistory: t.browserHistory }),
    ...(t.browserZoom != null && { browserZoom: t.browserZoom }),
    ...(t.devPreviewConsoleOpen !== undefined && {
      devPreviewConsoleOpen: t.devPreviewConsoleOpen,
    }),
    ...(t.createdAt !== undefined && { createdAt: t.createdAt }),
    ...(t.exitBehavior !== undefined && { exitBehavior: t.exitBehavior }),
  };
}
