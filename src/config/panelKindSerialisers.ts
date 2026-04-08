import type { PanelKind } from "@/types";
import type { AddTerminalArgs, SavedTerminalData } from "@/utils/stateHydration/statePatcher";

type PanelKindDeserializer = (saved: SavedTerminalData) => Partial<AddTerminalArgs>;

const DESERIALIZERS: Record<string, PanelKindDeserializer> = {
  browser: (saved) => ({
    browserUrl: saved.browserUrl,
    browserHistory: saved.browserHistory,
    browserZoom: saved.browserZoom,
    browserConsoleOpen: saved.browserConsoleOpen,
  }),

  notes: (saved) => ({
    notePath: saved.notePath,
    noteId: saved.noteId,
    scope: saved.scope as "worktree" | "project" | undefined,
    createdAt: saved.createdAt,
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
      createdAt: saved.createdAt,
    };
  },
};

export function getDeserializer(kind: PanelKind): PanelKindDeserializer | undefined {
  return DESERIALIZERS[kind];
}

export function registerDeserializer(kind: PanelKind, deserializer: PanelKindDeserializer): void {
  DESERIALIZERS[kind] = deserializer;
}
