import { CHANNELS } from "../ipc/channels.js";
import type { PreloadIpcRenderer } from "./types.js";

type TerminalDataSubscriber = (data: string | Uint8Array, streamEnd?: number) => void;

// Multiplexer for the shared terminal:data channel, mirroring _eventBusOn:
// one ipcRenderer listener dispatching by terminal id, instead of one
// filtering listener per terminal (O(N) handler invocations per chunk and a
// MaxListenersExceededWarning at 10+ terminals).
export function createTerminalDataMultiplexer(ipcRenderer: PreloadIpcRenderer): {
  on: (id: string, callback: TerminalDataSubscriber) => () => void;
} {
  const _terminalDataSubscribers = new Map<string, Set<TerminalDataSubscriber>>();
  let _terminalDataWired = false;

  function _ensureTerminalDataWired(): void {
    if (_terminalDataWired) return;
    _terminalDataWired = true;
    ipcRenderer.on(
      CHANNELS.TERMINAL_DATA,
      (_event, terminalId: unknown, data: unknown, streamEnd: unknown) => {
        if (typeof terminalId !== "string") return;
        const subs = _terminalDataSubscribers.get(terminalId);
        if (!subs || subs.size === 0) return;
        // Accept string, Uint8Array, or Buffer (Node.js extends Uint8Array)
        if (typeof data === "string" || data instanceof Uint8Array || Buffer.isBuffer(data)) {
          const end = typeof streamEnd === "number" ? streamEnd : undefined;
          // Iterate the live Set directly — unlike the events:push dispatcher
          // (eventBus.ts), terminal data subscribers don't unsubscribe during dispatch,
          // and this path runs per chunk, so the snapshot allocation matters.
          for (const cb of subs) {
            cb(data, end);
          }
        }
      }
    );
  }

  function _terminalDataOn(id: string, callback: TerminalDataSubscriber): () => void {
    _ensureTerminalDataWired();
    let subs = _terminalDataSubscribers.get(id);
    if (!subs) {
      subs = new Set();
      _terminalDataSubscribers.set(id, subs);
    }
    // Fresh wrapper per subscription so the same callback can subscribe twice
    // and each cleanup removes only its own subscription.
    const wrapped: TerminalDataSubscriber = (data) => callback(data);
    subs.add(wrapped);
    return () => {
      const current = _terminalDataSubscribers.get(id);
      if (!current) return;
      current.delete(wrapped);
      if (current.size === 0) _terminalDataSubscribers.delete(id);
    };
  }

  return { on: _terminalDataOn };
}
