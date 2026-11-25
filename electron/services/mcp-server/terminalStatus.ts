import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { GLOBAL_ASSISTANT_ID } from "../../../shared/config/globalAssistant.js";
import { panelKindHasPty } from "../../../shared/config/panelKindRegistry.js";
import { MCP_RESPONSE_TEXT_MAX_BYTES } from "../../../shared/config/mcpLimits.js";
import { readTailSnapshot } from "../../../shared/utils/artifactParser.js";
import { restoredField } from "../../../shared/utils/restoreProvenance.js";
import { inferKind } from "../../../shared/utils/inferPanelKind.js";
import { captureTerminalTail } from "../../../shared/utils/terminalInputLine.js";
import {
  boundTerminalStatusOutput,
  type CapturedTail,
} from "../../../shared/utils/terminalOutputBudget.js";
import {
  VIEWLESS_STATUS_UNAVAILABLE_FIELDS,
  type TerminalInputLine,
  type TerminalStatusEntry,
  type TerminalStatusResult,
} from "../../../shared/types/terminalStatus.js";
import type { PanelSnapshot, ProjectState } from "../../../shared/types/project.js";
import { isAssistantTerminalRecord } from "../assistantTerminal.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import type { PtyClient } from "../PtyClient.js";

/**
 * Main-process execution for `terminal.getStatus` when the bound workspace has
 * no live view (#12316).
 *
 * A workspace-bound external session is only reachable while its workspace
 * holds one of the handful of cached renderer views, so an orchestrator across
 * dozens of projects can observe almost none of them. The PTYs themselves never
 * left — they live in the pty-host — so a terminal-keyed status read is
 * answerable here, the same way `terminalInventoryPrefetch.ts` builds a
 * project's inventory straight off `PtyClient` with no view.
 *
 * Deliberately a *fallback*, not a replacement: the renderer answer carries the
 * panel-shaped fields this one cannot see. It is not strictly richer, though —
 * `hasPty` is computed here and only this answer reports it (#12336) — so the
 * two are told apart on the wire by `source` and `unavailableFields` rather
 * than by the client guessing from which fields happen to be present.
 */

/** Mirrors the action's own `terminalIds` bound, which does not run here. */
const MAX_TERMINAL_IDS = 256;
const MAX_OUTPUT_LINES = 50;
const DEFAULT_OUTPUT_LINES = 20;

/** The pty-host record `getTerminalAsync` resolves, which PtyClient keeps private. */
type TerminalRecord = NonNullable<Awaited<ReturnType<PtyClient["getTerminalAsync"]>>>;

export type ViewlessStatusPtyClient = Pick<
  PtyClient,
  | "getTerminalProjectId"
  | "getTerminalsForProjectAsync"
  | "getTerminalAsync"
  | "getSerializedStateAsync"
>;

export interface ViewlessTerminalStatusDeps {
  ptyClient: ViewlessStatusPtyClient;
  /**
   * The bound project's saved layout, read only for ids the pty-host could not
   * place (#18171): a pane restore held never spawned, so its layout entry is
   * the only record of it.
   */
  getProjectState: (projectId: string) => Promise<Pick<ProjectState, "terminals"> | null>;
}

interface ParsedArgs {
  terminalIds: string[];
  lines: number;
  stripAnsi: boolean;
  includeOutput: boolean;
  submissionToken?: string;
}

/** Mirrors the action schema's own bound; the args schema does not run here. */
const MAX_SUBMISSION_TOKEN_LENGTH = 128;

/**
 * Whether a call carries the explicit ids the viewless path needs.
 *
 * The fleet path filters on `location`, which is a panel concept with no
 * pty-host equivalent — answering it from the inventory would silently change
 * what "the fleet" means. Checked at the admission gate so a filter-only call
 * keeps its existing `SESSION_BINDING_GONE`, with the id requirement spelled
 * out, rather than turning into a validation error a poller cannot act on.
 */
export function viewlessStatusArgsAreAnswerable(rawArgs: unknown): boolean {
  if (rawArgs === undefined || rawArgs === null) return false;
  if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) return false;
  const ids = (rawArgs as Record<string, unknown>)["terminalIds"];
  return Array.isArray(ids) && ids.length > 0;
}

