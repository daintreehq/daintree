import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CHANNELS } from "../../ipc/channels.js";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type { PanelSnapshot, Project } from "../../../shared/types/project.js";
import { isBuiltInAgentId } from "../../../shared/config/agentIds.js";
import { MCP_RESPONSE_TEXT_MAX_BYTES } from "../../../shared/config/mcpLimits.js";
import { panelKindHasPty } from "../../../shared/config/panelKindRegistry.js";
import { readTailSnapshot, tailCapturedOutput } from "../../../shared/utils/artifactParser.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { readClientMetadata } from "../../../shared/utils/mcpClientMetadata.js";
import {
  buildPanelLimitSnapshot,
  computeHardwareDefaults,
} from "../../../shared/utils/panelLimit.js";
import {
  countsTowardPanelLimit,
  isClientMetadataEligible,
} from "../../../shared/utils/panelCount.js";
import { planChoice } from "../../../shared/utils/terminalChoice.js";
import { assessInterruptCandidate } from "../../../shared/utils/terminalInterrupt.js";
import { formatNoPanelMessage } from "../../../shared/utils/terminalInOtherProject.js";
import {
  CHOOSE_SCREEN_LINES,
  keySequence,
  SEND_KEYS_GAP_MS,
  SEND_KEYS_SCREEN_LINES,
  SEND_KEYS_SETTLE_MS,
  SendKeysArgsSchema,
} from "../../../shared/utils/terminalKeys.js";
import {
  boundTerminalStatusOutput,
  fitTerminalOutputResult,
} from "../../../shared/utils/terminalOutputBudget.js";
import {
  VIEWLESS_STATUS_UNAVAILABLE_FIELDS,
  type TerminalStatusResult,
} from "../../../shared/types/terminalStatus.js";
import { isAssistantTerminalRecord } from "../assistantTerminal.js";
import type {
  ViewlessActionRequest,
  ViewlessDeps,
  ViewlessPtyReader,
  ViewlessTerminalRecord,
} from "./ViewlessActionExecutor.js";
import { forgetViewlessTerminal } from "./projectStateAuthoring.js";
import {
  viewlessFailure as failure,
  viewlessSuccess as success,
  viewlessValidationFailure as validationFailure,
} from "./viewlessResult.js";

const TerminalListArgsSchema = z
  .object({
    worktreeId: z.string().optional(),
    location: z.enum(["grid", "dock", "trash", "background"]).optional(),
    owned: z.boolean().optional(),
    terminalId: z.string().min(1).optional(),
    includeClientMetadata: z.boolean().optional(),
  })
  .optional();

const TerminalGetOutputArgsSchema = z.object({
  terminalId: z.string().min(1),
  maxLines: z.number().int().min(1).max(1000).default(100),
  stripAnsi: z.boolean().default(true),
});

const TerminalTargetArgsSchema = z.object({ terminalId: z.string().min(1) });

/**
 * The record for a terminal of this project, or null. A renderer only sees its
 * own project's panels, so a terminal owned by any other project answers
 * exactly as one that does not exist.
 */
async function readOwnTerminal(
  pty: ViewlessPtyReader,
  projectId: string,
  terminalId: string
): Promise<ViewlessTerminalRecord | null> {
  if (pty.getTerminalProjectId(terminalId) !== projectId) return null;
  return pty.getTerminalAsync(terminalId);
}

/**
 * The agent a record is running, by the same rule a view's chrome applies:
 * the detected agent, else the launch hint while the process has not visibly
 * exited. Built-in agents only, the ones with an interrupt convention.
 */
function runtimeAgentId(record: ViewlessTerminalRecord) {
  if (isBuiltInAgentId(record.detectedAgentId)) return record.detectedAgentId;
  const exited = record.isExited === true || record.agentState === "exited";
  return !exited && isBuiltInAgentId(record.launchAgentId) ? record.launchAgentId : undefined;
}

interface ListedPanel {
  id: string;
  snapshot?: PanelSnapshot;
  record?: ViewlessTerminalRecord;
}

/**
 * The project's panels as a view would hydrate them: every panel the saved
 * layout records, joined with its live process, then any live terminal the
 * layout never mentions — hydration adopts those too. The assistant's own
 * terminal is never one of them. Read off every terminal the pty-host holds,
 * trashed ones included — the per-project inventory leaves those out, and a
 * panel in its recovery grace is still the trash's to list — joined with that
 * inventory for the ones only it can place in the project.
 */
