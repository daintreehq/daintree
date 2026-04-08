import type { TerminalInstance } from "@shared/types/panel";
import type { TerminalSnapshot } from "@shared/types/project";

export function serializeBrowser(t: TerminalInstance): Partial<TerminalSnapshot> {
  return {
    ...(t.browserUrl != null && { browserUrl: t.browserUrl }),
    ...(t.browserHistory && { browserHistory: t.browserHistory }),
    ...(t.browserZoom != null && { browserZoom: t.browserZoom }),
    ...(t.browserConsoleOpen !== undefined && { browserConsoleOpen: t.browserConsoleOpen }),
  };
}
