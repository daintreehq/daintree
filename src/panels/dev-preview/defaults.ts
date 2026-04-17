import type { TerminalInstance } from "@shared/types/panel";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";

export function createDevPreviewDefaults(options: AddPanelOptions): Partial<TerminalInstance> {
  return {
    cwd: ("cwd" in options ? options.cwd : undefined) ?? "",
    devCommand: "devCommand" in options ? options.devCommand : undefined,
    browserUrl: "browserUrl" in options ? options.browserUrl : undefined,
    browserHistory: "browserHistory" in options ? options.browserHistory : undefined,
    browserZoom: "browserZoom" in options ? options.browserZoom : undefined,
    devServerStatus: "devServerStatus" in options ? options.devServerStatus : undefined,
    devServerUrl: ("devServerUrl" in options ? options.devServerUrl : undefined) ?? undefined,
    devServerError: ("devServerError" in options ? options.devServerError : undefined) ?? undefined,
    devServerTerminalId:
      ("devServerTerminalId" in options ? options.devServerTerminalId : undefined) ?? undefined,
    devPreviewConsoleOpen:
      "devPreviewConsoleOpen" in options ? options.devPreviewConsoleOpen : undefined,
    exitBehavior: "exitBehavior" in options ? options.exitBehavior : undefined,
  };
}
