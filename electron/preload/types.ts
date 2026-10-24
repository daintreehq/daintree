import type { IpcRenderer } from "electron";

/** The slice of `ipcRenderer` the preload transports use, injected so tests can drive them. */
export type PreloadIpcRenderer = Pick<IpcRenderer, "on" | "removeListener" | "send">;
