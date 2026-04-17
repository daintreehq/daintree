import type { TerminalInstance } from "@shared/types/panel";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";

export function createBrowserDefaults(options: AddPanelOptions): Partial<TerminalInstance> {
  return {
    browserUrl:
      ("browserUrl" in options ? options.browserUrl : undefined) || "http://localhost:3000",
    browserHistory: "browserHistory" in options ? options.browserHistory : undefined,
    browserZoom: "browserZoom" in options ? options.browserZoom : undefined,
    browserConsoleOpen: "browserConsoleOpen" in options ? options.browserConsoleOpen : undefined,
  };
}
