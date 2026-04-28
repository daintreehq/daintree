import type { DevPreviewPanelData } from "@shared/types/panel";
import type { PanelSnapshot } from "@shared/types/project";

/**
 * Serializer input: `DevPreviewPanelData` plus the legacy `createdAt` field,
 * which is persisted but not declared on the shared variant interface.
 */
type DevPreviewSerializeInput = DevPreviewPanelData & {
  createdAt?: number;
};

export function serializeDevPreview(t: DevPreviewSerializeInput): Partial<PanelSnapshot> {
  return {
    cwd: t.cwd,
    command: t.devCommand?.trim() || undefined,
    ...(t.browserUrl != null && { browserUrl: t.browserUrl }),
    ...(t.browserHistory && { browserHistory: t.browserHistory }),
    ...(t.browserZoom != null && { browserZoom: t.browserZoom }),
    ...(t.devPreviewConsoleOpen !== undefined && {
      devPreviewConsoleOpen: t.devPreviewConsoleOpen,
    }),
    ...(t.viewportPreset !== undefined && { viewportPreset: t.viewportPreset }),
    ...(t.devPreviewScrollPosition !== undefined && {
      devPreviewScrollPosition: t.devPreviewScrollPosition,
    }),
    ...(t.createdAt !== undefined && { createdAt: t.createdAt }),
    ...(t.exitBehavior !== undefined && { exitBehavior: t.exitBehavior }),
  };
}