async function readProjectPanels(project: Project, deps: ViewlessDeps): Promise<ListedPanel[]> {
  return (await readProjectPanelsReporting(project, deps)).panels;
}

/**
 * {@link readProjectPanels}, saying whether the pty-host's inventory was read
 * whole: with a shard silent or a listing failed, a live terminal the layout
 * never recorded can be missing, so the list is not the whole fleet.
 */
async function readProjectPanelsReporting(
  project: Project,
  deps: ViewlessDeps
): Promise<{ panels: ListedPanel[]; complete: boolean }> {
  const pty = deps.getPtyReader();
  let complete = pty !== null;
  const readAll = async (): Promise<ViewlessTerminalRecord[]> => {
    if (!pty) return [];
    if (pty.getAllTerminalsWithCompletenessAsync) {
      const listed = await pty.getAllTerminalsWithCompletenessAsync();
      if (listed.degraded) complete = false;
      return listed.terminals;
    }
    return pty.getAllTerminalsAsync();
  };
  const [state, all, owned] = await Promise.all([
    deps.getProjectState(project.id).catch(() => null),
    readAll().catch(() => {
      complete = false;
      return [];
    }),
    // The per-project inventory infers ownership for a terminal spawned
    // without a project stamp, which a raw listing cannot; it leaves trash out.
    pty
      ? pty.getTerminalsForProjectAsync(project.id, { strict: true }).catch(() => {
          complete = false;
          return [];
        })
      : Promise.resolve([]),
  ]);
  const ownedIds = new Set(owned);
  const records = new Map<string, ViewlessTerminalRecord>();
  for (const record of all) {
    if (record.id && (record.projectId === project.id || ownedIds.has(record.id))) {
      records.set(record.id, record);
    }
  }

  const panels: ListedPanel[] = [];
  const seen = new Set<string>();
  for (const snapshot of state?.terminals ?? []) {
    if (seen.has(snapshot.id)) continue;
    seen.add(snapshot.id);
    const record = records.get(snapshot.id);
    if (record && isAssistantTerminalRecord({ ...record, id: snapshot.id })) continue;
    panels.push({ id: snapshot.id, snapshot, ...(record ? { record } : {}) });
  }
  for (const [id, record] of records) {
    if (seen.has(id) || isAssistantTerminalRecord({ ...record, id })) continue;
    panels.push({ id, record });
  }
  return { panels, complete };
}

function panelLocation(panel: ListedPanel) {
  if (panel.record?.isTrashed) return "trash" as const;
  return panel.snapshot?.location ?? ("grid" as const);
}

/**
 * How many of the project's panels hold a slot against the panel limit, by the
 * rule a view counts with: neither the trash nor the assistant's own terminal.
 */
export async function countProjectPanels(project: Project, deps: ViewlessDeps): Promise<number> {
  const panels = await readProjectPanels(project, deps);
  return panels.filter((panel) => countsTowardPanelLimit({ location: panelLocation(panel) }))
    .length;
}

