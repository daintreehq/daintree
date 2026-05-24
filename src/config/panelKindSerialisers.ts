import type { BuiltInPanelKind, PanelKind, ViewportPresetId } from "@/types";
import type { AddTerminalArgs, SavedTerminalData } from "@/utils/stateHydration/statePatcher";
import { VIEWPORT_PRESETS } from "@/panels/dev-preview/viewportPresets";

type PanelKindDeserializer = (saved: SavedTerminalData) => Partial<AddTerminalArgs>;

/** Coerce a persisted viewport-preset string to a known id, dropping stale values. */
function sanitizeViewportPreset(value: string | undefined): ViewportPresetId | undefined {
  return value !== undefined && value in VIEWPORT_PRESETS ? (value as ViewportPresetId) : undefined;
}

// Terminal is omitted — PTY panels restore through backend payload, not this
// registry. Review is omitted — review panels carry no kind-specific persisted
// state. `Record<string, …>` stays for registerDeserializer plugin mutation.
const DESERIALIZERS: Record<string, PanelKindDeserializer> = {
  browser: (saved) => ({
    browserUrl: saved.browserUrl,
    browserHistory: saved.browserHistory,
    browserZoom: saved.browserZoom,
    browserConsoleOpen: saved.browserConsoleOpen,
  }),

  "dev-preview": (saved) => {
    const devCommandCandidate = saved.devCommand?.trim();
    const devCommand = devCommandCandidate || saved.command?.trim() || undefined;
    return {
      devCommand,
      browserUrl: saved.browserUrl,
      browserHistory: saved.browserHistory,
      browserZoom: saved.browserZoom,
      devPreviewConsoleOpen: saved.devPreviewConsoleOpen,
      devPreviewConsoleTab: saved.devPreviewConsoleTab,
      viewportPreset: sanitizeViewportPreset(saved.viewportPreset),
      viewportRotated: saved.viewportRotated === true,
      viewportDpr: saved.viewportDpr === 2 || saved.viewportDpr === 3 ? saved.viewportDpr : 1,
      viewportFit: saved.viewportFit === true,
      devPreviewScrollPosition: saved.devPreviewScrollPosition,
      createdAt: saved.createdAt,
    };
  },
} satisfies Partial<Record<BuiltInPanelKind, PanelKindDeserializer>>;

export function getDeserializer(kind: PanelKind): PanelKindDeserializer | undefined {
  return DESERIALIZERS[kind];
}

export function registerDeserializer(kind: PanelKind, deserializer: PanelKindDeserializer): void {
  DESERIALIZERS[kind] = deserializer;
}
