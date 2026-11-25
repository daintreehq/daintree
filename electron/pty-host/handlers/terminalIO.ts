import type {
  BroadcastWriteTargetResult,
  ExactPromptGuard,
} from "../../../shared/types/pty-host.js";
import type {
  CodexLimitContinueResult,
  CodexLimitStopRef,
} from "../../../shared/types/codexLimitContinuation.js";
import type { HandlerMap, HostContext } from "./types.js";

/**
 * No run has a negative incarnation: a guard pinned to one refuses its line,
 * which is what a malformed exact guard must do rather than admit on weaker
 * terms.
 */
const REFUSING_GUARD: ExactPromptGuard = { kind: "settled-prompt-exact", agentIncarnation: -1 };

/** How long after a PTY's reads resume before its screen counts as caught up (#17909). */
const READS_RESUME_SETTLE_MS = 2_000;

/** The stop main named (#17909), or null for one with a field missing or malformed. */
function codexLimitStopOf(value: unknown): CodexLimitStopRef | null {
  if (typeof value !== "object" || value === null) return null;
  const { run, seq } = value as Partial<Record<keyof CodexLimitStopRef, unknown>>;
  if (typeof run !== "string" || run.length === 0 || !Number.isInteger(seq)) return null;
  return { run, seq: seq as number };
}

/** Whose an input is, as main named it (#16094): a non-empty string or nobody's. */
function inputOwnerOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * An exact guard as main sent it, with only the fields it may carry. Any other
 * object, or a field that is present but malformed, refuses the line.
 */
function exactPromptGuardOf(value: unknown): ExactPromptGuard | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const guard = value as Partial<Record<keyof ExactPromptGuard, unknown>>;
  if (guard.kind !== "settled-prompt-exact") return REFUSING_GUARD;
  const {
    agentIncarnation,
    agentSessionId,
    agentId,
    acceptWorking,
    acceptQuestion,
    updateObservedAt,
  } = guard;
  if (agentIncarnation !== undefined && !Number.isInteger(agentIncarnation)) return REFUSING_GUARD;
  if (agentSessionId !== undefined && typeof agentSessionId !== "string") return REFUSING_GUARD;
  if (agentId !== undefined && (typeof agentId !== "string" || agentId.length === 0)) {
    return REFUSING_GUARD;
  }
  if (acceptWorking !== undefined && acceptWorking !== true) return REFUSING_GUARD;
  if (acceptQuestion !== undefined && acceptQuestion !== true) return REFUSING_GUARD;
  if (
    updateObservedAt !== undefined &&
    (typeof updateObservedAt !== "number" || !Number.isFinite(updateObservedAt))
  ) {
    return REFUSING_GUARD;
  }
  return {
    kind: "settled-prompt-exact",
    ...(agentIncarnation !== undefined ? { agentIncarnation: agentIncarnation as number } : {}),
    ...(agentSessionId !== undefined ? { agentSessionId } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(acceptWorking === true ? { acceptWorking: true } : {}),
    ...(acceptQuestion === true ? { acceptQuestion: true } : {}),
    ...(updateObservedAt !== undefined ? { updateObservedAt: updateObservedAt as number } : {}),
  };
}