export async function runTerminalList(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = TerminalListArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const { worktreeId, location, owned, terminalId, includeClientMetadata } = parsed.data ?? {};
  // Main answers `owned` before dispatch and strips it, as it does for a view;
  // one that arrives here came from a path with no ownership authority.
  if (owned !== undefined) {
    return failure(
      "EXECUTION_ERROR",
      "terminal.list `owned` filters on the MCP session that created each terminal, which only the Daintree host can resolve. A direct dispatch cannot answer it — call the tool over MCP, or omit the argument."
    );
  }

  const panels = await readProjectPanels(project, deps);
  const rows = panels.map((panel) => {
    const kind = panel.snapshot?.kind ?? panel.record?.kind ?? "terminal";
    const isPty = panelKindHasPty(kind as Parameters<typeof panelKindHasPty>[0]);
    const panelWorktreeId = panel.record?.worktreeId ?? panel.snapshot?.worktreeId;
    return {
      panel,
      location: panelLocation(panel),
      worktreeId: panelWorktreeId,
      summary: {
        id: panel.id,
        kind,
        type: undefined,
        worktreeId: panelWorktreeId ?? null,
        title: panel.record?.title ?? panel.snapshot?.title ?? null,
        location: panelLocation(panel),
        agentId: isPty
          ? (panel.record?.detectedAgentId ??
            panel.record?.launchAgentId ??
            panel.snapshot?.launchAgentId ??
            null)
          : null,
        // Observed on the live process, never read back off a saved layout.
        agentState: isPty ? (panel.record?.agentState ?? null) : null,
        // Both are a view's: with none attached, nothing is locked or focused.
        isInputLocked: false,
        isFocused: false,
        ...(includeClientMetadata
          ? {
              clientMetadata: isClientMetadataEligible({
                kind,
                location: panelLocation(panel),
                ...(panel.snapshot?.pluginId !== undefined
                  ? { pluginId: panel.snapshot.pluginId }
                  : {}),
              })
                ? readClientMetadata(panel.snapshot?.extensionState)
                : null,
            }
          : {}),
      },
    };
  });

  const listed = rows
    .filter((row) => (worktreeId ? row.worktreeId === worktreeId : true))
    .filter((row) => (terminalId ? row.panel.id === terminalId : true))
    .filter((row) =>
      location
        ? row.location === location
        : row.location !== "trash" && row.location !== "background"
    )
    .map((row) => row.summary);

  // The limits a view would apply with none configured: no per-user setting is
  // readable here, so the hardware defaults a fresh view starts from stand in.
  const defaults = computeHardwareDefaults(deps.hostPlatform.totalMemoryBytes);
  const panelLimit = buildPanelLimitSnapshot(
    rows.filter((row) => countsTowardPanelLimit({ location: row.location })).length,
    {
      softWarningLimit: defaults.soft,
      confirmationLimit: defaults.confirm,
      hardLimit: defaults.hard,
    }
  );
  return success({ terminals: listed, panelLimit });
}

export async function runTerminalGetOutput(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = TerminalGetOutputArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const { terminalId, maxLines, stripAnsi } = parsed.data;
  const missing = {
    terminalId,
    content: null,
    lineCount: 0,
    truncated: false,
    error: "Terminal not found or has no output",
  };

  const pty = deps.getPtyReader();
  if (!pty || pty.getTerminalProjectId(terminalId) !== project.id) return success(missing);
  // Raw output keeps the whole-buffer read, as the view's does: the
  // serializer's erase escapes depend on the range it starts from.
  const serialized = stripAnsi
    ? await readTailSnapshot(
        (options) => pty.getSerializedStateAsync(terminalId, options),
        maxLines
      )
    : await pty.getSerializedStateAsync(terminalId);
  if (serialized === null) return success(missing);

  const { content, lineCount, truncated } = tailCapturedOutput(
    serialized.data,
    maxLines,
    stripAnsi
  );
  return success(
    fitTerminalOutputResult(
      { terminalId, content, lineCount, truncated },
      MCP_RESPONSE_TEXT_MAX_BYTES
    )
  );
}

/**
 * The pty-host status read main already serves a bound session with no view
 * (#12316). It answers only for named terminals: the fleet path filters on
 * panel locations, which a status read off processes cannot apply honestly.
 */
/** The fleet filters `terminal.getStatus` takes when it names no terminals. */
/** The fleet filters `terminal.getStatus` takes when it names no terminals, checked as a view checks them. */
const FleetStatusArgsSchema = z
  .object({
    worktreeId: z.string().optional(),
    location: z.enum(["grid", "dock", "trash", "background"]).optional(),
    submissionToken: z.string().min(1).max(128).optional(),
    includeOutput: z
      .union([
        z.boolean(),
        z.object({
          lines: z.number().int().min(1).max(50).optional(),
          stripAnsi: z.boolean().optional(),
        }),
      ])
      .optional(),
  })
  .passthrough();

/** Ids one pty-host status read takes; a larger fleet is read in batches. */
const MAX_STATUS_IDS = 256;

/**
 * `terminal.getStatus` for named terminals, read off the pty-host; or, naming
 * none, for the project's fleet (#13501) as a view picks it: its panels in
 * layout order, filtered by worktree and by location, leaving out the trash
 * and background ones unless that location is asked for, then read the same
 * way. Panel locations come from the saved layout a view would hydrate. A
 * fleet the pty-host could not list whole is refused rather than reported
 * short, since a missing terminal would read as one that isn't there.
 */
