import { Terminal } from "@xterm/xterm";
import { terminalClient } from "@/clients";
import { TerminalRefreshTier } from "@/types";
import { RefreshTierProvider, ThrottledWriter } from "./types";

export type SabModeChecker = () => boolean;

/**
 * Creates a simple writer that passes data directly to xterm.
 *
 * VS Code's approach: All batching is done at the PTY host level (OutputThrottler
 * with 4ms delay for focused terminals). The renderer just writes directly to xterm.
 * This avoids complex heuristics that can add latency to keystroke echoes.
 */
export function createThrottledWriter(
  id: string,
  terminal: Terminal,
  _initialProvider: RefreshTierProvider = () => TerminalRefreshTier.FOCUSED,
  isSabModeEnabled: SabModeChecker = () => false
): ThrottledWriter {
  let pendingWrites = 0;
  return {
    get pendingWrites() {
      return pendingWrites;
    },
    write: (data: string | Uint8Array) => {
      // Direct write to xterm - all batching happens in the backend OutputThrottler
      pendingWrites++;
      // Capture SAB mode decision before write to avoid mode-flip ambiguity during callback
      const shouldAck = !isSabModeEnabled();
      terminal.write(data, () => {
        pendingWrites--;
        // Flow Control: Only send acknowledgements in IPC fallback mode.
        // In SAB mode, flow control is handled globally via SAB backpressure,
        // and the backend ignores per-terminal acks anyway.
        if (shouldAck) {
          terminalClient.acknowledgeData(id, data.length);
        }
      });
    },
    dispose: () => {
      // Nothing to clean up - we don't buffer
    },
    updateProvider: (_provider: RefreshTierProvider) => {
      // No-op - we don't use tiers for batching anymore
    },
    notifyInput: () => {
      // No-op - keystroke timing not needed without renderer-side batching
    },
    getDebugInfo: () => {
      return {
        tierName: "DIRECT",
        fps: 0,
        isBurstMode: false,
        effectiveDelay: 0,
        bufferSize: 0,
        pendingWrites,
      };
    },
    boost: () => {
      // No-op - we don't buffer
    },
    clear: () => {
      // No-op - we don't buffer
      pendingWrites = 0;
    },
  };
}