function parseArgs(rawArgs: unknown): ParsedArgs {
  if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "terminal.getStatus requires an object argument with a `terminalIds` array."
    );
  }
  const args = rawArgs as Record<string, unknown>;

  const idsRaw = args["terminalIds"];
  if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "terminal.getStatus requires a non-empty `terminalIds` array when the bound workspace has no live view."
    );
  }
  if (idsRaw.length > MAX_TERMINAL_IDS) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `terminal.getStatus accepts at most ${MAX_TERMINAL_IDS} \`terminalIds\`.`
    );
  }
  const terminalIds = idsRaw.map((id) => {
    if (typeof id !== "string" || id.trim() === "") {
      throw new McpError(
        ErrorCode.InvalidParams,
        "terminal.getStatus `terminalIds` entries must be non-empty strings."
      );
    }
    return id;
  });

  const submissionTokenRaw = args["submissionToken"];
  let submissionToken: string | undefined;
  if (submissionTokenRaw !== undefined && submissionTokenRaw !== null) {
    if (
      typeof submissionTokenRaw !== "string" ||
      submissionTokenRaw === "" ||
      submissionTokenRaw.length > MAX_SUBMISSION_TOKEN_LENGTH
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `terminal.getStatus \`submissionToken\` must be a non-empty string of at most ${MAX_SUBMISSION_TOKEN_LENGTH} characters.`
      );
    }
    submissionToken = submissionTokenRaw;
  }

  // `true` reads as the defaults, the same as the renderer's schema.
  const includeOutputArg = args["includeOutput"];
  const includeOutputRaw = includeOutputArg === true ? {} : includeOutputArg;
  if (includeOutputRaw === undefined || includeOutputRaw === null || includeOutputRaw === false) {
    return {
      terminalIds,
      lines: DEFAULT_OUTPUT_LINES,
      stripAnsi: true,
      includeOutput: false,
      submissionToken,
    };
  }
  if (typeof includeOutputRaw !== "object" || Array.isArray(includeOutputRaw)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "terminal.getStatus `includeOutput` must be `true` or an object."
    );
  }
  const includeOutput = includeOutputRaw as Record<string, unknown>;

  const linesRaw = includeOutput["lines"];
  let lines = DEFAULT_OUTPUT_LINES;
  if (linesRaw !== undefined) {
    if (typeof linesRaw !== "number" || !Number.isFinite(linesRaw)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "terminal.getStatus `includeOutput.lines` must be a number."
      );
    }
    lines = Math.min(Math.max(Math.floor(linesRaw), 1), MAX_OUTPUT_LINES);
  }

  const stripAnsiRaw = includeOutput["stripAnsi"];
  if (stripAnsiRaw !== undefined && typeof stripAnsiRaw !== "boolean") {
    throw new McpError(
      ErrorCode.InvalidParams,
      "terminal.getStatus `includeOutput.stripAnsi` must be a boolean."
    );
  }

  return {
    terminalIds,
    lines,
    stripAnsi: stripAnsiRaw ?? true,
    includeOutput: true,
    submissionToken,
  };
}

/**
 * Whether this record is a terminal an MCP caller may see at all.
 *
 * The non-PTY and assistant exclusions mirror `buildTerminalInventory` and the
 * renderer's own ephemeral-panel filter: tooling-internal panels — the dev
 * preview among them — must never report state to an MCP caller. The workspace
 * comparison is belt-and-braces behind the ownership scoping in
 * {@link buildViewlessTerminalStatus}, which is what actually keeps a foreign
 * id from being looked up.
 */
function isVisibleToBoundSession(
  record: TerminalRecord,
  workspaceId: string,
  admittedAssistants?: ReadonlySet<string>
): boolean {
  if (record.projectId !== workspaceId) return false;
  // A record with no `kind` is a plain terminal from an older pty-host entry;
  // it came from the terminal backend, so it has a PTY by construction.
  if (record.kind !== undefined && !panelKindHasPty(record.kind)) return false;
  // Only an assistant caller's own resolution names one it may read (#13496).
  if (isAssistantTerminalRecord(record)) return admittedAssistants?.has(record.id) === true;
  return true;
}

/**
 * Whether a terminal is an agent pane of this workspace, judged from the
 * pty-host's own record (#12883) — the one the transcript read resolves
 * against, so a spawn still in flight under the id cannot vouch for it, and a
 * pane whose PTY exited but whose record was kept still can. Excludes what
 * {@link isVisibleToBoundSession} does, the assistant overlay among them. An
 * unreadable record is not a pane.
 */
export async function isAgentPaneInWorkspace(
  ptyClient: Pick<PtyClient, "getTerminalAsync"> | null | undefined,
  terminalId: string,
  workspaceId: string
): Promise<boolean> {
  if (!ptyClient) return false;
  const record = await ptyClient.getTerminalAsync(terminalId);
  return record ? isVisibleToBoundSession(record, workspaceId) : false;
}

