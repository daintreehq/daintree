import type { DevPreviewPanelData } from "@shared/types/panel";
import type { DevPreviewPanelOptions } from "@shared/types/addPanelOptions";

export function createDevPreviewDefaults(
  options: DevPreviewPanelOptions
): Partial<DevPreviewPanelData> {
  return {
    cwd: options.cwd ?? "",
    devCommand: options.devCommand,
    browserUrl: options.browserUrl,
    browserHistory: options.browserHistory,
    browserZoom: options.browserZoom,
    devServerStatus: options.devServerStatus,
    devServerUrl: options.devServerUrl,
    devServerError: options.devServerError,
    devServerTerminalId: options.devServerTerminalId,
    devPreviewConsoleOpen: options.devPreviewConsoleOpen,
    devPreviewConsoleTab: options.devPreviewConsoleTab,
    exitBehavior: options.exitBehavior,
    viewportPreset: options.viewportPreset,
    viewportRotated: options.viewportRotated ?? false,
    viewportDpr: options.viewportDpr ?? 1,
    viewportFit: options.viewportFit ?? false,
    devPreviewScrollPosition: options.devPreviewScrollPosition,
  };
}
