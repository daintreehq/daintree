import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodexLimitContinueChange,
  CodexLimitContinueResult,
  CodexLimitStopRef,
} from "../../../../shared/types/codexLimitContinuation.js";
import type { CodexLimitStop } from "../../codex/CodexLimitReset.js";
import {
  CONTINUE_AFTER_RESET_MS,
  LAUNCH_CONFIRMATION_MS,
  READS_PAUSED_RETRY_MS,
  WAKE_SETTLE_MS,
  CodexLimitContinuation,
  CodexLimitContinuationError,
  type CodexLimitContinuationDeps,
  type ContinuationTerminal,
} from "../CodexLimitContinuation.js";
import type { LimitFallback } from "../limitFallback.js";

const PROJECT = "project-1";
const STOP: CodexLimitStopRef = { run: "run-a", seq: 1 };
const START = Date.UTC(2026, 10, 19, 22, 0);
const RESETS_AT = START + 2 * 60 * 60_000;

const codexPane = (extra: Partial<ContinuationTerminal> = {}): ContinuationTerminal => ({
  projectId: PROJECT,
  launchAgentId: "codex",
  detectedAgentId: "codex",
  agentPresetId: undefined,
  originalAgentPresetId: undefined,
  fallbackChainIndex: undefined,
  isAssistantTerminal: false,
  spawnedAt: 1_000,
  launchGeneration: undefined,
  ...extra,
});

const known = (resetsAt = RESETS_AT, stamp = STOP): CodexLimitStop => ({
  reset: { status: "known", resetsAt, precision: "second", source: "quota", observedAt: START },
  stamp: { ...stamp, observedAt: START },
});

function harness() {
  const changes: CodexLimitContinueChange[] = [];
  const hostArmed: Array<[string, boolean]> = [];
  const active: boolean[] = [];
  let terminal: ContinuationTerminal | null = codexPane();
  let stop: CodexLimitStop = known();
  let fallback: LimitFallback = "none";
  const continueAt = vi.fn(
    async (_id: string, _stop: CodexLimitStopRef): Promise<CodexLimitContinueResult> => ({
      status: "continued",
      line: "continue",
    })
  );
  const deps: CodexLimitContinuationDeps = {
    now: () => Date.now(),
    readTerminal: async () => terminal,
    readStop: async () => stop,
    decideFallback: async () => fallback,
    continueAt,
    setHostArmed: (id, armed) => hostArmed.push([id, armed]),
    notify: (_projectId, change) => changes.push(change),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    onActiveChange: (value) => active.push(value),
  };
  const service = new CodexLimitContinuation(deps);
  return {
    service,
    changes,
    hostArmed,
    active,
    continueAt,
    setTerminal: (next: ContinuationTerminal | null) => (terminal = next),
    setStop: (next: CodexLimitStop) => (stop = next),
    setFallback: (next: LimitFallback) => (fallback = next),
    state: () => service.list(PROJECT)[0]?.state,
  };
}