export function createTerminalIOHandlers(ctx: HostContext): HandlerMap {
  const { ptyManager, sendEvent } = ctx;
  // Targets whose last broadcast write failed transiently. Their next success
  // is always reported, so the chip clears even when that keystroke left the
  // renderer before the failure reached it and so did not ask for successes.
  const failedTargets = new Set<string>();

  return {
    write: (msg) => {
      ptyManager.write(msg.id, msg.data, msg.traceId, inputOwnerOf(msg.inputOwner));
    },

    submit: (msg) => {
      // Only the known guards cross; anything else is dropped rather than
      // trusted to mean "no check".
      const guard =
        msg.guard === "settled-prompt" ||
        msg.guard === "settled-prompt-strict" ||
        msg.guard === "no-choice-dialog"
          ? msg.guard
          : exactPromptGuardOf(msg.guard);
      const imagePaths = Array.isArray(msg.imagePaths)
        ? msg.imagePaths.filter((path: unknown): path is string => typeof path === "string")
        : undefined;
      const firstPrompt =
        typeof msg.firstPrompt?.text === "string"
          ? {
              text: msg.firstPrompt.text,
              ...(msg.firstPrompt.truncated === true && { truncated: true as const }),
            }
          : undefined;
      ptyManager.submit(
        msg.id,
        msg.text,
        msg.submissionToken,
        msg.handbackCode,
        guard,
        imagePaths,
        firstPrompt,
        msg.handbackCode !== undefined && msg.handbackInstruction === "run" ? "run" : undefined,
        inputOwnerOf(msg.promptOwner)
      );
    },

    stage: (msg) => {
      ptyManager.stage(msg.id, msg.text);
    },

    "cancel-pending-input": (msg) => {
      ptyManager.cancelPendingInput(msg.id);
    },

    "set-codex-limit-continue": (msg) => {
      const restoreIdentity =
        typeof msg.restoreIdentity === "string" || msg.restoreIdentity === null
          ? msg.restoreIdentity
          : undefined;
      ptyManager.setCodexLimitContinueArmed(msg.id, msg.armed === true, restoreIdentity);
    },

    // Answered once the line is typed or refused: the lane may hold it a while.
    "continue-codex-limit": (msg) => {
      const stop = codexLimitStopOf(msg.stop);
      const send = (result: CodexLimitContinueResult) =>
        sendEvent({ type: "continue-codex-limit-result", requestId: msg.requestId, result });
      if (stop === null) {
        send({ status: "skipped", reason: "process-changed" });
        return;
      }
      // Bytes the PTY holds unread may already say the pane moved on: asked
      // at every check up to the write, as reads pause and resume meanwhile.
      const readsPaused = () => {
        const pause = ctx.getPauseCoordinator(msg.id);
        if (!pause) return null;
        const resumedAt = pause.readsResumedAt;
        const settling = resumedAt !== null && Date.now() - resumedAt < READS_RESUME_SETTLE_MS;
        return pause.isReadPaused || settling ? ("reads-paused" as const) : null;
      };
      void ptyManager
        .continueAtCodexLimit(msg.id, stop, readsPaused)
        .then(send, () => send({ status: "skipped", reason: "not-delivered" }));
    },

    "withdraw-submission": (msg) => {
      if (typeof msg.submissionToken !== "string") return;
      ptyManager.withdrawGuardedSubmission(msg.id, msg.submissionToken);
    },

    resize: (msg) => {
      ptyManager.resize(msg.id, msg.cols, msg.rows, "main-ipc");
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
      //
      // An all-ok write sends nothing unless the renderer asked for successes
      // (it has a failed chip to clear) — otherwise every keystroke into an
      // armed fleet would round-trip N results that nothing acts on.
      const ids: string[] = Array.isArray(msg.ids) ? msg.ids : [];
      const data: string = typeof msg.data === "string" ? msg.data : "";
      if (!data) return;
      const reportSuccess = msg.reportSuccess === true;
      if (failedTargets.size > 0) {
        for (const id of failedTargets) {
          if (!ptyManager.getTerminal(id)) failedTargets.delete(id);
        }
      }
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
          if (failedTargets.delete(id) || reportSuccess) results.push({ id, ok: true });
        } else {
          failedTargets.add(id);
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
      const inputOwner = inputOwnerOf(msg.inputOwner);
      for (const id of ids) {
        if (typeof id !== "string" || !id) continue;
        const terminal = ptyManager.getTerminal(id);
        if (!terminal || terminal.wasKilled || terminal.isExited) continue;
        ptyManager.write(id, ESC, undefined, inputOwner);
        setTimeout(() => {
          const t = ptyManager.getTerminal(id);
          // The same spawn the first went to: a restart under this id in the
          // gap is a new run that asked for no Escape.
          if (!t || t.spawnedAt !== terminal.spawnedAt || t.wasKilled || t.isExited) return;
          ptyManager.write(id, ESC, undefined, inputOwner);
        }, INTER_ESC_DELAY_MS);
      }
    },
  };
}
