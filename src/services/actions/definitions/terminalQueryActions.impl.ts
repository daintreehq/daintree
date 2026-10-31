// The terminal query actions' run bodies, loaded on first dispatch by
// `runTerminalQueryAction` in terminalQueryActions.ts, which keeps the metadata
// every view registers at boot (#14273). Nothing here may import
// terminalQueryActions.ts at runtime.
import type { ActionContext } from "@shared/types/actions";
import { readTailSnapshot, tailCapturedOutput } from "@shared/utils/artifactParser";
import {
  boundTerminalStatusOutput,
  fitTerminalOutputResult,
} from "@shared/utils/terminalOutputBudget";
import { MCP_RESPONSE_TEXT_MAX_BYTES } from "@shared/config/mcpLimits";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { terminalClient } from "@/clients";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import type {
  TerminalOutputActivityLookup,
  TerminalStatusEntry,
  TerminalStatusUnavailableField,
} from "@shared/types/terminalStatus";
import type { TerminalSubmissionLookup } from "@shared/types/terminalSubmission";
import type { SerializedTerminalSnapshot } from "@shared/types/terminal";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import {
  countPanelsTowardLimit,
  isEphemeralPanel,
  isClientMetadataEligible,
} from "@/store/slices/panelRegistry/panelCount";
import { buildPanelLimitSnapshot, usePanelLimitStore } from "@/store/panelLimitStore";
import { readClientMetadata } from "@shared/utils/mcpClientMetadata";
import { restoredField } from "@shared/utils/restoreProvenance";
import { appendHandbackInstruction, mintHandbackCode } from "@shared/utils/handback";
import { buildTerminalSendCommandReceipt } from "@shared/utils/terminalSendCommandResult";
import { isAgentTerminal } from "@/utils/terminalType";
import { UnactionableTargetError } from "@/services/actions/unactionableTarget";
import {
  matchesTerminalLocationFilter,
  type TerminalLocationFilter,
} from "@shared/utils/terminalLocationFilter";