describe("CodexLimitContinuation (#17909)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms a Codex pane before any limit, tells its host, and listens only while one is armed", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    expect(h.state()).toEqual({ status: "armed" });
    expect(h.hostArmed).toEqual([["t1", true]]);
    expect(h.active).toEqual([true]);

    await h.service.set("t1", false, PROJECT);
    expect(h.service.list(PROJECT)).toEqual([]);
    expect(h.hostArmed).toEqual([
      ["t1", true],
      ["t1", false],
    ]);
    expect(h.active).toEqual([true, false]);
    expect(h.changes.at(-1)).toMatchObject({ terminalId: "t1", state: null });
  });

  it("refuses a pane of another project, another agent, or the assistant's own", async () => {
    const h = harness();
    h.setTerminal(codexPane({ projectId: "elsewhere" }));
    await expect(h.service.set("t1", true, PROJECT)).rejects.toMatchObject({ code: "NOT_FOUND" });
    h.setTerminal(codexPane({ launchAgentId: "claude", detectedAgentId: "claude" }));
    await expect(h.service.set("t1", true, PROJECT)).rejects.toBeInstanceOf(
      CodexLimitContinuationError
    );
    h.setTerminal(codexPane({ isAssistantTerminal: true }));
    await expect(h.service.set("t1", true, PROJECT)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(h.active).toEqual([]);
  });

  it("waits until just after the reset, then has the host continue the stop once", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    await h.service.handleStop("t1", STOP);
    const continueAt = RESETS_AT + CONTINUE_AFTER_RESET_MS;
    expect(h.state()).toEqual({ status: "waiting", resetsAt: RESETS_AT, continueAt });

    await vi.advanceTimersByTimeAsync(continueAt - START - 1);
    expect(h.continueAt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.continueAt).toHaveBeenCalledTimes(1);
    expect(h.continueAt).toHaveBeenCalledWith("t1", STOP);
    expect(h.state()).toEqual({ status: "continued", at: expect.any(Number), line: "continue" });
  });

  it("judges a wait whose time passed in sleep once the host reads again, once", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    await h.service.handleStop("t1", STOP);
    // Asleep: the wall clock moves on, the timer doesn't.
    vi.setSystemTime(RESETS_AT + 6 * 60 * 60_000);
    h.service.handleWake();
    // The host still holds its terminals' reads just after a resume.
    await vi.advanceTimersByTimeAsync(WAKE_SETTLE_MS - 1);
    expect(h.continueAt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.continueAt).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(h.continueAt).toHaveBeenCalledTimes(1);
  });

  it("sets the timer again on wake, so a sleep before the reset doesn't delay it", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    await h.service.handleStop("t1", STOP);
    const continueAt = RESETS_AT + CONTINUE_AFTER_RESET_MS;
    // Slept 90 minutes of the wait: a timer that stopped counting would still
    // have nearly all of it to run.
    vi.setSystemTime(START + 90 * 60_000);
    h.service.handleWake();
    await vi.advanceTimersByTimeAsync(continueAt - Date.now());
    expect(h.continueAt).toHaveBeenCalledTimes(1);
  });

  it("asks again while the host holds the pane's output unread, without spending the reset", async () => {
    const h = harness();
    h.continueAt.mockResolvedValueOnce({ status: "skipped", reason: "reads-paused" });
    await h.service.set("t1", true, PROJECT);
    await h.service.handleStop("t1", STOP);
    await vi.advanceTimersByTimeAsync(RESETS_AT + CONTINUE_AFTER_RESET_MS - START);
    expect(h.continueAt).toHaveBeenCalledTimes(1);
    expect(h.state()).toMatchObject({ status: "waiting" });
    await vi.advanceTimersByTimeAsync(READS_PAUSED_RETRY_MS);
    expect(h.continueAt).toHaveBeenCalledTimes(2);
    expect(h.state()).toMatchObject({ status: "continued", line: "continue" });
  });

  it("records the host's reason when the pane wasn't where the limit left it", async () => {
    const h = harness();
    h.continueAt.mockResolvedValueOnce({ status: "skipped", reason: "input-since" });
    await h.service.set("t1", true, PROJECT);
    await h.service.handleStop("t1", STOP);
    await vi.advanceTimersByTimeAsync(RESETS_AT + CONTINUE_AFTER_RESET_MS - START);
    expect(h.state()).toEqual({ status: "skipped", at: expect.any(Number), reason: "input-since" });
  });

  it("falls back first, and never reads a fallback it couldn't decide as nothing left", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    h.setFallback("fallback");
    await h.service.handleStop("t1", STOP);
    expect(h.state()).toMatchObject({ status: "skipped", reason: "falls-back" });
    h.setFallback("unknown");
    await h.service.handleStop("t1", { ...STOP, seq: 2 });
    expect(h.state()).toMatchObject({ status: "skipped", reason: "fallback-undetermined" });
    await vi.runAllTimersAsync();
    expect(h.continueAt).not.toHaveBeenCalled();
  });

  it("schedules nothing when the reset can't be told, and says why", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    h.setStop({ reset: { status: "unknown", reason: "no-reset" }, stamp: null });
    await h.service.handleStop("t1", STOP);
    expect(h.state()).toMatchObject({ status: "skipped", reason: "no-reset" });
    await vi.runAllTimersAsync();
    expect(h.continueAt).not.toHaveBeenCalled();
  });

  it.each([
    ["a later sighting", { run: "run-a", seq: 2 }],
    ["another process's", { run: "run-b", seq: 1 }],
  ])("never times one stop by %s reset", async (_name, answered) => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    h.setStop(known(RESETS_AT, answered));
    await h.service.handleStop("t1", STOP);
    expect(h.state()).toMatchObject({ status: "skipped", reason: "banner-changed" });
  });

  it("fires a reset instant at most once; a later limit is a new wait", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    await h.service.handleStop("t1", STOP);
    await vi.advanceTimersByTimeAsync(RESETS_AT + CONTINUE_AFTER_RESET_MS - START);
    expect(h.continueAt).toHaveBeenCalledTimes(1);

    // The same instant again, from a new sighting: not continued twice.
    h.setStop(known(RESETS_AT, { run: "run-a", seq: 2 }));
    await h.service.handleStop("t1", { run: "run-a", seq: 2 });
    expect(h.state()).toMatchObject({ status: "skipped", reason: "already-continued" });

    const nextReset = Date.now() + 5 * 60 * 60_000;
    h.setStop(known(nextReset, { run: "run-a", seq: 3 }));
    await h.service.handleStop("t1", { run: "run-a", seq: 3 });
    expect(h.state()).toMatchObject({ status: "waiting", resetsAt: nextReset });
  });

  it("drops the wait when the process changes, keeping the pane armed for the next one", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    await h.service.handleStop("t1", STOP);
    h.service.handleSpawn("t1");
    expect(h.state()).toEqual({ status: "armed" });
    expect(h.hostArmed.at(-1)).toEqual(["t1", true]);
    await vi.runAllTimersAsync();
    expect(h.continueAt).not.toHaveBeenCalled();
  });

  it("keeps a wait when an earlier process's exit arrives late", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    await h.service.handleStop("t1", STOP);
    h.service.handleProcessChange("t1", 500);
    expect(h.state()).toMatchObject({ status: "waiting" });
    h.service.handleProcessChange("t1", 1_000);
    expect(h.state()).toEqual({ status: "armed" });
  });

  it("ignores a late exit of an earlier process while a stop is still being answered", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    h.service.handleSpawn("t1", 2_000);
    h.setTerminal(codexPane({ spawnedAt: 2_000 }));
    const handled = h.service.handleStop("t1", STOP);
    h.service.handleProcessChange("t1", 1_000);
    await handled;
    expect(h.state()).toMatchObject({ status: "waiting" });
  });

  it("disarms an id another project now runs under instead of continuing it", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    h.setTerminal(codexPane({ projectId: "other-project" }));
    await h.service.handleStop("t1", STOP);
    expect(h.service.list(PROJECT)).toEqual([]);
    expect(h.hostArmed.at(-1)).toEqual(["t1", false]);
    await vi.runAllTimersAsync();
    expect(h.continueAt).not.toHaveBeenCalled();
  });

  it("drops a stop answered after the process changed under it", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    let release!: (stop: CodexLimitStop) => void;
    h.setStop(known());
    const pending = new Promise<CodexLimitStop>((resolve) => (release = resolve));
    (h.service as unknown as { deps: CodexLimitContinuationDeps }).deps.readStop = () => pending;
    const handled = h.service.handleStop("t1", STOP);
    h.service.handleProcessChange("t1");
    release(known());
    await handled;
    expect(h.state()).toEqual({ status: "armed" });
    await vi.runAllTimersAsync();
    expect(h.continueAt).not.toHaveBeenCalled();
  });

  it("withdraws a replaced wait's time at once, and keeps it withdrawn if the pane is gone (#17911)", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    await h.service.handleStop("t1", STOP);
    expect(h.state()).toMatchObject({ status: "waiting" });
    const waitingRevision = h.changes.at(-1)!.revision;

    h.setTerminal(null);
    const handled = h.service.handleStop("t1", { run: "run-a", seq: 2 });
    expect(h.state()).toEqual({ status: "armed" });
    expect(h.changes.at(-1)).toMatchObject({ terminalId: "t1", state: { status: "armed" } });
    // Newer than the wait it withdraws, so a view takes it.
    expect(h.changes.at(-1)!.revision).toBeGreaterThan(waitingRevision);
    expect(vi.getTimerCount()).toBe(0);
    await handled;
    expect(h.state()).toEqual({ status: "armed" });
    await vi.runAllTimersAsync();
    expect(h.continueAt).not.toHaveBeenCalled();
  });

  it("drops a pending wait the moment the pane is disarmed", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    await h.service.handleStop("t1", STOP);
    await h.service.set("t1", false, PROJECT);
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(h.continueAt).not.toHaveBeenCalled();
  });

  it("never lets another project disarm a pane, or arm one", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    await h.service.handleStop("t1", STOP);
    await expect(h.service.set("t1", false, "other-project")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(h.service.set("t1", true, "other-project")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(h.state()).toMatchObject({ status: "waiting" });
  });

  it("arms nothing for a caller that stopped driving the project while the host answered", async () => {
    const h = harness();
    let driving = true;
    const arming = h.service.set("t1", true, PROJECT, () => driving);
    driving = false;
    await expect(arming).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    expect(h.service.list(PROJECT)).toEqual([]);
    expect(h.hostArmed).toEqual([]);
  });

  it("orders every push by revision, so a reloaded view can merge the list with them", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    await h.service.handleStop("t1", STOP);
    const revisions = h.changes.map((change) => change.revision);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(h.service.list(PROJECT)).toEqual([
      { terminalId: "t1", revision: revisions.at(-1), state: h.state() },
    ]);
    expect(h.service.list("other-project")).toEqual([]);
  });
});