export async function runTerminalGetStatus(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const args = request.args;
  const named =
    args !== null &&
    typeof args === "object" &&
    !Array.isArray(args) &&
    (args as Record<string, unknown>).terminalIds !== undefined;
  if (named) return readStatus(request, args, project, deps);

  const parsed = FleetStatusArgsSchema.safeParse(args ?? {});
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const { worktreeId, location, submissionToken } = parsed.data;
  if (submissionToken !== undefined) {
    return failure(
      "EXECUTION_ERROR",
      "terminal.getStatus requires `terminalIds` when `submissionToken` is set."
    );
  }
  const { panels, complete } = await readProjectPanelsReporting(project, deps);
  if (!complete) {
    return failure(
      "EXECUTION_ERROR",
      "The terminal backend didn't list every terminal, so this project's fleet can't be told right now. Retry shortly, or name the terminals in `terminalIds`."
    );
  }
  const ids = panels
    .filter((panel) => {
      const where = panelLocation(panel);
      if (
        location !== undefined ? where !== location : where === "trash" || where === "background"
      ) {
        return false;
      }
      return (
        worktreeId === undefined ||
        (panel.record?.worktreeId ?? panel.snapshot?.worktreeId) === worktreeId
      );
    })
    .map((panel) => panel.id);
  if (ids.length === 0) {
    return success({
      terminals: [],
      source: "pty",
      unavailableFields: [...VIEWLESS_STATUS_UNAVAILABLE_FIELDS],
    } satisfies TerminalStatusResult);
  }
  const batches: string[][] = [];
  for (let start = 0; start < ids.length; start += MAX_STATUS_IDS) {
    batches.push(ids.slice(start, start + MAX_STATUS_IDS));
  }
  if (batches.length === 1) {
    return readStatus(request, { ...parsed.data, terminalIds: batches[0] }, project, deps);
  }
  const read: TerminalStatusResult[] = [];
  for (const terminalIds of batches) {
    const answer = await readStatus(request, { ...parsed.data, terminalIds }, project, deps);
    if (!answer.ok) return answer;
    read.push(answer.result as TerminalStatusResult);
  }
  // Fitted again as one answer, as a view's answer is.
  return success(
    boundTerminalStatusOutput<TerminalStatusResult>(
      { ...read[0]!, terminals: read.flatMap((batch) => batch.terminals) },
      MCP_RESPONSE_TEXT_MAX_BYTES
    )
  );
}

async function readStatus(
  request: ViewlessActionRequest,
  args: unknown,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  try {
    return success(await deps.readTerminalStatus(args, project.id));
  } catch (err) {
    if (err instanceof McpError) {
      return failure(
        "VALIDATION_ERROR",
        `Invalid arguments for ${request.actionId}: ${err.message}`
      );
    }
    return failure("EXECUTION_ERROR", formatErrorMessage(err, "Failed to read terminal status"));
  }
}

/**
 * Close one named panel. A terminal goes to the pty-host's trash, where its
 * process keeps the same recovery grace a view's close gives it, and leaves
 * the saved layout; a panel with no process only leaves the layout. Either
 * way the next frontend to attach does not bring it back.
 */
export async function runTerminalClose(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = TerminalTargetArgsSchema.safeParse(request.args ?? {});
  if (!parsed.success) {
    // There is no focused panel to fall back on, as there is none for an
    // automated caller in a view.
    return failure(
      "VALIDATION_ERROR",
      `${request.actionId} needs an explicit terminalId when no frontend is attached to this project.`
    );
  }
  const { terminalId } = parsed.data;
  const pty = deps.getPtyReader();
  const live = pty !== null && pty.getTerminalProjectId(terminalId) === project.id;
  let record: ViewlessTerminalRecord | null = null;
  if (live) {
    // Strict, so a pty-host that is slow to answer is never read as the
    // process being gone: forgetting a panel whose agent still runs would
    // report it closed and leave it for the next view to adopt.
    try {
      record = await pty.getTerminalAsync(terminalId, undefined, { strict: true });
    } catch (err) {
      return failure(
        "EXECUTION_ERROR",
        formatErrorMessage(err, "Could not read the terminal to close it")
      );
    }
  }
  const state = await deps.getProjectState(project.id).catch(() => null);
  const saved = state?.terminals?.some((terminal) => terminal.id === terminalId) ?? false;
  if (!record && !saved) {
    return failure("EXECUTION_ERROR", formatNoPanelMessage(request.actionId, terminalId));
  }

  try {
    if (record?.isTrashed) {
      // Re-trashing resets the recovery TTL, so the process is left be and
      // nothing is reported closed. A layout that still names it — an earlier
      // close whose save failed — is reconciled, or a view attaching during
      // the grace would bring it back.
      if (saved) await forgetViewlessTerminal(deps.stateWriter, project.id, terminalId);
      return success({ closedIds: [] });
    }
    if (record) await deps.invoke<void>(project.id, CHANNELS.TERMINAL_TRASH, [terminalId]);
    await forgetViewlessTerminal(deps.stateWriter, project.id, terminalId);
  } catch (err) {
    return failure("EXECUTION_ERROR", formatErrorMessage(err, "Failed to close terminal"));
  }
  return success({ closedIds: [terminalId] });
}

