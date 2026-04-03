import type { TerminalRegistryStoreApi, TerminalRegistrySlice } from "./types";
import { panelKindUsesTerminalUi } from "@shared/config/panelKindRegistry";
import { saveNormalized } from "./persistence";

type Set = TerminalRegistryStoreApi["setState"];

export const createBrowserActions = (
  set: Set
): Pick<
  TerminalRegistrySlice,
  | "setBrowserUrl"
  | "setBrowserHistory"
  | "setBrowserZoom"
  | "setBrowserConsoleOpen"
  | "setDevPreviewConsoleOpen"
  | "setDevServerState"
  | "setSpawnError"
  | "clearSpawnError"
  | "setReconnectError"
  | "clearReconnectError"
> => ({
  setBrowserUrl: (id, url) => {
    set((state) => {
      const terminal = state.terminalsById[id];
      if (!terminal) return state;

      const kind = terminal.kind ?? "terminal";
      if (panelKindUsesTerminalUi(kind)) return state;

      const newById = { ...state.terminalsById, [id]: { ...terminal, browserUrl: url } };
      saveNormalized(newById, state.terminalIds);
      return { terminalsById: newById };
    });
  },

  setBrowserHistory: (id, history) => {
    set((state) => {
      const terminal = state.terminalsById[id];
      if (!terminal) return state;

      const kind = terminal.kind ?? "terminal";
      if (panelKindUsesTerminalUi(kind)) return state;

      const newById = { ...state.terminalsById, [id]: { ...terminal, browserHistory: history } };
      saveNormalized(newById, state.terminalIds);
      return { terminalsById: newById };
    });
  },

  setBrowserZoom: (id, zoom) => {
    set((state) => {
      const terminal = state.terminalsById[id];
      if (!terminal) return state;

      const kind = terminal.kind ?? "terminal";
      if (panelKindUsesTerminalUi(kind)) return state;

      const newById = { ...state.terminalsById, [id]: { ...terminal, browserZoom: zoom } };
      saveNormalized(newById, state.terminalIds);
      return { terminalsById: newById };
    });
  },

  setBrowserConsoleOpen: (id, isOpen) => {
    set((state) => {
      const terminal = state.terminalsById[id];
      if (!terminal) return state;
      if (terminal.kind !== "browser") return state;
      if (terminal.browserConsoleOpen === isOpen) return state;

      const newById = { ...state.terminalsById, [id]: { ...terminal, browserConsoleOpen: isOpen } };
      saveNormalized(newById, state.terminalIds);
      return { terminalsById: newById };
    });
  },

  setDevPreviewConsoleOpen: (id, isOpen) => {
    set((state) => {
      const terminal = state.terminalsById[id];
      if (!terminal) return state;
      if (terminal.kind !== "dev-preview") return state;
      if (terminal.devPreviewConsoleOpen === isOpen) return state;

      const newById = {
        ...state.terminalsById,
        [id]: { ...terminal, devPreviewConsoleOpen: isOpen },
      };
      saveNormalized(newById, state.terminalIds);
      return { terminalsById: newById };
    });
  },

  setDevServerState: (id, status, url, error, terminalId) => {
    set((state) => {
      const terminal = state.terminalsById[id];
      if (!terminal) return state;
      if (terminal.kind !== "dev-preview") return state;

      const newById = {
        ...state.terminalsById,
        [id]: {
          ...terminal,
          devServerStatus: status,
          devServerUrl: url ?? undefined,
          devServerError: error ?? undefined,
          devServerTerminalId: terminalId ?? undefined,
        },
      };
      saveNormalized(newById, state.terminalIds);
      return { terminalsById: newById };
    });
  },

  setSpawnError: (id, error) => {
    set((state) => {
      const terminal = state.terminalsById[id];
      if (!terminal) return state;

      return {
        terminalsById: {
          ...state.terminalsById,
          [id]: { ...terminal, spawnError: error, runtimeStatus: "error" as const },
        },
      };
    });
  },

  clearSpawnError: (id) => {
    set((state) => {
      const terminal = state.terminalsById[id];
      if (!terminal) return state;

      return {
        terminalsById: {
          ...state.terminalsById,
          [id]: { ...terminal, spawnError: undefined, runtimeStatus: undefined },
        },
      };
    });
  },

  setReconnectError: (id, error) => {
    set((state) => {
      const terminal = state.terminalsById[id];
      if (!terminal) return state;

      return {
        terminalsById: {
          ...state.terminalsById,
          [id]: { ...terminal, reconnectError: error, runtimeStatus: "error" as const },
        },
      };
    });
  },

  clearReconnectError: (id) => {
    set((state) => {
      const terminal = state.terminalsById[id];
      if (!terminal) return state;

      return {
        terminalsById: {
          ...state.terminalsById,
          [id]: { ...terminal, reconnectError: undefined, runtimeStatus: undefined },
        },
      };
    });
  },
});