describe("CodexLimitContinuation — a preset arms its panes (#17912)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const launch = (arms: boolean, launchGeneration = 1, projectId = PROJECT) => ({
    terminalId: "t1",
    projectId,
    launchGeneration,
    arms,
  });
  const confirmed = (launchGeneration = 1, spawnedAt = 2_000) => ({
    success: true,
    launchGeneration,
    spawnedAt,
  });

  it("arms a pane once the host confirms the launch its preset arms, and tells the host once", () => {
    const h = harness();
    h.service.noteLaunch(launch(true));
    expect(h.state()).toBeUndefined();
    expect(h.active).toEqual([true]);

    h.service.handleSpawnResult("t1", confirmed());
    expect(h.state()).toEqual({ status: "armed" });
    expect(h.hostArmed).toEqual([["t1", true]]);
  });

  it("arms nothing for a refused spawn or an earlier spawn's answer", () => {
    const h = harness();
    h.service.noteLaunch(launch(true, 2));
    h.service.handleSpawnResult("t1", confirmed(1));
    expect(h.state()).toBeUndefined();

    h.service.handleSpawnResult("t1", { success: false, launchGeneration: 2 });
    expect(h.state()).toBeUndefined();
    expect(h.hostArmed).toEqual([]);
    // The launch is settled either way, so nothing is left listening.
    expect(h.active).toEqual([true, false]);
  });

  it("drops a launch its host never confirms, and stops listening", () => {
    const h = harness();
    h.service.noteLaunch(launch(true));
    vi.advanceTimersByTime(LAUNCH_CONFIRMATION_MS);
    expect(h.active).toEqual([true, false]);
    h.service.handleSpawnResult("t1", confirmed());
    expect(h.state()).toBeUndefined();
  });

  it("keeps a live pane's wait when a second spawn under its id is refused", async () => {
    const h = harness();
    h.service.noteLaunch(launch(true));
    h.service.handleSpawnResult("t1", confirmed(1, 1_000));
    await h.service.handleStop("t1", STOP);
    const waiting = h.state();
    expect(waiting).toMatchObject({ status: "waiting" });

    h.service.noteLaunch(launch(false, 2));
    h.service.handleSpawnResult("t1", { success: false, launchGeneration: 2 });
    expect(h.state()).toEqual(waiting);
    expect(h.hostArmed).toEqual([["t1", true]]);
  });

  it("follows the preset at the next launch when nobody chose for the pane", () => {
    const h = harness();
    h.service.noteLaunch(launch(true));
    h.service.handleSpawnResult("t1", confirmed(1));

    // The preset was edited off, then the pane restarted.
    h.service.noteLaunch(launch(false, 2));
    h.service.handleSpawnResult("t1", confirmed(2));
    expect(h.state()).toBeUndefined();
    expect(h.hostArmed).toEqual([
      ["t1", true],
      ["t1", false],
    ]);
  });

  it("keeps the menu's off across later launches the preset arms", async () => {
    const h = harness();
    h.service.noteLaunch(launch(true));
    h.service.handleSpawnResult("t1", confirmed(1));
    await h.service.set("t1", false, PROJECT);

    h.service.noteLaunch(launch(true, 2));
    h.service.handleSpawnResult("t1", confirmed(2));
    expect(h.state()).toBeUndefined();
  });

  it("keeps the menu's off when it lands before the launch is confirmed", async () => {
    const h = harness();
    h.service.noteLaunch(launch(true));
    await h.service.set("t1", false, PROJECT);
    h.service.handleSpawnResult("t1", confirmed(1));
    expect(h.state()).toBeUndefined();
    expect(h.hostArmed).toEqual([]);
  });

  it("keeps the menu's on across later launches the preset doesn't arm", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);

    h.service.noteLaunch(launch(false, 2));
    h.service.handleSpawnResult("t1", confirmed(2, 3_000));
    expect(h.state()).toEqual({ status: "armed" });
    // As any respawn of an armed pane: the new process's host is told.
    expect(h.hostArmed).toEqual([
      ["t1", true],
      ["t1", true],
    ]);
  });

  it("takes the menu's on for a pane its preset armed as the pane's own choice", async () => {
    const h = harness();
    h.service.noteLaunch(launch(true));
    h.service.handleSpawnResult("t1", confirmed(1));
    await h.service.set("t1", true, PROJECT);

    h.service.noteLaunch(launch(false, 2));
    h.service.handleSpawnResult("t1", confirmed(2));
    expect(h.state()).toEqual({ status: "armed" });
  });

  it("ignores a choice made for the same id in another project", async () => {
    const h = harness();
    await h.service.set("t1", false, "elsewhere");
    h.service.noteLaunch(launch(true));
    h.service.handleSpawnResult("t1", confirmed(1));
    expect(h.state()).toEqual({ status: "armed" });
  });

  it("keeps this project's off when another project asks about the same id", async () => {
    const h = harness();
    h.service.noteLaunch(launch(true));
    h.service.handleSpawnResult("t1", confirmed(1));
    await h.service.set("t1", false, PROJECT);
    await h.service.set("t1", false, "elsewhere");

    h.service.noteLaunch(launch(true, 2));
    h.service.handleSpawnResult("t1", confirmed(2));
    expect(h.state()).toBeUndefined();
  });

  it("arms the running launch when a duplicate spawn queued behind it is refused", () => {
    const h = harness();
    h.service.noteLaunch(launch(true, 1));
    h.service.noteLaunch(launch(true, 2));
    h.service.handleSpawnResult("t1", confirmed(1));
    h.service.handleSpawnResult("t1", { success: false, launchGeneration: 2 });
    expect(h.state()).toEqual({ status: "armed" });
    expect(h.hostArmed).toEqual([["t1", true]]);
    expect(h.active).toEqual([true]);
  });

  it("takes a crash replay's answer, under a newer generation, for the launch it resent", () => {
    const h = harness();
    h.service.noteLaunch(launch(true, 1));
    h.service.handleSpawnResult("t1", confirmed(3));
    expect(h.state()).toEqual({ status: "armed" });
    expect(h.active).toEqual([true]);
  });

  it("keeps a later launch's wait when an earlier spawn's answer arrives after it", async () => {
    const h = harness();
    h.service.noteLaunch(launch(true, 2));
    h.service.handleSpawnResult("t1", confirmed(2, 2_000));
    h.setTerminal(codexPane({ spawnedAt: 2_000 }));
    await h.service.handleStop("t1", STOP);
    const waiting = h.state();
    expect(waiting).toMatchObject({ status: "waiting" });

    h.service.handleSpawnResult("t1", confirmed(1, 1_000));
    expect(h.state()).toEqual(waiting);
    expect(h.hostArmed).toEqual([["t1", true]]);
    // The wait is still the one the later process's exit ends.
    h.service.handleProcessChange("t1", 2_000);
    expect(h.state()).toEqual({ status: "armed" });
  });

  it("keeps another project's choice for the same id when a project is removed", async () => {
    const h = harness();
    await h.service.set("t1", false, "elsewhere");
    h.service.noteLaunch(launch(true));
    h.service.handleSpawnResult("t1", confirmed(1));
    h.service.forgetProject(PROJECT);

    h.service.noteLaunch(launch(true, 2, "elsewhere"));
    h.service.handleSpawnResult("t1", confirmed(2));
    expect(h.service.isArmed("t1")).toBe(false);
  });

  it("ignores an earlier spawn's late answer for a pane armed from its menu", async () => {
    const h = harness();
    h.setTerminal(codexPane({ spawnedAt: 2_000, launchGeneration: 2 }));
    await h.service.set("t1", true, PROJECT);
    await h.service.handleStop("t1", STOP);
    const waiting = h.state();
    expect(waiting).toMatchObject({ status: "waiting" });

    h.service.handleSpawnResult("t1", confirmed(1, 1_000));
    expect(h.state()).toEqual(waiting);
  });

  it("forgets a removed project's panes and choices, and no other project's", async () => {
    const h = harness();
    h.service.noteLaunch(launch(true));
    h.service.handleSpawnResult("t1", confirmed(1));
    await h.service.set("t2", false, PROJECT);
    await h.service.set("t2", false, "elsewhere");
    h.service.noteLaunch({ ...launch(true, 4), terminalId: "t3" });

    h.service.forgetProject(PROJECT);
    expect(h.service.list(PROJECT)).toEqual([]);
    expect(h.active).toEqual([true, false]);

    // The other project's off for t2 still stands there.
    h.service.noteLaunch({ ...launch(true, 5, "elsewhere"), terminalId: "t2" });
    h.service.handleSpawnResult("t2", confirmed(5));
    expect(h.service.list("elsewhere")).toEqual([]);
    // t3's launch went with its project.
    h.service.handleSpawnResult("t3", confirmed(4));
    expect(h.service.isArmed("t3")).toBe(false);
  });

  it("forgets a pane closed for good, so a new pane under its id follows its own preset", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    h.service.forgetPane("t1");
    expect(h.state()).toBeUndefined();
    expect(h.active).toEqual([true, false]);

    h.service.noteLaunch(launch(false, 2));
    h.service.handleSpawnResult("t1", confirmed(2));
    expect(h.state()).toBeUndefined();
  });

  it("drops an arm still waiting on its host read when the pane is closed for good", async () => {
    const h = harness();
    let answer: (value: ContinuationTerminal | null) => void = () => {};
    const service = new CodexLimitContinuation({
      now: () => Date.now(),
      readTerminal: () => new Promise((resolve) => (answer = resolve)),
      readStop: async () => known(),
      decideFallback: async () => "none",
      continueAt: async () => ({ status: "continued", line: "continue" }),
      setHostArmed: (id, armed) => h.hostArmed.push([id, armed]),
      notify: () => {},
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      onActiveChange: () => {},
    });
    const arming = service.set("t1", true, PROJECT);
    service.forgetPane("t1");
    answer(codexPane());
    await arming;
    expect(service.isArmed("t1")).toBe(false);
    expect(h.hostArmed).toEqual([]);
  });
});
