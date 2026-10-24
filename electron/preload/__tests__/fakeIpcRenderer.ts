import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { PreloadIpcRenderer } from "../types.js";

export class FakeIpcRenderer extends EventEmitter {
  send = vi.fn();

  asPreloadIpc(): PreloadIpcRenderer {
    return this as unknown as PreloadIpcRenderer;
  }
}