/**
 * A pane of the bound project that restore held rather than launched (#18171),
 * as the saved layout records it, judged as hydration would: a PTY kind once
 * legacy kinds are mapped, still carrying a hold marker it would keep.
 */
function isHeldPanel(
  snapshot: PanelSnapshot | undefined,
  workspaceId: string
): snapshot is PanelSnapshot {
  if (snapshot === undefined) return false;
  const marker: unknown = snapshot.restoreRecovery;
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)) return false;
  return panelKindHasPty(inferKind(snapshot, workspaceId));
}

/**
 * A held pane has no process, so it reports what the layout knows and leaves
 * every process measurement out rather than inventing one. `agentState` stays
 * the detector's, which has seen nothing since the restart.
 */
function buildHeldEntry(snapshot: PanelSnapshot, includeOutput: boolean): TerminalStatusEntry {
  return {
    terminalId: snapshot.id,
    agentId: snapshot.launchAgentId ?? null,
    agentState: null,
    hasPty: false,
    ...restoredField(snapshot),
    ...(includeOutput ? { recentOutput: null } : {}),
  };
}

function buildEntry(record: TerminalRecord, submissionToken?: string): TerminalStatusEntry {
  const agentState = record.agentState ?? null;

  const entry: TerminalStatusEntry = {
    terminalId: record.id,
    // The agent kind, in the renderer's own precedence — the runtime-detected
    // agent outranks the one the terminal was launched as.
    agentId: record.detectedAgentId ?? record.launchAgentId ?? null,
    agentState,
    lastTransitionAt: record.lastStateChange,
    spawnedAt: record.spawnedAt,
  };

  // Counted on the pty-host record, so this surface reports whatever it holds.
  // Older records predate the field and are unobserved rather than zero — the
  // distinction the delivery path refuses on (#12535).
  if (record.agentIncarnation !== undefined) {
    entry.agentIncarnation = record.agentIncarnation;
  }

  // `!wasKilled && !isExited` off the pty-host record (#12336). A pane that
  // exits cleanly is deliberately preserved, so the record outlives its
  // process and `false` is a real reading rather than a missing row. Assigned
  // only when the backend actually reported it: an older record without the
  // field is unobserved, and `false` there would be an invented exit.
  if (record.hasPty !== undefined) {
    entry.hasPty = record.hasPty;
  }

  // Absent means no content change has been observed yet, so there is nothing
  // to report rather than a time to invent (#12428).
  if (record.lastOutputChangeAt !== undefined) {
    entry.lastOutputChangeAt = record.lastOutputChangeAt;
  }

  // Absent means no raw input has been written to this PTY (#12718).
  if (record.lastTypedInputAt !== undefined) {
    entry.lastTypedInputAt = record.lastTypedInputAt;
  }

  if (agentState === "waiting" && record.waitingReason !== undefined) {
    entry.waitingReason = record.waitingReason;
    if (record.waitingReason === "approval" && record.approvalKind !== undefined) {
      entry.approvalKind = record.approvalKind;
    }
  }

  // Kept on the pty-host record, so this surface sees it too (#17905).
  if (record.updateInstalled !== undefined) {
    entry.updateInstalled = record.updateInstalled;
  }

  // Parsed on the pty-host and kept on its record, so unlike `lastCheckResult`
  // this surface can observe it (#12488); absent means none was seen.
  if (record.lastHandback !== undefined) {
    entry.lastHandback = record.lastHandback;
  }

  // The record was read, so an absent `submission` is evidence: this terminal
  // holds nothing for that token. Reported as `unknown` rather than omitted,
  // which a caller could not tell from "the field was never asked for".
  if (submissionToken !== undefined) {
    if (record.submission === undefined) {
      entry.submission = { token: submissionToken, phase: "unknown" };
    } else {
      // Main's own reading of a guarded line (#18157), not part of this surface.
      const { cancelledAt: _cancelledAt, ...submission } = record.submission;
      entry.submission = submission;
    }
  }

  return entry;
}

