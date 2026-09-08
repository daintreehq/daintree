import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { panelKindHasPty } from "../../../shared/config/panelKindRegistry.js";
import { tailCapturedOutput } from "../../../shared/utils/artifactParser.js";
import type {
  TerminalStatusEntry,
  TerminalStatusResult,
  TerminalStatusUnavailableField,
} from "../../../shared/types/terminalStatus.js";
import { getAgentAvailabilityStore } from "../AgentAvailabilityStore.js";
import type { AgentAvailabilityStore } from "../AgentAvailabilityStore.js";
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
 * Deliberately a *fallback*, not a replacement. The renderer answer is strictly
 * richer, and the two are told apart on the wire by `source` rather than by the
 * client guessing from which fields happen to be present.
 */

/**
 * What a pty-sourced answer structurally cannot observe.
 *
 * `armed` is fleet-broadcast routing held in `useFleetArmingStore`, and
 * `lastCheckResult` is parsed out of agent stdout by `CheckResultDetector` and
 * only ever reaches the renderer's panel record — main keeps no copy of either.
 * Reported as unavailable rather than defaulted: `armed: false` would be an
 * interpretation main has no evidence for.
 */
export const VIEWLESS_STATUS_UNAVAILABLE_FIELDS: readonly TerminalStatusUnavailableField[] = [
  "armed",
  "lastCheckResult",
];

/** Mirrors the action's own `terminalIds` bound, which does not run here. */
const MAX_TERMINAL_IDS = 256;
const MAX_OUTPUT_LINES = 50;
const DEFAULT_OUTPUT_LINES = 20;

/** The pty-host record `getTerminalAsync` resolves, which PtyClient keeps private. */
type TerminalRecord = NonNullable<Awaited<ReturnType<PtyClient["getTerminalAsync"]>>>;

export type ViewlessStatusPtyClient = Pick<
  PtyClient,
  "getTerminalAsync" | "getSerializedStateAsync"
>;

export type ViewlessStatusAvailabilityStore = Pick<
  AgentAvailabilityStore,
  "getAgentIdForTerminal" | "getExitCode"
>;

export interface ViewlessTerminalStatusDeps {
  ptyClient: ViewlessStatusPtyClient;
  availability: ViewlessStatusAvailabilityStore;
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
 * Whether this record belongs to the bound workspace and is a terminal an MCP
 * caller may see at all.
 *
 * The non-PTY and assistant exclusions mirror `buildTerminalInventory` and the
 * renderer's own ephemeral-panel filter: tooling-internal panels — the dev
 * preview among them — must never report state to an MCP caller. A record from another workspace is treated the
 * same as one that does not exist — a bound session must not be able to confirm
 * a terminal id it has no route to.
 */
function isVisibleToBoundSession(record: TerminalRecord, workspaceId: string): boolean {
  if (record.projectId !== workspaceId) return false;
  // A record with no `kind` is a plain terminal from an older pty-host entry;
  // it came from the terminal backend, so it has a PTY by construction.
  if (record.kind !== undefined && !panelKindHasPty(record.kind)) return false;
  if (isAssistantTerminalRecord(record)) return false;
  return true;
}

function buildEntry(
  record: TerminalRecord,
  availability: ViewlessStatusAvailabilityStore
): TerminalStatusEntry {
  const agentState = record.agentState ?? null;

  const entry: TerminalStatusEntry = {
    terminalId: record.id,
    // The agent *kind*, in the renderer's own precedence — the runtime-detected
    // agent outranks the one the terminal was launched as. Deliberately not the
    // availability ledger's agent id, which is a per-spawn instance handle used
    // below for the exit-code join and would put a different namespace on the
    // wire under the same field name.
    agentId: record.detectedAgentId ?? record.launchAgentId ?? null,
    agentState,
    lastTransitionAt: record.lastStateChange,
    spawnedAt: record.spawnedAt,
  };

  if (agentState === "waiting" && record.waitingReason !== undefined) {
    entry.waitingReason = record.waitingReason;
  }

  // Exit metadata only once the agent has finished, matching the `agentState`
  // resource: absence means still running, and a `null` code means a signal
  // kill with no numeric status. Gate on the terminal state rather than on the
  // value, which is legitimately `null` and legitimately `0`.
  if (agentState === "completed" || agentState === "exited") {
    const ledgerAgentId = availability.getAgentIdForTerminal(record.id);
    if (ledgerAgentId !== undefined) {
      const exitCode = availability.getExitCode(ledgerAgentId);
      if (exitCode !== undefined) entry.exitCode = exitCode;
    }
  }

  return entry;
}

/**
 * Read status for explicitly named terminals in one workspace, off the pty-host.
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

  const records = new Map<string, TerminalRecord>();
  const fetched = await Promise.all(uniqueIds.map((id) => deps.ptyClient.getTerminalAsync(id)));
  uniqueIds.forEach((id, index) => {
    const record = fetched[index];
    // `getTerminalAsync` folds an RPC failure into `null`, so this means "not
    // found or unreadable" — never evidence that the terminal has exited.
    if (record && isVisibleToBoundSession(record, workspaceId)) records.set(id, record);
  });

  const outputs = new Map<string, string | null>();
  if (includeOutput) {
    const readable = uniqueIds.filter((id) => records.has(id));
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
      return { terminalId: id, agentId: null, agentState: null, error: "Terminal not found" };
    }
    const entry = buildEntry(record, deps.availability);
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
  return buildViewlessTerminalStatus(
    { ptyClient, availability: getAgentAvailabilityStore() },
    workspaceId,
    rawArgs
  );
}
