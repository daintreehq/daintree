import type { BrowserPanelData } from "@shared/types/panel";
import type { BrowserPanelOptions } from "@shared/types/addPanelOptions";

export function createBrowserDefaults(options: BrowserPanelOptions): Partial<BrowserPanelData> {
  return {
    browserUrl: options.browserUrl || "http://localhost:3000",
    browserHistory: options.browserHistory,
    browserZoom: options.browserZoom,
    browserConsoleOpen: options.browserConsoleOpen,
  };
}
