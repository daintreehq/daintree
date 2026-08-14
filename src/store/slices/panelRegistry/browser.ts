import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import type { TerminalReconnectError } from "@/types";
import { panelKindUsesTerminalUi } from "@shared/config/panelKindRegistry";
import { isPtyPanel } from "@shared/types/panel";
import { saveNormalized } from "./persistence";
import { debounce } from "@/utils/debounce";

type Set = PanelRegistryStoreApi["setState"];

// Anti-flap gate (Doherty Threshold) for reconnect error writes during hydration —
// rapid reconnect attempts can otherwise mount and dismount the banner faster
// than the eye can track. Cancelled by clearReconnectError before re-spawning
// the panel so a pending write can't resurrect a stale error.
const RECONNECT_ERROR_DEBOUNCE_MS = 400;
type DebouncedSetter = ReturnType<typeof debounce<[TerminalReconnectError]>>;

export const createBrowserActions = (
  set: Set
): Pick<
  PanelRegistrySlice,
  | "setBrowserUrl"
  | "setBrowserHistory"
  | "setBrowserZoom"
  | "setBrowserConsoleOpen"
  | "setDevPreviewConsoleOpen"
  | "setDevPreviewConsoleTab"
  | "setViewportPreset"
  | "setViewportRotated"
  | "setViewportDpr"
  | "setViewportFit"
  | "setDevPreviewScrollPosition"
  | "setDevServerState"
  | "setSpawnError"
  | "clearSpawnError"
  | "setReconnectError"
  | "clearReconnectError"
  | "setScrollbackRestoreError"
  | "clearScrollbackRestoreError"
  | "setTerminalAttachError"
  | "clearTerminalAttachError"
