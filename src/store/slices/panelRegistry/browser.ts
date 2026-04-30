import type { PanelRegistryStoreApi, PanelRegistrySlice } from "./types";
import { panelKindUsesTerminalUi } from "@shared/config/panelKindRegistry";
import { saveNormalized } from "./persistence";

type Set = PanelRegistryStoreApi["setState"];

export const createBrowserActions = (
  set: Set
): Pick<
  PanelRegistrySlice,
  | "setBrowserUrl"
  | "setBrowserHistory"
  | "setBrowserZoom"
  | "setBrowserConsoleOpen"
  | "setDevPreviewConsoleOpen"
  | "setViewportPreset"
  | "setDevPreviewScrollPosition"
  | "setDevServerState"
  | "setSpawnError"
  | "clearSpawnError"
  | "setReconnectError"
  | "clearReconnectError"
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
    set((state) => {
      const terminal = state.panelsById[id];
      if (!terminal) return state;

      return {
        panelsById: {
          ...state.panelsById,
          [id]: { ...terminal, reconnectError: error, runtimeStatus: "error" as const },
        },
      };
    });
  },

  clearReconnectError: (id) => {
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
});
