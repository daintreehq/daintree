import type { BrowserPanelData } from "@shared/types/panel";
import type { PanelSnapshot } from "@shared/types/project";

export function serializeBrowser(t: BrowserPanelData): Partial<PanelSnapshot> {
  return {
    ...(t.browserUrl != null && { browserUrl: t.browserUrl }),
    ...(t.browserHistory && { browserHistory: t.browserHistory }),
    ...(t.browserZoom != null && { browserZoom: t.browserZoom }),
    ...(t.browserConsoleOpen !== undefined && { browserConsoleOpen: t.browserConsoleOpen }),
  };
}
