import { listChoices, parseChoiceList } from "../../../shared/utils/terminalChoice.js";
import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";
import type { FleetRunRow, FleetSnapshot } from "../../../shared/types/ipc/fleet.js";
import { isHandBackStop } from "../../../shared/utils/runHandBack.js";
import { readPluginTerminalScreen } from "../plugin/pluginTerminalScreenRead.js";
import { redactSecrets } from "../redactSecrets.js";
import { ANSWER_SCREEN_LINES, isAnswerLabel, type AnswerPtyClient } from "../terminalAnswer.js";
import { questionIdOf } from "./questionId.js";

/** Runs a page lists at once; screens are read for each on every poll. */
export const MAX_LISTED_RUNS = 20;
/** Waiting runs past the screens read that are named without one; the count covers the rest. */
export const MAX_OMITTED_RUNS = 100;
/** The longest project name and title a run is sent with; a host's longer one fails the Shell's read. */
export const MAX_PROJECT_NAME_LENGTH = 256;
export const MAX_RUN_TITLE_LENGTH = 1024;

/** One run exactly: an id respawned since is someone else's terminal. */
export interface WaitingRunRef {
  runId: string;
  spawnedAt: number;
}

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

/** A waiting run the cap left unread: what the fleet shows of it, without its screen. */
export type WaitingRunSummary = Omit<WaitingRunView, "screen" | "choices" | "questionId">;

/** One machine's waiting runs: the ones read, and the ones the cap left unread. */
export interface WaitingRuns {
  runs: WaitingRunView[];
  /** The most pressing of the runs left unread, up to `MAX_OMITTED_RUNS`. */
  omitted: WaitingRunSummary[];
  /** Every run still waiting of those it set out to list, read or not. */
  waiting: number;
}

interface MachineOf {
  /** `LOCAL_HOST_ID` for this machine's own runs. */
  hostId: string;
  /** The machine's name, as the person knows it. */
  host: string;
  /** The agent's name as Daintree shows it, when it is one Daintree knows. */
  agentName?: string | null;
}

/** A waiting run with the machine it waits on, as the page lists it. */
export interface DeviceWaitingRun extends WaitingRunView, MachineOf {}

/** A run left unread, with the machine it waits on. */
export interface DeviceOmittedRun extends WaitingRunSummary, MachineOf {}

/** A run on one machine, as a device names it to have its screen read. */
export interface DeviceRunRef extends WaitingRunRef {
  hostId: string;
}

/**
 * How much of one machine's waiting list was read. `waiting` is null for a
 * host from before it said, which may have cut its list without saying so.
 */
export interface DeviceWaitingCoverage {
  hostId: string;
  host: string;
  listed: number;
  waiting: number | null;
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
  /** Runs left unread on any machine, so the page can name them and have one read. */
  omitted?: DeviceOmittedRun[];
  /** One entry for this machine and one for each host that was read. */
  coverage?: DeviceWaitingCoverage[];
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

function runKey(runId: string, spawnedAt: number): string {
  return `${runId}\u0000${spawnedAt}`;
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

type Need = Pick<
  WaitingRunSummary,
  "runId" | "spawnedAt" | "waitingReason" | "since" | "parked" | "snoozed"
>;

/**
 * Approvals, questions and errors ask something of the person; an agent at
 * its prompt has handed back. Either set aside (parked, snoozed) comes after
 * the same kind left in front of them.
 */
function tierOf(run: Need): number {
  const asks = !isHandBackStop("waiting", run.waitingReason ?? undefined);
  return (asks ? 0 : 2) + (run.parked || run.snoozed ? 1 : 0);
}

function compareSince(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/**
 * The order runs are read and shown in, whichever machine they wait on:
 * what asks something of the person first, then longest waiting.
 */
export function compareWaitingRuns(a: Need, b: Need): number {
  return (
    tierOf(a) - tierOf(b) ||
    compareSince(a.since, b.since) ||
    (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0) ||
    a.spawnedAt - b.spawnedAt
  );
}

function needOf(row: FleetRunRow): Need {
  return {
    runId: row.runId,
    spawnedAt: row.spawnedAt,
    waitingReason: row.waitingReason ?? null,
    since: row.since ?? null,
    parked: row.park !== undefined,
    snoozed: row.snooze !== undefined,
  };
}

function summaryOf(deps: DeviceAnswerRunsDeps, row: FleetRunRow): WaitingRunSummary {
  const title = row.title ?? row.lastObservedTitle ?? null;
  const project = deps.projectName(row.workspaceId);
  return {
    ...needOf(row),
    project: project === null ? null : project.slice(0, MAX_PROJECT_NAME_LENGTH),
    // Redacted whole before it is cut, so a cut never leaves part of a secret.
    title: title === null ? null : redactSecrets(title).slice(0, MAX_RUN_TITLE_LENGTH),
    agentId: row.agentId ?? row.launchAgentId ?? null,
    agentState: row.agentState ?? "waiting",
  };
}

/**
 * Every project's waiting runs, the most pressing first, with the screens of
 * up to `MAX_LISTED_RUNS` of them read now and the rest named without one.
 * `read` names one run to read ahead of the rest, so any run can be reached
 * while each request still reads a bounded number of screens. Runs come from
 * the fleet snapshot main keeps for every view, so the list needs no window
 * open, no project loaded and no Canopy.
 */
export async function listWaitingRuns(
  deps: DeviceAnswerRunsDeps,
  options: { read?: WaitingRunRef | null } = {}
): Promise<WaitingRuns> {
  const ranked = (deps.fleet()?.runs ?? [])
    .filter(isWaiting)
    .map((row) => ({ row, need: needOf(row) }))
    .sort((a, b) => compareWaitingRuns(a.need, b.need));
  const { read } = options;
  const wanted = read
    ? ranked.findIndex(({ row }) => row.runId === read.runId && row.spawnedAt === read.spawnedAt)
    : -1;
  if (wanted > 0) ranked.unshift(...ranked.splice(wanted, 1));
  const picked = ranked.slice(0, MAX_LISTED_RUNS);
  const cut = ranked.slice(MAX_LISTED_RUNS);
  const pty = deps.pty();
  const views = await Promise.all(
    picked.map(async ({ row }): Promise<WaitingRunView> => {
      const screen = await readScreenOf(pty, row);
      return {
        ...summaryOf(deps, row),
        // The whole screen at once: a key block or quoted value spans rows.
        screen: screen === null ? null : redactSecrets(screen),
        // Parsed from the raw screen, since redacting can swallow rows of the
        // dialog; the device answers with these labels as sent.
        ...(screen === null ? noChoices() : answerableChoices(row, screen)),
      };
    })
  );
  // A run that moved on while its screen was read isn't listed on an old
  // word, and one left unread isn't counted once it has.
  const still = new Set(
    (deps.fleet()?.runs ?? []).filter(isWaiting).map((row) => runKey(row.runId, row.spawnedAt))
  );
  const isStill = (run: WaitingRunRef) => still.has(runKey(run.runId, run.spawnedAt));
  const runs = views.filter(isStill).sort(compareWaitingRuns);
  const left = cut.filter(({ row }) => isStill(row));
  return {
    runs,
    omitted: left.slice(0, MAX_OMITTED_RUNS).map(({ row }) => summaryOf(deps, row)),
    waiting: runs.length + left.length,
  };
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