/**
 * Read status for explicitly named terminals in one workspace, off the pty-host.
 *
 * Every requested id is checked against the bound workspace's own inventory
 * *before* any terminal-keyed RPC is issued. Filtering the records afterwards
 * would answer the same way, but it would first route a `get-terminal` for a
 * foreign id — and the pty fabric shards by owning project, so a foreign id
 * lands on its owner's shard while an unknown one lands on the default. The two
 * rows read identically; their latency need not, and a stalled foreign shard
 * would be the tell.
 *
 * Two oracles, because neither alone is both cheap and complete.
 * `getTerminalProjectId` is a synchronous main-side read of the spawn options,
 * so it costs nothing and — the reason it leads — it still places a *trashed*
 * terminal, which a caller may legitimately poll during its recovery window. It
 * returns `null` for a terminal this main process never tracked, so only what
 * it cannot place falls through to the project's live inventory, and that RPC
 * is skipped entirely when it places every id. The inventory in turn excludes
 * trash (`TerminalRegistry.getForProject`), which is the gap the first oracle
 * covers.
 *
 * Request order and duplicates are preserved — a caller zipping the answer
 * against its own id list must get one row per id it asked for. Backend reads
 * are deduplicated so a repeated id costs one RPC, not one per mention.
 */
export async function buildViewlessTerminalStatus(
  deps: ViewlessTerminalStatusDeps,
  workspaceId: string,
  rawArgs: unknown,
  admittedAssistants?: ReadonlySet<string>,
  admittedGlobals?: ReadonlySet<string>
): Promise<TerminalStatusResult> {
  const { terminalIds, lines, stripAnsi, includeOutput, submissionToken } = parseArgs(rawArgs);
  const uniqueIds = [...new Set(terminalIds)];
  // The global Assistant sessions a project's assistant named (#16410, #18142)
  // are the only ids read outside the workspace, and only where their own runs are.
  const isGlobal = (id: string) => admittedGlobals?.has(id) === true;
  const workspaceOf = (id: string) => (isGlobal(id) ? GLOBAL_ASSISTANT_ID : workspaceId);

  const placed = new Set<string>();
  const unplaced: string[] = [];
  let anyUnplaced = false;
  for (const id of uniqueIds) {
    const owner = deps.ptyClient.getTerminalProjectId(id);
    if (owner === workspaceOf(id)) {
      placed.add(id);
      continue;
    }
    anyUnplaced = true;
    // `null` means untracked, not foreign — the inventory decides those. A
    // non-null owner that is some other workspace is settled here: never
    // looked up, so never routed at its shard.
    if (owner === null) unplaced.push(id);
  }
  // A foreign id pays for the same project-scoped reads an unknown one does,
  // so the layout read below cannot make the two answer at different speeds.
  // Both reads are of the bound project only; neither names the id.
  let layoutRead: Promise<Pick<ProjectState, "terminals"> | null> = Promise.resolve(null);
  if (anyUnplaced) {
    let inventory: Set<string> | null = null;
    try {
      inventory = new Set(
        await deps.ptyClient.getTerminalsForProjectAsync(workspaceId, { strict: true })
      );
    } catch {
      // Nothing could be observed, so those rows stay "not found or
      // unavailable" — and the layout is not read: with a shard silent, a live
      // terminal it never stamped would read as the hold the layout remembers.
    }
    if (inventory !== null) {
      for (const id of unplaced) if (inventory.has(id)) placed.add(id);
      // A rejected read means the saved panels are unknown, not absent.
      if (uniqueIds.some((id) => !placed.has(id))) {
        layoutRead = deps.getProjectState(workspaceId).catch(() => null);
      }
    }
  }
  const lookupIds = uniqueIds.filter((id) => placed.has(id));

  const records = new Map<string, TerminalRecord>();
  // The token rides the record fetch this path already issues, so correlating a
  // submission costs no extra RPC here (#12337).
  const fetched = await Promise.all(
    lookupIds.map((id) => deps.ptyClient.getTerminalAsync(id, submissionToken))
  );
  lookupIds.forEach((id, index) => {
    const record = fetched[index];
    // `getTerminalAsync` folds an RPC failure into `null`, so this means "not
    // found or unreadable" — never evidence that the terminal has exited.
    if (record && isVisibleToBoundSession(record, workspaceOf(id), admittedAssistants)) {
      records.set(id, record);
    }
  });

  const outputs = new Map<string, (CapturedTail & { inputLine: TerminalInputLine }) | null>();
  if (includeOutput) {
    // The global's screen is the person's own conversation: never read for a project.
    const readable = lookupIds.filter((id) => records.has(id) && !isGlobal(id));
    const snapshots = await Promise.all(
      // Raw output keeps the whole-buffer read: the serializer's erase escapes
      // depend on the range it starts from, so a capped read is not byte-identical.
      readable.map((id) =>
        stripAnsi
          ? readTailSnapshot(
              (options) => deps.ptyClient.getSerializedStateAsync(id, options),
              lines
            )
          : deps.ptyClient.getSerializedStateAsync(id)
      )
    );
    readable.forEach((id, index) => {
      const snapshot = snapshots[index];
      const record = records.get(id)!;
      outputs.set(
        id,
        // Normalize before tailing (#10763), same as the renderer path: a
        // bottom-padding TUI's blank rows otherwise fill the last-N window and
        // an active agent reads as silent. The input box is read off the same
        // screen, by the agent the entry reports (#16189).
        snapshot
          ? captureTerminalTail(
              snapshot.data,
              lines,
              stripAnsi,
              record.detectedAgentId ?? record.launchAgentId
            )
          : null
      );
    });
  }

  // Awaited only once every live read is done, so the layout adds no time
  // between placing an id, reading its record and reading its screen.
  const state = await layoutRead;
  const saved = new Map<string, PanelSnapshot>();
  for (const snapshot of state?.terminals ?? []) {
    if (!saved.has(snapshot.id)) saved.set(snapshot.id, snapshot);
  }
  const held = new Map<string, PanelSnapshot>();
  for (const id of unplaced) {
    // Assistants and the global's sessions are never layout panes of this
    // project; only an ordinary id can be answered from the layout.
    if (placed.has(id) || isGlobal(id) || admittedAssistants?.has(id) === true) continue;
    const snapshot = saved.get(id);
    if (!isHeldPanel(snapshot, workspaceId) || isAssistantTerminalRecord({ id })) continue;
    // Checked after every await: a spawn that took the id meanwhile ends the
    // hold, and the layout no longer describes what runs under it.
    if (deps.ptyClient.getTerminalProjectId(id) !== null) continue;
    held.set(id, snapshot);
  }

  const terminals = terminalIds.map((id): TerminalStatusEntry => {
    const record = records.get(id);
    const heldSnapshot = held.get(id);
    if (!record && heldSnapshot !== undefined) return buildHeldEntry(heldSnapshot, includeOutput);
    if (!record) {
      // Deliberately one message for three cases: no such terminal, one in
      // another workspace, and one the backend could not be read for. The first
      // two must not be distinguishable — a bound session confirming a foreign
      // id is the leak this scoping exists to prevent — and the third is real,
      // so the wording must not promise the terminal is gone.
      return {
        terminalId: id,
        agentId: null,
        agentState: null,
        error: "Terminal not found or status unavailable",
      };
    }
    const entry = buildEntry(record, submissionToken);
    if (isGlobal(id)) {
      // Its handback is shown only to the send that asked for it, by that
      // send's token, and never the screen a submission's capture kept.
      if (
        submissionToken === undefined ||
        entry.lastHandback?.submissionToken !== submissionToken
      ) {
        delete entry.lastHandback;
      }
      if (entry.submission?.output !== undefined) {
        const submission = { ...entry.submission };
        delete submission.output;
        entry.submission = submission;
      }
    }
    if (includeOutput) {
      const tail = outputs.get(id) ?? null;
      entry.recentOutput = tail?.content ?? null;
      if (tail !== null) entry.inputLine = tail.inputLine;
      if (tail?.truncated) entry.recentOutputTruncated = true;
    }
    return entry;
  });

  // Same fitting as the renderer answer (#12450), so a caller's tails do not
  // change shape with whether its workspace happens to have a view open.
  return boundTerminalStatusOutput<TerminalStatusResult>(
    {
      terminals,
      source: "pty",
      unavailableFields: [...VIEWLESS_STATUS_UNAVAILABLE_FIELDS],
    },
    MCP_RESPONSE_TEXT_MAX_BYTES
  );
}

/**
 * Production entry point: resolve the global PTY client and agent ledger, then
 * read. `workspaceId` comes from the session's handshake binding, never from
 * caller arguments — the whole point of the binding is that a session cannot
 * name a different workspace per call.
 */
export async function handleTerminalGetStatusViewless(
  rawArgs: unknown,
  workspaceId: string,
  admittedAssistants?: ReadonlySet<string>,
  admittedGlobals?: ReadonlySet<string>
): Promise<TerminalStatusResult> {
  const ptyClient = getPtyClient();
  if (!ptyClient) {
    throw new McpError(
      ErrorCode.InternalError,
      "The terminal backend is not available, so terminal status cannot be read without a live view."
    );
  }
  const { projectStore } = await import("../ProjectStore.js");
  return buildViewlessTerminalStatus(
    { ptyClient, getProjectState: (projectId) => projectStore.getProjectState(projectId) },
    workspaceId,
    rawArgs,
    admittedAssistants,
    admittedGlobals
  );
}
