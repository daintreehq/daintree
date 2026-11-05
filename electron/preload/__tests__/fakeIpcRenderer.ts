import { EventEmitter } from "node:events";
import { vi, type Mock } from "vitest";
import type { PreloadIpcRenderer } from "../types.js";

export class FakeIpcRenderer extends EventEmitter {
  send: Mock = vi.fn();

  asPreloadIpc(): PreloadIpcRenderer {
    return this as unknown as PreloadIpcRenderer;
  }
}