export const terminalQueryActionRuns = {
  "terminal.list": async (args: unknown) => {
    const { worktreeId, location, owned, terminalId, includeClientMetadata } = (args ?? {}) as {
      worktreeId?: string;
      location?: TerminalLocationFilter;
      owned?: boolean;
      terminalId?: string;
      includeClientMetadata?: boolean;
    };
    // `owned` is answered in main and never here (#12308): ownership is
    // keyed by the MCP session id, which the renderer deliberately never
    // sees. Main consumes the flag, so a value reaching `run()` came from a
    // dispatch path with no ownership authority — and answering it with the
    // unfiltered list would report every panel as this caller's own.
    //
    // `false` is refused too. The renderer cannot honour the argument in
    // either direction, and refusing both is what makes a broken strip in
    // main fail loudly instead of quietly returning the wrong set.
    if (owned !== undefined) {
      throw new Error(
        "terminal.list `owned` filters on the MCP session that created each terminal, which only the Daintree host can resolve. A direct dispatch cannot answer it — call the tool over MCP, or omit the argument."
      );
    }
    const state = usePanelStore.getState();
    // Ephemeral panels (e.g. the Daintree Assistant's own dock terminal)
    // are tooling-internal and must not appear in the MCP-visible list,
    // or the assistant ends up enumerating itself and acting on its own
    // process during bulk operations.
    let terminals = state.panelIds
      .map((id) => state.panelsById[id])
      .filter((t): t is PanelInstance => t !== undefined && !isEphemeralPanel(t));

    // Filter by worktree if specified
    if (worktreeId) {
      terminals = terminals.filter((t) => t.worktreeId === worktreeId);
    }

    // A narrowing filter, not a lookup: an id nothing matches yields an empty
    // listing, the same answer every other filter here gives.
    if (terminalId) {
      terminals = terminals.filter((t) => t.id === terminalId);
    }

    terminals = terminals.filter((t) => matchesTerminalLocationFilter(t.location, location));

    // Return essential metadata only (avoid returning full PTY buffers)
    const result = terminals.map((t) => ({
      id: t.id,
      kind: t.kind,
      type: undefined,
      worktreeId: t.worktreeId ?? null,
      title: t.title ?? null,
      location: t.location ?? "grid",
      agentId: isPtyPanel(t) ? (t.detectedAgentId ?? t.launchAgentId ?? null) : null,
      agentState: isPtyPanel(t) ? (t.agentState ?? null) : null,
      isInputLocked: isPtyPanel(t) ? (t.isInputLocked ?? false) : false,
      isFocused: t.id === state.focusedId,
      // ONLY the reserved key, and only off a panel the writer could have
      // written to. Two separate leaks live here. `extensionState` also
      // carries `presetEnv` on a terminal — a real subprocess environment,
      // session-scoped secrets included. And a plugin owns its whole bag
      // under keys it chooses, so one that happens to persist its own `mcp`
      // key would have it read out here despite no external caller being
      // able to write it. Gating the read on the same predicate as the write
      // is what keeps the two halves describing the same thing.
      ...(includeClientMetadata
        ? {
            clientMetadata: isClientMetadataEligible(t)
              ? readClientMetadata(t.extensionState)
              : null,
          }
        : {}),
      ...(isPtyPanel(t) ? restoredField(t) : {}),
    }));

    const { softWarningLimit, confirmationLimit, hardLimit } = usePanelLimitStore.getState();
    const panelLimit = buildPanelLimitSnapshot(
      countPanelsTowardLimit(state.panelsById, state.panelIds),
      { softWarningLimit, confirmationLimit, hardLimit }
    );

    return { terminals: result, panelLimit };
  },
  "terminal.getOutput": async (args: unknown) => {
    const {
      terminalId,
      maxLines = 100,
      stripAnsi = true,
    } = args as {
      terminalId: string;
      maxLines?: number;
      stripAnsi?: boolean;
    };

    // Validate maxLines bounds
    const effectiveMaxLines = Math.min(Math.max(maxLines, 1), 1000);

    // Get serialized terminal state via existing IPC method
    // Raw output keeps the whole-buffer read: the serializer's erase escapes
    // depend on the range it starts from, so a capped read is not byte-identical.
    const serializedState = stripAnsi
      ? await readTailSnapshot(
          (options) => window.electron.terminal.getSerializedState(terminalId, options),
          effectiveMaxLines
        )
      : await window.electron.terminal.getSerializedState(terminalId);

    if (serializedState === null) {
      return {
        terminalId,
        content: null,
        lineCount: 0,
        truncated: false,
        error: "Terminal not found or has no output",
      };
    }

    // Collapse blank padding BEFORE tailing so the last N lines are real
    // content, not the blank region bottom-padding TUIs (e.g. Codex) leave
    // below their composer (#10763). truncated/lineCount track normalized
    // content, so trailing padding never reads as "output omitted".
    const { content, lineCount, truncated } = tailCapturedOutput(
      serializedState.data,
      effectiveMaxLines,
      stripAnsi
    );

    // Fit under the response cap here, keeping the newest lines (#12450).
    // Left to the transport, an oversized tail is cut from the end — the
    // newest lines — into JSON that will not parse, and reported as an error.
    return fitTerminalOutputResult(
      { terminalId, content, lineCount, truncated },
      MCP_RESPONSE_TEXT_MAX_BYTES
    );
  },
  "terminal.getStatus": async (args: unknown, ctx?: ActionContext) => {
    const {
      terminalIds,
      worktreeId,
      location,
      includeOutput: includeOutputArg,
      submissionToken,
    } = (args ?? {}) as {
      terminalIds?: string[];
      worktreeId?: string;
      location?: TerminalLocationFilter;
      includeOutput?: boolean | { lines?: number; stripAnsi?: boolean };
      submissionToken?: string;
    };
    const includeOutput =
      includeOutputArg === true ? {} : includeOutputArg === false ? undefined : includeOutputArg;
    // Status stays open to plugins; the output half does not. Terminal text
    // is behind `terminal:read` and its consent prompt (#13155), so a plugin
    // reads it through `host.terminals.readScreen` instead.
    if (includeOutput && ctx?.dispatchSource === "plugin") {
      throw new Error(
        "terminal.getStatus `includeOutput` is not available to plugin dispatch; use host.terminals.readScreen with the terminal:read capability."
      );
    }
    if (submissionToken !== undefined && terminalIds === undefined) {
      throw new Error("terminal.getStatus requires `terminalIds` when `submissionToken` is set.");
    }

    const state = usePanelStore.getState();
    const panelsById = state.panelsById;
    // Fresh point-in-time snapshot of the fleet arming set for this call.
    const armedIds = useFleetArmingStore.getState().armedIds;

    const resolved: Array<{ id: string; terminal: PanelInstance | undefined }> = [];

    // An explicitly passed `terminalIds` (even empty) selects the targeted
    // path — never silently fall back to the fleet path, which would surprise
    // a caller asking for a specific subset.
    if (terminalIds !== undefined) {
      for (const id of terminalIds) {
        const t = getNarrowPanel(panelsById, id);
        // Treat tooling-internal panels as not found — they must never expose
        // state to MCP callers (mirrors terminal.list).
        if (!t || isEphemeralPanel(t)) {
          resolved.push({ id, terminal: undefined });
        } else {
          resolved.push({ id, terminal: t });
        }
      }
    } else {
      let terminals = state.panelIds
        .map((id) => panelsById[id])
        .filter((t): t is PanelInstance => t !== undefined && !isEphemeralPanel(t));

      if (worktreeId) {
        terminals = terminals.filter((t) => t.worktreeId === worktreeId);
      }
      terminals = terminals.filter((t) => matchesTerminalLocationFilter(t.location, location));

      for (const t of terminals) {
        resolved.push({ id: t.id, terminal: t });
      }
    }

    // Optional output fetch — single batched IPC for all terminals at once.
    const linesArg = includeOutput?.lines;
    const effectiveLines =
      typeof linesArg === "number" ? Math.min(Math.max(Math.floor(linesArg), 1), 50) : 20;
    const stripAnsi = includeOutput?.stripAnsi ?? true;

    let outputs: Record<string, SerializedTerminalSnapshot | null> | null = null;
    let outputError: string | undefined;
    // `lastOutputChangeAt` lives on the pty-host's viewport tracker, so it is
    // read only when output was asked for (#12495): that call already pays
    // for a batched hop, and the default poll still issues none.
    let activity: Record<string, TerminalOutputActivityLookup> | null = null;
    let activityError: string | undefined;
    if (includeOutput) {
      const idsToFetch = resolved.filter((r) => r.terminal !== undefined).map((r) => r.id);
      // Only a PTY panel has a tracker to read.
      const activityIds = resolved
        .filter((r) => r.terminal !== undefined && isPtyPanel(r.terminal))
        .map((r) => r.id);
      // Async wrappers so a bridge that throws synchronously settles as a
      // rejection like any other failure, rather than escaping the call.
      const readOutputs = async (): Promise<Record<string, SerializedTerminalSnapshot | null>> =>
        idsToFetch.length > 0 ? window.electron.terminal.getSerializedStates(idsToFetch) : {};
      const readActivity = async (): Promise<Record<string, TerminalOutputActivityLookup>> =>
        activityIds.length > 0 ? terminalClient.getOutputActivity(activityIds) : {};
      // Independent reads, run side by side so the activity hop adds no
      // latency on top of serialization, and settled separately so either
      // can fail without costing the caller the other.
      const [outputRead, activityRead] = await Promise.allSettled([readOutputs(), readActivity()]);
      if (outputRead.status === "fulfilled") {
        outputs = outputRead.value;
      } else {
        outputError = formatErrorMessage(outputRead.reason, "Failed to fetch terminal output");
      }
      if (activityRead.status === "fulfilled") {
        activity = activityRead.value;
      } else {
        activityError = formatErrorMessage(activityRead.reason, "Failed to fetch output activity");
      }
    }

    // Delivery records live in the pty-host, so this is the one thing the
    // panel store cannot answer (#12337). One batched hop, and only when a
    // token was asked for — the default poll path issues no extra IPC.
    let submissions: Record<string, TerminalSubmissionLookup> | null = null;
    let submissionError: string | undefined;
    if (submissionToken !== undefined) {
      const idsToLookUp = resolved.filter((r) => r.terminal !== undefined).map((r) => r.id);
      if (idsToLookUp.length > 0) {
        try {
          submissions = await terminalClient.getSubmissions(idsToLookUp, submissionToken);
        } catch (err) {
          submissionError = formatErrorMessage(err, "Failed to fetch submission status");
        }
      } else {
        submissions = {};
      }
    }

    const entries: TerminalStatusEntry[] = resolved.map(({ id, terminal }) => {
      if (!terminal) {
        return {
          terminalId: id,
          agentId: null,
          agentState: null,
          error: "Terminal not found",
        };
      }

      const entry: TerminalStatusEntry = {
        terminalId: terminal.id,
        agentId: isPtyPanel(terminal)
          ? (terminal.detectedAgentId ?? terminal.launchAgentId ?? null)
          : null,
        agentState: isPtyPanel(terminal) ? (terminal.agentState ?? null) : null,
        lastTransitionAt: isPtyPanel(terminal) ? terminal.lastStateChange : undefined,
        // exitCode is set on the panel once the PTY exits (undefined while
        // running); spawnedAt comes from the panel's creation timestamp.
        exitCode: isPtyPanel(terminal) ? (terminal.exitCode ?? null) : undefined,
        spawnedAt: isPtyPanel(terminal) ? terminal.startedAt : undefined,
        // Observed respawns inside an unchanged PTY (#12535). Defaulted to
        // zero for a PTY panel rather than left absent: the panel row is born
        // with the PTY and the count only ever moves on a detection event
        // this surface subscribes to, so "none recorded" *is* "none observed"
        // here. Absent would be read as unobservable and refuse every
        // delivery this surface answers for, which is the whole of them.
        agentIncarnation: isPtyPanel(terminal) ? (terminal.agentIncarnation ?? 0) : undefined,
        // Parsed test/lint/check result (issue #10682). Best-effort, not
        // authoritative — see TerminalCheckResult / the schema doc above.
        lastCheckResult: isPtyPanel(terminal) ? terminal.lastCheckResult : undefined,
        // Handback marker the agent printed for a request (#12488). Set from
        // agent:state-changed; an observation of printed text, not a verdict.
        lastHandback: isPtyPanel(terminal) ? terminal.lastHandback : undefined,
        // Whether this terminal is in the fleet arming/broadcast set (#10695).
        armed: armedIds.has(terminal.id),
      };

      if (
        isPtyPanel(terminal) &&
        terminal.agentState === "waiting" &&
        terminal.waitingReason !== undefined
      ) {
        entry.waitingReason = terminal.waitingReason;
      }

      // Both batch fetches below can fail independently, and each is a
      // separate thing the caller lost. Appending rather than assigning stops
      // the later one reporting as the only failure while the earlier one
      // vanishes along with the field it would have filled.
      const appendError = (message: string) => {
        entry.error = entry.error === undefined ? message : `${entry.error}; ${message}`;
      };

      if (submissionToken !== undefined) {
        if (submissionError !== undefined) {
          // The lookup failed for the whole batch, so no entry can claim a
          // record. Report that as an error rather than as `unknown`, which
          // would assert the terminal has no such submission.
          appendError(submissionError);
        } else if (submissions !== null) {
          const lookup = submissions[terminal.id] ?? { status: "unreadable" as const };
          if (lookup.status === "found") {
            entry.submission = lookup.record;
          } else if (lookup.status === "absent") {
            // The terminal WAS read and holds nothing, so absence is
            // evidence and `unknown` is a claim we can make.
            entry.submission = { token: submissionToken, phase: "unknown" };
          } else {
            // Nothing was observed. Saying `unknown` here would assert this
            // terminal has no such submission on the strength of an RPC that
            // failed — the false certainty this issue exists to remove.
            appendError("Submission status unavailable for this terminal");
          }
        }
      }

      if (includeOutput) {
        if (outputError !== undefined) {
          // The IPC failed for the whole batch (transport-level failure),
          // so every successfully-resolved entry gets the same error.
          // Status fields are kept intact so the caller still has something
          // useful to act on — recentOutput is the only thing we lost.
          appendError(outputError);
          entry.recentOutput = null;
        } else if (outputs !== null) {
          const serialized = outputs[terminal.id] ?? null;
          if (serialized === null) {
            entry.recentOutput = null;
          } else {
            // Normalize before tailing (#10763) — see terminal.getOutput.
            // Without this, a bottom-padding TUI's blank rows fill the small
            // last-N window and recentOutput reads as empty even when idle.
            const tail = tailCapturedOutput(serialized.data, effectiveLines, stripAnsi);
            entry.recentOutput = tail.content;
            if (tail.truncated) entry.recentOutputTruncated = true;
          }
        }

        if (isPtyPanel(terminal)) {
          if (activityError !== undefined) {
            appendError(activityError);
          } else if (activity !== null) {
            const lookup = activity[terminal.id] ?? { status: "unreadable" as const };
            if (lookup.status === "unreadable") {
              // Nothing was read. Left silent, the missing timestamp would
              // pass for a terminal whose screen has not changed yet.
              appendError("Output activity unavailable for this terminal");
            } else {
              if (lookup.lastOutputChangeAt !== undefined) {
                entry.lastOutputChangeAt = lookup.lastOutputChangeAt;
              }
              if (lookup.lastTypedInputAt !== undefined) {
                entry.lastTypedInputAt = lookup.lastTypedInputAt;
              }
            }
          }
        }
      }

      return entry;
    });

    // `source` and `unavailableFields` are the same envelope the main-process
    // fallback answers in (#12316), so a client reads one shape whether or not
    // its workspace had a live view.
    //
    // `hasPty` is a field this richer surface cannot observe (#12336).
    // `PtyPanelData.hasPty` exists on the type but nothing in the renderer
    // ever writes it — not `addPanel`, not `statePatcher` on restore or
    // reconnect, and not the `onExit` listener in `store/listeners/panel/
    // lifecycle.ts` — which is why `fleetEligibility.ts` records that it lags
    // and reaches for `runtimeStatus` instead. Forwarding it would emit
    // nothing while claiming a view saw everything; deriving it from
    // `runtimeStatus` would publish an interpretation as a process fact. The
    // pty-host computes it, so the reduced answer reports it and this one
    // says it could not look. `lastOutputChangeAt` is also read off the
    // pty-host (#12428), but only on calls that asked for output (#12495), so
    // it is unobservable on the default poll and on a call whose activity
    // read failed outright. `lastTypedInputAt` rides the same read (#12718).
    //
    // Tails are fitted last, once every other field is in place, so the
    // budget they split is what the rest of the snapshot leaves (#12450).
    const unavailableFields: TerminalStatusUnavailableField[] =
      includeOutput && activityError === undefined
        ? ["hasPty"]
        : ["hasPty", "lastOutputChangeAt", "lastTypedInputAt"];
    return boundTerminalStatusOutput(
      {
        terminals: entries,
        source: "renderer" as const,
        unavailableFields,
      },
      MCP_RESPONSE_TEXT_MAX_BYTES
    );
  },
  "terminal.sendCommand": async (args: unknown) => {
    const { terminalId, command, handback } = args as {
      terminalId: string;
      command: string;
      handback?: boolean;
    };

    // Verify terminal exists and is valid for command execution
    const terminal = usePanelStore.getState().panelsById[terminalId];

    if (!terminal) {
      throw new Error("Terminal not found");
    }

    // Check if terminal is trashed
    if (terminal.location === "trash") {
      throw new Error("Cannot send commands to trashed terminals");
    }

    // Check if terminal kind supports PTY (must have a shell to send commands to)
    const kind = terminal.kind ?? "terminal";
    if (!panelKindHasPty(kind)) {
      throw new Error(`Terminal kind "${kind}" does not support command execution`);
    }

    // Check if terminal has PTY capability
    if (isPtyPanel(terminal) && terminal.hasPty === false) {
      throw new Error("Terminal does not have PTY capability");
    }

    // Refused rather than sent: a shell would run the instruction as a
    // command, and nothing there will ever print the marker (#12488).
    if (handback === true && !(isPtyPanel(terminal) && isAgentTerminal(terminal))) {
      throw new UnactionableTargetError(
        `handback needs an agent pane, and terminal '${terminalId}' has no agent running. Send without handback.`
      );
    }

    // Minted here rather than in main so the caller gets a correlator even if
    // the submit itself rejects — and minted after validation, so a token is
    // only ever handed out for a submission that was actually dispatched
    // (#12337). Not an idempotency key: two identical commands get two
    // tokens, because they are two submissions.
    const submissionToken = crypto.randomUUID();

    // Send command via submit (handles bracketed paste). Resolving means
    // queued, not written — which is exactly why the token exists.
    if (handback === true) {
      // The code never leaves Daintree: the caller reads the marker back as
      // `lastHandback`, so the receipt below still echoes its own text.
      const handbackCode = mintHandbackCode();
      await terminalClient.submit(
        terminalId,
        appendHandbackInstruction(command, handbackCode),
        submissionToken,
        handbackCode
      );
    } else {
      await terminalClient.submit(terminalId, command, submissionToken);
    }

    // A clear message so the AI model knows not to repeat this action, with
    // the command echoed back bounded, never whole: an oversized result drops
    // `structuredContent` and comes back flagged `isError`, which would report
    // a submission that DID go out as a failed call.
    return buildTerminalSendCommandReceipt(terminalId, command, submissionToken);
  },
} satisfies Record<string, (args: unknown, ctx: ActionContext) => Promise<unknown>>;

export type TerminalQueryActionRunId = keyof typeof terminalQueryActionRuns;
