import { stripAnsi } from "../../services/pty/AgentPatternDetector.js";
import { toHostSnapshot } from "../index.js";
import type { SemanticSearchMatch } from "../../../shared/types/ipc/terminal.js";
import type { HandlerMap, HostContext } from "./types.js";
import { mapTerminalInfo } from "./terminalInfo.js";

export function createTerminalQueryHandlers(ctx: HostContext): HandlerMap {
  const { ptyManager, sendEvent } = ctx;

  return {
    "get-snapshot": (msg) => {
      sendEvent({
        type: "snapshot",
        id: msg.id,
        requestId: msg.requestId,
        snapshot: toHostSnapshot(ptyManager, msg.id),
      });
    },

    "get-all-snapshots": (msg) => {
      sendEvent({
        type: "all-snapshots",
        requestId: msg.requestId,
        snapshots: ptyManager.getAllTerminalSnapshots().map((s) => ({
          id: s.id,
          lines: s.lines,
          lastInputTime: s.lastInputTime,
          lastOutputTime: s.lastOutputTime,
          lastCheckTime: s.lastCheckTime,
          launchAgentId: s.launchAgentId,
          agentState: s.agentState,
          lastStateChange: s.lastStateChange,
          spawnedAt: s.spawnedAt,
        })),
      });
    },

    "get-terminal": (msg) => {
      const terminal = ptyManager.getTerminal(msg.id);
      sendEvent({
        type: "terminal-info",
        requestId: msg.requestId,
        terminal: terminal ? mapTerminalInfo(terminal, ctx) : null,
      });
    },

    "get-available-terminals": (msg) => {
      const terminals = ptyManager.getAvailableTerminals();
      sendEvent({
        type: "available-terminals",
        requestId: msg.requestId,
        terminals: terminals.map((t) => mapTerminalInfo(t, ctx)),
      });
    },

    "get-terminals-by-state": (msg) => {
      const terminals = ptyManager.getTerminalsByState(msg.state);
      sendEvent({
        type: "terminals-by-state",
        requestId: msg.requestId,
        terminals: terminals.map((t) => mapTerminalInfo(t, ctx)),
      });
    },

    "get-all-terminals": (msg) => {
      const terminals = ptyManager.getAll();
      sendEvent({
        type: "all-terminals",
        requestId: msg.requestId,
        terminals: terminals.map((t) => mapTerminalInfo(t, ctx)),
      });
    },

    "get-terminals-for-project": (msg) => {
      sendEvent({
        type: "terminals-for-project",
        requestId: msg.requestId,
        terminalIds: ptyManager.getTerminalsForProject(msg.projectId),
      });
    },

    "get-terminal-info": (msg) => {
      const info = ptyManager.getTerminalInfo(msg.id);
      sendEvent({
        type: "terminal-diagnostic-info",
        requestId: msg.requestId,
        info,
      });
    },

    "replay-history": (msg) => {
      const replayed = ptyManager.replayHistory(msg.id, msg.maxLines);
      sendEvent({
        type: "replay-history-result",
        requestId: msg.requestId,
        replayed,
      });
    },

    // Fire-and-forget: serialization can take a while; we deliberately do not
    // await it so subsequent messages aren't blocked by the read.
    "get-serialized-state": (msg) => {
      void (async () => {
        try {
          const serializedState = await ptyManager.getSerializedStateAsync(msg.id);
          sendEvent({
            type: "serialized-state",
            requestId: msg.requestId,
            id: msg.id,
            state: serializedState,
          });
        } catch (error) {
          console.error(`[PtyHost] Failed to serialize terminal ${msg.id}:`, error);
          sendEvent({
            type: "serialized-state",
            requestId: msg.requestId,
            id: msg.id,
            state: null,
          });
        }
      })();
    },

    "console-observe": (msg) => {
      void (async () => {
        const terminal = ctx.ptyManager.getTerminal(msg.id);
        if (!terminal || terminal.launchGeneration !== msg.launchGeneration) {
          ctx.sendEvent({
            type: "console-observe-result",
            requestId: msg.requestId,
            id: msg.id,
            observerId: msg.observerId,
            launchGeneration: msg.launchGeneration,
            mode: "resync",
            reason: "generation-changed",
            throughSeq: 0,
            state: null,
            chunks: [],
          });
          return;
        }
        const started = ctx.consoleObservationHub.begin(
          msg.id,
          msg.launchGeneration,
          msg.observerId,
          msg.afterSeq
        );
        const state =
          started.mode === "snapshot" ? await ctx.ptyManager.getSerializedStateAsync(msg.id) : null;
        if (started.mode === "snapshot" && state === null) {
          ctx.consoleObservationHub.end(msg.id, msg.observerId);
          ctx.sendEvent({
            type: "console-observe-result",
            requestId: msg.requestId,
            id: msg.id,
            observerId: msg.observerId,
            launchGeneration: msg.launchGeneration,
            mode: "resync",
            reason: "generation-changed",
            throughSeq: started.throughSeq,
            state: null,
            chunks: [],
          });
          return;
        }
        ctx.sendEvent({
          type: "console-observe-result",
          requestId: msg.requestId,
          id: msg.id,
          observerId: msg.observerId,
          launchGeneration: msg.launchGeneration,
          mode: started.mode,
          ...(started.mode === "resync" ? { reason: started.reason } : {}),
          throughSeq: started.throughSeq,
          state,
          chunks: started.chunks,
        });
      })();
    },

    "console-unobserve": (msg) => {
      ctx.consoleObservationHub.end(msg.id, msg.observerId);
    },

    "search-semantic-buffers": (msg) => {
      const matches: SemanticSearchMatch[] = [];
      let regex: RegExp | null = null;
      if (msg.isRegex) {
        try {
          regex = new RegExp(msg.query, "i");
        } catch {
          sendEvent({
            type: "semantic-search-result",
            requestId: msg.requestId,
            matches: [],
            error: "invalid-regex",
          });
          return;
        }
      }
      const needle = msg.isRegex ? null : msg.query.toLowerCase();
      for (const t of ptyManager.getAll()) {
        const buffer = t.semanticBuffer;
        if (!buffer || buffer.length === 0) continue;
        for (let i = buffer.length - 1; i >= 0; i--) {
          const cleaned = stripAnsi(buffer[i] ?? "").trim();
          if (!cleaned) continue;
          let start = -1;
          let end = -1;
          if (regex) {
            const m = regex.exec(cleaned);
            if (m && m[0].length > 0) {
              start = m.index;
              end = m.index + m[0].length;
            }
          } else if (needle !== null && needle.length > 0) {
            const idx = cleaned.toLowerCase().indexOf(needle);
            if (idx !== -1) {
              start = idx;
              end = idx + needle.length;
            }
          }
          if (start !== -1 && end !== -1) {
            matches.push({
              terminalId: t.id,
              line: cleaned,
              matchStart: start,
              matchEnd: end,
            });
            break;
          }
        }
      }
      sendEvent({
        type: "semantic-search-result",
        requestId: msg.requestId,
        matches,
      });
    },
  };
}