> => ({
  setBrowserUrl: (id, url) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;

      const kind = terminal.kind ?? "terminal";
      if (panelKindUsesTerminalUi(kind)) return state;

      const newById = { ...state.panelsById, [id]: { ...terminal, browserUrl: url } };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  setBrowserHistory: (id, history) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;

      const kind = terminal.kind ?? "terminal";
      if (panelKindUsesTerminalUi(kind)) return state;

      const newById = { ...state.panelsById, [id]: { ...terminal, browserHistory: history } };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  setBrowserZoom: (id, zoom) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;

      const kind = terminal.kind ?? "terminal";
      if (panelKindUsesTerminalUi(kind)) return state;

      const newById = { ...state.panelsById, [id]: { ...terminal, browserZoom: zoom } };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  setBrowserConsoleOpen: (id, isOpen) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      if (terminal.kind !== "browser") return state;
      if (terminal.browserConsoleOpen === isOpen) return state;

      const newById = { ...state.panelsById, [id]: { ...terminal, browserConsoleOpen: isOpen } };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  setDevPreviewConsoleOpen: (id, isOpen) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      if (terminal.kind !== "dev-preview") return state;
      if (terminal.devPreviewConsoleOpen === isOpen) return state;

      const newById = {
        ...state.panelsById,
        [id]: { ...terminal, devPreviewConsoleOpen: isOpen },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  setDevPreviewConsoleTab: (id, tab) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      if (terminal.kind !== "dev-preview") return state;
      if (terminal.devPreviewConsoleTab === tab) return state;

      const newById = {
        ...state.panelsById,
        [id]: { ...terminal, devPreviewConsoleTab: tab },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  setViewportPreset: (id, preset) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      if (terminal.kind !== "dev-preview") return state;
      if (terminal.viewportPreset === preset) return state;

      const newById = {
        ...state.panelsById,
        [id]: { ...terminal, viewportPreset: preset },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  setViewportRotated: (id, rotated) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      if (terminal.kind !== "dev-preview") return state;
      if ((terminal.viewportRotated ?? false) === rotated) return state;

      const newById = {
        ...state.panelsById,
        [id]: { ...terminal, viewportRotated: rotated },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  setViewportDpr: (id, dpr) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      if (terminal.kind !== "dev-preview") return state;
      if ((terminal.viewportDpr ?? 1) === dpr) return state;

      const newById = {
        ...state.panelsById,
        [id]: { ...terminal, viewportDpr: dpr },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  setViewportFit: (id, fit) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      if (terminal.kind !== "dev-preview") return state;
      if ((terminal.viewportFit ?? false) === fit) return state;

      const newById = {
        ...state.panelsById,
        [id]: { ...terminal, viewportFit: fit },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  setDevPreviewScrollPosition: (id, position) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      if (terminal.kind !== "dev-preview") return state;

      const existing = terminal.devPreviewScrollPosition;
      if (existing === position) return state;
      if (existing?.url === position?.url && existing?.scrollY === position?.scrollY) {
        return state;
      }

      const newById = {
        ...state.panelsById,
        [id]: { ...terminal, devPreviewScrollPosition: position },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  setDevServerState: (id, status, url, error, terminalId) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;
      if (terminal.kind !== "dev-preview") return state;

      const newById = {
        ...state.panelsById,
        [id]: {
          ...terminal,
          devServerStatus: status,
          devServerUrl: url ?? undefined,
          devServerError: error ?? undefined,
          devServerTerminalId: terminalId ?? undefined,
        },
      };
      saveNormalized(newById, state.panelIds);
      return { panelsById: newById };
    });
  },

  setSpawnError: (id, error) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;

      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, spawnError: error, runtimeStatus: "error" as const },
        },
      };
    });
  },

  clearSpawnError: (id) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;

      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, spawnError: undefined, runtimeStatus: undefined },
        },
      };
    });
  },

  setReconnectError: (id, error) => {
    let debouncedSetter = reconnectErrorDebouncers.get(id);
    if (!debouncedSetter) {
      debouncedSetter = debounce<[TerminalReconnectError]>((nextError) => {
        // Self-evict so long-lived sessions with many reconnect events don't
        // accumulate stale debouncer closures keyed by panel id.
        reconnectErrorDebouncers.delete(id);
        set((state) => {
          const terminal = state.panelsById[id];
          if (!terminal) return state;

          return {
            panelsById: {
              ...state.panelsById,
              [id]: { ...terminal, reconnectError: nextError, runtimeStatus: "error" as const },
            },
          };
        });
      }, RECONNECT_ERROR_DEBOUNCE_MS);
      reconnectErrorDebouncers.set(id, debouncedSetter);
    }
    debouncedSetter(error);
  },

  clearReconnectError: (id) => {
    cancelReconnectErrorDebounce(id);
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;

      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, reconnectError: undefined, runtimeStatus: undefined },
        },
      };
    });
  },

  // Scrollback restore is a one-shot lifecycle event — no debounce. Severity
  // is "warning" not "error", so we deliberately do NOT flip runtimeStatus;
  // the terminal is still operational, only the replayed history is missing.
  setScrollbackRestoreError: (id, error) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal || !isPtyPanel(terminal)) return state;

      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, scrollbackRestoreError: error },
        },
      };
    });
  },

  clearScrollbackRestoreError: (id) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal || !isPtyPanel(terminal)) return state;
      if (terminal.scrollbackRestoreError === undefined) return state;

      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, scrollbackRestoreError: undefined },
        },
      };
    });
  },

  // Renderer attach failure (#11776). Unlike the scrollback banner above this
  // one IS an error: the pane paints nothing at all while its agent keeps
  // working, so the user is blind to a running process rather than missing
  // history. No debounce — the service only writes it after it has already
  // classified the open as failed.
  setTerminalAttachError: (id, error) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal || !isPtyPanel(terminal)) return state;
      if (terminal.attachError === error) return state;

      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, attachError: error },
        },
      };
    });
  },

  clearTerminalAttachError: (id) => {
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal || !isPtyPanel(terminal)) return state;
      if (terminal.attachError === undefined) return state;

      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, attachError: undefined },
        },
      };
    });
  },
});

const reconnectErrorDebouncers = new Map<string, DebouncedSetter>();

export function cancelReconnectErrorDebounce(id: string): void {
  const debounced = reconnectErrorDebouncers.get(id);
  if (debounced) {
    debounced.cancel();
    reconnectErrorDebouncers.delete(id);
  }
}

// Test-only escape hatch — vitest fake timers can't observe setTimeout calls
// scheduled on the real timer queue, so tests that simulate hydration races
// need a way to drop module-level state between cases.
export function __resetReconnectErrorDebouncersForTesting(): void {
  for (const debounced of reconnectErrorDebouncers.values()) {
    debounced.cancel();
  }
  reconnectErrorDebouncers.clear();
}

// Test-only — exposes the map size so the closure-leak guard in
// setReconnectError stays regression-protected.
export function __getReconnectErrorDebouncerCountForTesting(): number {
  return reconnectErrorDebouncers.size;
}
