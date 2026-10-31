import { listChoices, parseChoiceList } from "../../../shared/utils/terminalChoice.js";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";
import type { FleetRunRow, FleetSnapshot } from "../../../shared/types/ipc/fleet.js";
import { readPluginTerminalScreen } from "../plugin/pluginTerminalScreenRead.js";
import { redactSecrets } from "../redactSecrets.js";
import { ANSWER_SCREEN_LINES, isAnswerLabel, type AnswerPtyClient } from "../terminalAnswer.js";
import { questionIdOf } from "./questionId.js";

/** Runs a page lists at once; screens are read for each on every poll. */
export const MAX_LISTED_RUNS = 20;

/**
 * One waiting run as a paired device sees it: what Daintree observed, nothing
 * more, with secrets redacted from every word of it before it leaves.
 */
export interface WaitingRunView {
  runId: string;
  spawnedAt: number;
  project: string | null;
  title: string | null;
  agentId: string | null;
  agentState: AgentState;
  waitingReason: WaitingReason | null;
  /** When the run started waiting (epoch ms), when known. */
  since: number | null;
  /** The user parked or snoozed it here; it is still waiting all the same. */
  parked: boolean;
  snoozed: boolean;
  /** The bottom of its screen as plain text, or null when it couldn't be read. */
  screen: string | null;
  /** The options its screen draws that a press can reach, top to bottom. */
  choices: string[];
  /**
   * The question those options answer, sent back with an answer so it is
   * pressed only into the question this screen showed; null with no choices.
   */
  questionId: string | null;
}

/** A waiting run with the machine it waits on, as the page lists it. */
export interface DeviceWaitingRun extends WaitingRunView {
  /** `LOCAL_HOST_ID` for this machine's own runs. */
  hostId: string;
  /** The machine's name, as the person knows it. */
  host: string;
  /** The agent's name as Daintree shows it, when it is one Daintree knows. */
  agentName?: string | null;
}

/** How reading one host's runs went; a host with no link is `not-connected`, never dialled to find out. */
export type DeviceWaitingHostStatus = "ok" | "not-connected" | "unreachable" | "needs-update";

/** How reading one host in the host list went. */
export interface DeviceWaitingHost {
  hostId: string;
  host: string;
  status: DeviceWaitingHostStatus;
}

export interface DeviceWaitingList {
  /** This machine's name, so the page can say what it read when nothing is waiting. */
  computer?: string;
  runs: DeviceWaitingRun[];
  hosts: DeviceWaitingHost[];
  /** The host list itself couldn't be read, so hosts may be missing from `hosts`. */
  hostsUnlisted?: boolean;
}

export interface DeviceAnswerRunsDeps {
  fleet: () => FleetSnapshot | null;
  pty: () => AnswerPtyClient | null;
  projectName: (workspaceId: string) => string | null;
}

function isWaiting(row: FleetRunRow): boolean {
  return row.agentState === "waiting";
}

/** Whether the fleet still shows this exact run waiting: nothing is answered on an older word. */
export function isRunStillWaiting(
  snapshot: FleetSnapshot | null,
  runId: string,
  spawnedAt: number
): boolean {
  return (snapshot?.runs ?? []).some(
    (row) => row.runId === runId && row.spawnedAt === spawnedAt && isWaiting(row)
  );
}

/**
 * Every project's waiting runs, longest waiting first, each with its screen
 * read now. Runs come from the fleet snapshot main keeps for every view, so
 * the list needs no window open, no project loaded and no Canopy.
 */
export async function listWaitingRuns(deps: DeviceAnswerRunsDeps): Promise<WaitingRunView[]> {
  const rows = (deps.fleet()?.runs ?? [])
    .filter(isWaiting)
    .sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity))
    .slice(0, MAX_LISTED_RUNS);
  const pty = deps.pty();
  const views = await Promise.all(
    rows.map(async (row): Promise<WaitingRunView> => {
      const screen = await readScreenOf(pty, row);
      const title = row.title ?? row.lastObservedTitle ?? null;
      return {
        runId: row.runId,
        spawnedAt: row.spawnedAt,
        project: deps.projectName(row.workspaceId),
        title: title === null ? null : redactSecrets(title),
        agentId: row.agentId ?? row.launchAgentId ?? null,
        agentState: row.agentState ?? "waiting",
        waitingReason: row.waitingReason ?? null,
        since: row.since ?? null,
        parked: row.park !== undefined,
        snoozed: row.snooze !== undefined,
        // The whole screen at once: a key block or quoted value spans rows.
        screen: screen === null ? null : redactSecrets(screen),
        // Parsed from the raw screen, since redacting can swallow rows of the
        // dialog; the device answers with these labels as sent.
        ...(screen === null ? noChoices() : answerableChoices(row, screen)),
      };
    })
  );
  // A run that moved on while its screen was read isn't listed on an old word.
  const after = deps.fleet();
  return views.filter((view) => isRunStillWaiting(after, view.runId, view.spawnedAt));
}

type Answerable = Pick<WaitingRunView, "choices" | "questionId">;

function noChoices(): Answerable {
  return { choices: [], questionId: null };
}

/**
 * The options as the device is sent them, with the question they answer, or
 * none when one couldn't be sent back: redacting can lengthen a label past
 * what an answer may carry.
 */
function answerableChoices(row: FleetRunRow, screen: string): Answerable {
  const choices = listChoices(screen, redactSecrets);
  const question = parseChoiceList(screen)?.question;
  if (choices.length === 0 || !choices.every(isAnswerLabel) || question === undefined) {
    return noChoices();
  }
  return { choices, questionId: questionIdOf(row.runId, row.spawnedAt, question) };
}

/**
 * The run's screen, only if it is the very terminal the fleet row describes:
 * an id respawned since the row was taken holds someone else's screen.
 */
async function readScreenOf(pty: AnswerPtyClient | null, row: FleetRunRow): Promise<string | null> {
  if (!pty) return null;
  const sameRun = async () => (await pty.getTerminalAsync(row.runId))?.spawnedAt === row.spawnedAt;
  if (!(await sameRun())) return null;
  const read = await readPluginTerminalScreen(pty, row.runId, null, ANSWER_SCREEN_LINES);
  if (read.status !== "ok" || !(await sameRun())) return null;
  return read.text;
}
