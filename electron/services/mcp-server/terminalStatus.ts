import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { panelKindHasPty } from "../../../shared/config/panelKindRegistry.js";
import { tailCapturedOutput } from "../../../shared/utils/artifactParser.js";
import type {
  TerminalStatusEntry,
  TerminalStatusResult,
  TerminalStatusUnavailableField,
} from "../../../shared/types/terminalStatus.js";
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

/**
 * What a pty-sourced answer structurally cannot observe.
 *
 * `armed` is fleet-broadcast routing held in `useFleetArmingStore`, and
 * `lastCheckResult` is parsed out of agent stdout by `CheckResultDetector` —
 * both only ever reach the renderer's panel record, and main keeps no copy.
 *
 * `exitCode` is the one that looks reachable and is not. Main does cache exit
 * metadata, but `AgentAvailabilityStore` keys it by agent id, and an agent id
 * names the agent *type* ("claude"), not the spawn — so several terminals share
 * one, and `agentToTerminal` keeps only the most recent. Joining through it
 * would report whichever same-type terminal exited last, which for a fleet of
 * identical agents is a wrong answer far more often than a right one. The
 * renderer path has the code on the panel itself and reports it there.
 *
 * All three are reported as unavailable rather than defaulted or guessed:
 * `armed: false` and a borrowed exit code are both interpretations main has no
 * evidence for. `agentState` still distinguishes `completed` from `exited`, so
 * "the run finished, and how" survives without the numeric code.
 *
 * `hasPty` is deliberately *not* here. It is computed in the pty-host itself
 * (`mapTerminalInfo`), so this is the surface that can observe it — the
 * renderer's panel copy is the one that never gets written (#12336).
 */
export const VIEWLESS_STATUS_UNAVAILABLE_FIELDS: readonly TerminalStatusUnavailableField[] = [
  "armed",
  "lastCheckResult",
  "exitCode",
];

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
}

interface ParsedArgs {
  terminalIds: string[];
  lines: number;
  stripAnsi: boolean;
  includeOutput: boolean;
}

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

  const includeOutputRaw = args["includeOutput"];
  if (includeOutputRaw === undefined || includeOutputRaw === null) {
    return { terminalIds, lines: DEFAULT_OUTPUT_LINES, stripAnsi: true, includeOutput: false };
  }
  if (typeof includeOutputRaw !== "object" || Array.isArray(includeOutputRaw)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "terminal.getStatus `includeOutput` must be an object."
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

  return { terminalIds, lines, stripAnsi: stripAnsiRaw ?? true, includeOutput: true };
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
function isVisibleToBoundSession(record: TerminalRecord, workspaceId: string): boolean {
  if (record.projectId !== workspaceId) return false;
  // A record with no `kind` is a plain terminal from an older pty-host entry;
  // it came from the terminal backend, so it has a PTY by construction.
  if (record.kind !== undefined && !panelKindHasPty(record.kind)) return false;
  if (isAssistantTerminalRecord(record)) return false;
  return true;
}

function buildEntry(record: TerminalRecord): TerminalStatusEntry {
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

  // `!wasKilled && !isExited` off the pty-host record (#12336). A pane that
  // exits cleanly is deliberately preserved, so the record outlives its
  // process and `false` is a real reading rather than a missing row. Assigned
  // only when the backend actually reported it: an older record without the
  // field is unobserved, and `false` there would be an invented exit.
  if (record.hasPty !== undefined) {
    entry.hasPty = record.hasPty;
  }

  if (agentState === "waiting" && record.waitingReason !== undefined) {
    entry.waitingReason = record.waitingReason;
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
  rawArgs: unknown
): Promise<TerminalStatusResult> {
  const { terminalIds, lines, stripAnsi, includeOutput } = parseArgs(rawArgs);
  const uniqueIds = [...new Set(terminalIds)];

  const placed = new Set<string>();
  const unplaced: string[] = [];
  for (const id of uniqueIds) {
    const owner = deps.ptyClient.getTerminalProjectId(id);
    if (owner === workspaceId) placed.add(id);
    // `null` means untracked, not foreign — the inventory decides those. A
    // non-null owner that is some other workspace is settled here: never
    // looked up, so never routed at its shard.
    else if (owner === null) unplaced.push(id);
  }
  if (unplaced.length > 0) {
    // A failed inventory folds to `[]` in `PtyClient`, which leaves those rows
    // "not found or unavailable" — honest, since nothing could be observed.
    const inventory = new Set(await deps.ptyClient.getTerminalsForProjectAsync(workspaceId));
    for (const id of unplaced) if (inventory.has(id)) placed.add(id);
  }
  const lookupIds = uniqueIds.filter((id) => placed.has(id));

  const records = new Map<string, TerminalRecord>();
  const fetched = await Promise.all(lookupIds.map((id) => deps.ptyClient.getTerminalAsync(id)));
  lookupIds.forEach((id, index) => {
    const record = fetched[index];
    // `getTerminalAsync` folds an RPC failure into `null`, so this means "not
    // found or unreadable" — never evidence that the terminal has exited.
    if (record && isVisibleToBoundSession(record, workspaceId)) records.set(id, record);
  });

  const outputs = new Map<string, string | null>();
  if (includeOutput) {
    const readable = lookupIds.filter((id) => records.has(id));
    const snapshots = await Promise.all(
      readable.map((id) => deps.ptyClient.getSerializedStateAsync(id))
    );
    readable.forEach((id, index) => {
      const snapshot = snapshots[index];
      outputs.set(
        id,
        // Normalize before tailing (#10763), same as the renderer path: a
        // bottom-padding TUI's blank rows otherwise fill the last-N window and
        // an active agent reads as silent.
        snapshot ? tailCapturedOutput(snapshot.data, lines, stripAnsi).content : null
      );
    });
  }

  const terminals = terminalIds.map((id): TerminalStatusEntry => {
    const record = records.get(id);
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
    const entry = buildEntry(record);
    if (includeOutput) entry.recentOutput = outputs.get(id) ?? null;
    return entry;
  });

  return {
    terminals,
    source: "pty",
    unavailableFields: [...VIEWLESS_STATUS_UNAVAILABLE_FIELDS],
  };
}

/**
 * Production entry point: resolve the global PTY client and agent ledger, then
 * read. `workspaceId` comes from the session's handshake binding, never from
 * caller arguments — the whole point of the binding is that a session cannot
 * name a different workspace per call.
 */
export async function handleTerminalGetStatusViewless(
  rawArgs: unknown,
  workspaceId: string
): Promise<TerminalStatusResult> {
  const ptyClient = getPtyClient();
  if (!ptyClient) {
    throw new McpError(
      ErrorCode.InternalError,
      "The terminal backend is not available, so terminal status cannot be read without a live view."
    );
  }
  return buildViewlessTerminalStatus({ ptyClient }, workspaceId, rawArgs);
}
