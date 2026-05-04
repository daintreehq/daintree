import type { BroadcastWriteTargetResult } from "../../../shared/types/pty-host.js";
import type { HandlerMap, HostContext } from "./types.js";

export function createTerminalIOHandlers(ctx: HostContext): HandlerMap {
  const { ptyManager, sendEvent } = ctx;

  return {
    write: (msg) => {
      ptyManager.write(msg.id, msg.data, msg.traceId);
    },

    submit: (msg) => {
      ptyManager.submit(msg.id, msg.text);
    },

    resize: (msg) => {
      ptyManager.resize(msg.id, msg.cols, msg.rows);
    },

    "broadcast-write": (msg) => {
      // Fleet broadcast: fan one data payload to every armed PTY in a
      // tight loop inside the pty-host event loop. Avoids N per-keystroke
      // MessagePort/IPC hops from the renderer when a fleet types.
      //
      // Each target write goes through `ptyManager.tryWrite()` rather than
      // `ptyManager.write()` because the regular write path swallows
      // dead-pipe errors via `logWriteError` and returns void. The throwing
      // variant returns `{ ok, error? }` per call so a dead target produces
      // an actionable result the renderer can use to auto-disarm the pane.
      const ids: string[] = Array.isArray(msg.ids) ? msg.ids : [];
      const data: string = typeof msg.data === "string" ? msg.data : "";
      if (!data) return;
      const results: BroadcastWriteTargetResult[] = [];
      for (const id of ids) {
        if (typeof id !== "string" || !id) continue;
        const terminal = ptyManager.getTerminal(id);
        if (!terminal || terminal.wasKilled || terminal.isExited) {
          results.push({
            id,
            ok: false,
            error: { code: "EBADF", message: "terminal not available" },
          });
          continue;
        }
        const outcome = ptyManager.tryWrite(id, data);
        if (outcome.ok) {
          results.push({ id, ok: true });
        } else {
          const err = outcome.error;
          const code = typeof err?.code === "string" ? err.code : undefined;
          const message = err?.message ?? "unknown write error";
          console.error(
            `[PtyHost] broadcast-write failed for ${id}${code ? ` (${code})` : ""}: ${message}`
          );
          results.push({ id, ok: false, error: { code, message } });
        }
      }
      if (results.length > 0) {
        sendEvent({ type: "broadcast-write-result", results });
      }
    },

    "batch-double-escape": (msg) => {
      // Fan out an ESC, 50ms per-PTY gap, then a second ESC. Scheduling the
      // gap inside the utility-process event loop is load-bearing — doing
      // it in the renderer or Main process lets IPC batching collapse the
      // two writes into a single Meta-Escape on the receiving terminal.
      const ESC = "\u001b";
      const INTER_ESC_DELAY_MS = 50;
      const ids: string[] = Array.isArray(msg.ids) ? msg.ids : [];
      for (const id of ids) {
        if (typeof id !== "string" || !id) continue;
        const terminal = ptyManager.getTerminal(id);
        if (!terminal || terminal.wasKilled || terminal.isExited) continue;
        ptyManager.write(id, ESC);
        setTimeout(() => {
          const t = ptyManager.getTerminal(id);
          if (!t || t.wasKilled || t.isExited) return;
          ptyManager.write(id, ESC);
        }, INTER_ESC_DELAY_MS);
      }
    },
  };
}
