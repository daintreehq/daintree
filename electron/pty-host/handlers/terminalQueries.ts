import { stripAnsi } from "../../services/pty/AgentPatternDetector.js";
import { toHostSnapshot } from "../index.js";
import type { SemanticSearchMatch } from "../../../shared/types/ipc/terminal.js";
import type { HandlerMap, HostContext } from "./types.js";
import type { PtyHostTerminalStatusFields } from "../../../shared/types/pty-host.js";
import { mapTerminalInfo, mapTerminalStatusFields } from "./terminalInfo.js";
import { findCaseInsensitiveLiteral } from "./caseInsensitiveLiteralMatch.js";

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
        // `submissionToken` rides this query rather than getting a message
        // family of its own (#12337): the viewless status read already issues
        // one `get-terminal` per id, so correlating a submission costs it no
        // extra round trip. Only this query passes it — the bulk families keep
        // the unconditional projection.
        terminal: terminal ? mapTerminalInfo(terminal, ctx, msg.submissionToken) : null,
      });
    },

    "get-terminal-status-fields": (msg) => {
      // A malformed list reads nothing rather than throwing the whole query away.
      const ids: unknown[] = Array.isArray(msg.ids) ? msg.ids : [];
      const token = typeof msg.submissionToken === "string" ? msg.submissionToken : undefined;
      const seen = new Set<string>();
      const terminals: PtyHostTerminalStatusFields[] = [];
      for (const id of ids) {
        if (typeof id !== "string" || seen.has(id)) continue;
        seen.add(id);
        const terminal = ptyManager.getTerminal(id);
        if (terminal) terminals.push(mapTerminalStatusFields(terminal, ctx, token));
      }
      sendEvent({ type: "terminal-status-fields", requestId: msg.requestId, terminals });
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

    // Restore's whole inventory in one reply (#17776), in the registry's id
    // order. An id whose record is gone by the time it is read is skipped,
    // the same answer a per-id `get-terminal` would have given it.
    "get-project-terminals": (msg) => {
      sendEvent({
        type: "project-terminals",
        requestId: msg.requestId,
        terminals: ptyManager
          .getTerminalsForProject(msg.projectId)
          .map((id) => ptyManager.getTerminal(id))
          .filter((terminal) => terminal !== undefined)
          .map((terminal) => mapTerminalInfo(terminal, ctx)),
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

    "reset-terminal-modes": (msg) => {
      sendEvent({
        type: "reset-terminal-modes-result",
        requestId: msg.requestId,
        reset: ptyManager.resetTerminalModes(msg.id),
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
      // The snapshot covers everything skipped for this terminal's cached
      // views so far, so a skip from here on has to be reported afresh.
      ctx.ipcQueueManager.clearHiddenSkip(msg.id);
      void (async () => {
        try {
          const serializedState = await ptyManager.getSerializedStateAsync(
            msg.id,
            msg.tailRows !== undefined ? { tailRows: msg.tailRows } : undefined
          );
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
      // Only an omitted scope scans the whole shard; a malformed one scans nothing.
      const terminals =
        msg.terminalIds === undefined
          ? ptyManager.getAll()
          : Array.isArray(msg.terminalIds)
            ? msg.terminalIds.map((id: unknown) =>
                typeof id === "string" ? ptyManager.getTerminal(id) : undefined
              )
            : [];
      for (const t of terminals) {
        if (!t) continue;
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
          } else {
            const range = findCaseInsensitiveLiteral(cleaned, msg.query);
            if (range) {
              start = range.start;
              end = range.end;
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
