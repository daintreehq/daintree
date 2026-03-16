import type { TerminalRegistryStoreApi, TerminalRegistrySlice } from "./types";
import { panelKindUsesTerminalUi } from "@shared/config/panelKindRegistry";
import { saveTerminals } from "./persistence";

type Set = TerminalRegistryStoreApi["setState"];
type Get = TerminalRegistryStoreApi["getState"];

export const createBrowserActions = (
  set: Set,
  get: Get
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
      const terminal = state.terminals.find((t) => t.id === id);
      if (!terminal) return state;

      const kind = terminal.kind ?? "terminal";
      if (panelKindUsesTerminalUi(kind)) return state;

      const newTerminals = state.terminals.map((t) =>
        t.id === id ? { ...t, browserUrl: url } : t
      );

      saveTerminals(newTerminals);
      return { terminals: newTerminals };
    });
  },

  setBrowserHistory: (id, history) => {
    set((state) => {
      const terminal = state.terminals.find((t) => t.id === id);
      if (!terminal) return state;

      const kind = terminal.kind ?? "terminal";
      if (panelKindUsesTerminalUi(kind)) return state;

      const newTerminals = state.terminals.map((t) =>
        t.id === id ? { ...t, browserHistory: history } : t
      );

      saveTerminals(newTerminals);
      return { terminals: newTerminals };
    });
  },

  setBrowserZoom: (id, zoom) => {
    set((state) => {
      const terminal = state.terminals.find((t) => t.id === id);
      if (!terminal) return state;

      const kind = terminal.kind ?? "terminal";
      if (panelKindUsesTerminalUi(kind)) return state;

      const newTerminals = state.terminals.map((t) =>
        t.id === id ? { ...t, browserZoom: zoom } : t
      );

      saveTerminals(newTerminals);
      return { terminals: newTerminals };
    });
  },

  setBrowserConsoleOpen: (id, isOpen) => {
    set((state) => {
      const terminal = state.terminals.find((t) => t.id === id);
      if (!terminal) return state;
      if (terminal.kind !== "browser") return state;
      if (terminal.browserConsoleOpen === isOpen) return state;

      const newTerminals = state.terminals.map((t) =>
        t.id === id ? { ...t, browserConsoleOpen: isOpen } : t
      );

      saveTerminals(newTerminals);
      return { terminals: newTerminals };
    });
  },

  setDevPreviewConsoleOpen: (id, isOpen) => {
    set((state) => {
      const terminal = state.terminals.find((t) => t.id === id);
      if (!terminal) return state;
      if (terminal.kind !== "dev-preview") return state;
      if (terminal.devPreviewConsoleOpen === isOpen) return state;

      const newTerminals = state.terminals.map((t) =>
        t.id === id ? { ...t, devPreviewConsoleOpen: isOpen } : t
      );

      saveTerminals(newTerminals);
      return { terminals: newTerminals };
    });
  },

  setDevServerState: (id, status, url, error, terminalId) => {
    set((state) => {
      const terminal = state.terminals.find((t) => t.id === id);
      if (!terminal) return state;
      if (terminal.kind !== "dev-preview") return state;

      const newTerminals = state.terminals.map((t) =>
        t.id === id
          ? {
              ...t,
              devServerStatus: status,
              devServerUrl: url ?? undefined,
              devServerError: error ?? undefined,
              devServerTerminalId: terminalId ?? undefined,
            }
          : t
      );

      saveTerminals(newTerminals);
      return { terminals: newTerminals };
    });
  },

  setSpawnError: (id, error) => {
    set((state) => {
      const terminal = state.terminals.find((t) => t.id === id);
      if (!terminal) return state;

      const newTerminals = state.terminals.map((t) =>
        t.id === id ? { ...t, spawnError: error, runtimeStatus: "error" as const } : t
      );

      return { terminals: newTerminals };
    });
  },

  clearSpawnError: (id) => {
    set((state) => {
      const terminal = state.terminals.find((t) => t.id === id);
      if (!terminal) return state;

      const newTerminals = state.terminals.map((t) =>
        t.id === id ? { ...t, spawnError: undefined, runtimeStatus: undefined } : t
      );

      return { terminals: newTerminals };
    });
  },

  setReconnectError: (id, error) => {
    set((state) => {
      const terminal = state.terminals.find((t) => t.id === id);
      if (!terminal) return state;

      const newTerminals = state.terminals.map((t) =>
        t.id === id ? { ...t, reconnectError: error, runtimeStatus: "error" as const } : t
      );

      return { terminals: newTerminals };
    });
  },

  clearReconnectError: (id) => {
    set((state) => {
      const terminal = state.terminals.find((t) => t.id === id);
      if (!terminal) return state;

      const newTerminals = state.terminals.map((t) =>
        t.id === id ? { ...t, reconnectError: undefined, runtimeStatus: undefined } : t
      );

      return { terminals: newTerminals };
    });
  },
});