export async function runTerminalInterrupt(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = TerminalTargetArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const { terminalId } = parsed.data;
  const pty = deps.getPtyReader();
  if (!pty) return failure("EXECUTION_ERROR", "Terminal service is not available");
  const record = await readOwnTerminal(pty, project.id, terminalId);

  const kind = (record?.kind ?? "terminal") as Parameters<typeof panelKindHasPty>[0];
  const assessment = assessInterruptCandidate(
    record
      ? {
          isPty: panelKindHasPty(kind),
          trashed: record.isTrashed === true,
          hasPty: record.hasPty,
          exited: record.isExited === true,
          agentId: runtimeAgentId(record),
          agentState: record.agentState,
          waitingReason: record.waitingReason,
        }
      : undefined,
    terminalId
  );
  // A refusal says why nothing was written, and is not worth retrying as is.
  if (!assessment.eligible) return failure("VALIDATION_ERROR", assessment.reason);

  deps.send(project.id, CHANNELS.TERMINAL_BATCH_DOUBLE_ESCAPE, [[terminalId]]);
  return success({
    terminalId,
    agentId: assessment.agentId,
    agentStateAtDispatch: assessment.agentState,
    status: assessment.support === "advertised" ? "requested" : "requested-unverified",
  });
}

export async function runTerminalSendKeys(
  request: ViewlessActionRequest,
  project: Project,
  deps: ViewlessDeps
): Promise<ActionDispatchResult> {
  const parsed = SendKeysArgsSchema.safeParse(request.args);
  if (!parsed.success) return validationFailure(request.actionId, parsed.error);
  const { terminalId, choose } = parsed.data;
  const pty = deps.getPtyReader();
  if (!pty) return failure("EXECUTION_ERROR", "Terminal service is not available");
  const record = await readOwnTerminal(pty, project.id, terminalId);
  const kind = (record?.kind ?? "terminal") as Parameters<typeof panelKindHasPty>[0];
  if (!record || !panelKindHasPty(kind)) {
    return failure("VALIDATION_ERROR", `No terminal ${terminalId} to press keys in.`);
  }

  const readScreen = async (lines: number) => {
    const snapshot = await readTailSnapshot(
      (options) => pty.getSerializedStateAsync(terminalId, options),
      lines
    );
    return snapshot === null ? null : tailCapturedOutput(snapshot.data, lines, true).content;
  };

  let keys = parsed.data.keys;
  if (choose !== undefined) {
    const plan = planChoice((await readScreen(CHOOSE_SCREEN_LINES)) ?? "", choose);
    if (!plan.ok) return failure("VALIDATION_ERROR", `${plan.reason} Nothing was pressed.`);
    keys = plan.keys;
  }
  if (keys === undefined) {
    return failure("VALIDATION_ERROR", "Pass `choose` or `keys`. Nothing was pressed.");
  }
  // One write per key, spaced out, as the view's action writes them.
  for (const [index, key] of keys.entries()) {
    if (index > 0) await deps.sleep(SEND_KEYS_GAP_MS);
    deps.send(project.id, CHANNELS.TERMINAL_INPUT, [terminalId, keySequence(key)]);
  }
  await deps.sleep(SEND_KEYS_SETTLE_MS);
  const screen = await readScreen(SEND_KEYS_SCREEN_LINES).catch(() => null);
  return success({ terminalId, keys, ...(screen ? { screen } : {}) });
}
