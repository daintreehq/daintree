import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodexLimitContinueChange,
  CodexLimitContinueResult,
  CodexLimitStopRef,
} from "../../../../shared/types/codexLimitContinuation.js";
import type { CodexLimitCheckpoint } from "../../../../shared/types/codexLimitReset.js";
import type { CodexLimitStop } from "../../codex/CodexLimitReset.js";
import {
  CONTINUE_AFTER_RESET_MS,
  LAUNCH_CONFIRMATION_MS,
  READS_PAUSED_RETRY_MS,
  RESTORE_BIND_MS,
  WAKE_SETTLE_MS,
  CodexLimitContinuation,
  CodexLimitContinuationError,
  type CodexLimitContinuationDeps,
  type ContinuationTerminal,
  type ContinuationTurn,
} from "../CodexLimitContinuation.js";
import { ContinuationStore, type ContinuationStoreBackend } from "../ContinuationStore.js";
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
  agentSessionId: "session-1",
  ...extra,
});

/** One userData file, shared by the services standing in for two runs of the app. */
function memoryBackend(): ContinuationStoreBackend & { data: string | null } {
  const backend = {
    data: null as string | null,
    read: async () => backend.data,
    write: async (next: string) => {
      backend.data = next;
    },
  };
  return backend;
}

const IDENTITY = "banner-digest";

const known = (resetsAt = RESETS_AT, stamp = STOP): CodexLimitStop => ({
  reset: { status: "known", resetsAt, precision: "second", source: "quota", observedAt: START },
  stamp: { ...stamp, observedAt: START, identity: IDENTITY },
});

function harness(backend: ContinuationStoreBackend | null = null) {
  const changes: CodexLimitContinueChange[] = [];
  const hostArmed: Array<[string, boolean] | [string, boolean, string | null]> = [];
  const store = new ContinuationStore(backend, () => Date.now());
  void store.ready();
  // What a pane still at STOP answers as Daintree quits.
  let checkpoint: CodexLimitCheckpoint | null | undefined = {
    kind: "stop",
    ...STOP,
    identity: IDENTITY,
  };
  let turn: ContinuationTurn | undefined;
  let quitting = false;
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
    setHostArmed: (id, armed, restoreIdentity) =>
      hostArmed.push(restoreIdentity === undefined ? [id, armed] : [id, armed, restoreIdentity]),
    notify: (_projectId, change) => changes.push(change),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    onActiveChange: (value) => active.push(value),
    store,
    readCheckpoint: async () => checkpoint,
    readTurn: async () => turn,
    isQuitting: () => quitting,
  };
  const service = new CodexLimitContinuation(deps);
  return {
    service,
    store,
    changes,
    hostArmed,
    active,
    continueAt,
    setCheckpoint: (next: CodexLimitCheckpoint | null | undefined) => (checkpoint = next),
    setTurn: (next: ContinuationTurn | undefined) => (turn = next),
    setQuitting: (next: boolean) => (quitting = next),
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
    h.setTerminal(codexPane({ launchAgentId: "gemini", detectedAgentId: "gemini" }));
    await expect(h.service.set("t1", true, PROJECT)).rejects.toBeInstanceOf(
      CodexLimitContinuationError
    );
    h.setTerminal(codexPane({ isAssistantTerminal: true }));
    await expect(h.service.set("t1", true, PROJECT)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(h.active).toEqual([]);
  });

  it("arms a Claude Code pane too, ahead of any limit (#18192)", async () => {
    const h = harness();
    h.setTerminal(codexPane({ launchAgentId: "claude", detectedAgentId: "claude" }));
    await h.service.set("t1", true, PROJECT);
    expect(h.state()).toEqual({ status: "armed" });
    expect(h.hostArmed).toEqual([["t1", true]]);
  });

  const claudePane = () => codexPane({ launchAgentId: "claude", detectedAgentId: "claude" });
  const bannerReset = (resetsAt = RESETS_AT) =>
    ({
      status: "known",
      resetsAt,
      precision: "minute",
      source: "banner",
      observedAt: START,
    }) as const;

  it.each(["auto-continue-cancelled"] as const)(
    "records a Claude stop its user took over (%s) at once, with no wait and nothing typed (#18192)",
    async (skipAtStop) => {
      const h = harness();
      h.setTerminal(claudePane());
      await h.service.set("t1", true, PROJECT);
      h.setStop({ reset: bannerReset(), stamp: { ...STOP, observedAt: START }, skipAtStop });
      await h.service.handleStop("t1", STOP);
      expect(h.state()).toEqual({ status: "skipped", at: expect.any(Number), reason: skipAtStop });
      await vi.advanceTimersByTimeAsync(RESETS_AT - START + 10 * 60_000);
      expect(h.continueAt).not.toHaveBeenCalled();
    }
  );

  it("names a person's cancellation ahead of a reset it couldn't read (#18192)", async () => {
    const h = harness();
    h.setTerminal(claudePane());
    await h.service.set("t1", true, PROJECT);
    h.setStop({
      reset: { status: "unknown", reason: "unreadable-time" },
      stamp: { ...STOP, observedAt: START },
      skipAtStop: "auto-continue-cancelled",
    });
    await h.service.handleStop("t1", STOP);
    expect(h.state()).toMatchObject({ status: "skipped", reason: "auto-continue-cancelled" });
  });

  it.each([
    ["falls back", "fallback", "falls-back"],
    ["can't tell whether it falls back", "unknown", "fallback-undetermined"],
  ] as const)(
    "puts a preset that %s ahead of a stop its user took over (#18192)",
    async (_label, fallback, reason) => {
      const h = harness();
      h.setTerminal(claudePane());
      await h.service.set("t1", true, PROJECT);
      h.setStop({
        reset: bannerReset(),
        stamp: { ...STOP, observedAt: START },
        skipAtStop: "auto-continue-cancelled",
      });
      h.setFallback(fallback);
      await h.service.handleStop("t1", STOP);
      expect(h.state()).toMatchObject({ status: "skipped", reason });
    }
  );

  it.each([
    ["another sighting", { run: "run-a", seq: 2 }],
    ["another process's sighting under the same number", { run: "run-b", seq: 1 }],
  ])("never lets a verdict on %s skip this one (#18192)", async (_label, stamp) => {
    const h = harness();
    h.setTerminal(claudePane());
    await h.service.set("t1", true, PROJECT);
    h.setStop({
      reset: bannerReset(),
      stamp: { ...stamp, observedAt: START },
      skipAtStop: "auto-continue-cancelled",
    });
    await h.service.handleStop("t1", STOP);
    // The answer is about another sighting, so the check that follows decides.
    expect(h.state()).toMatchObject({ status: "skipped", reason: "banner-changed" });
  });

  it("waits out a Claude stop of its own from the banner's reset (#18192)", async () => {
    const h = harness();
    h.setTerminal(claudePane());
    await h.service.set("t1", true, PROJECT);
    h.setStop({ reset: bannerReset(), stamp: { ...STOP, observedAt: START } });
    await h.service.handleStop("t1", STOP);
    expect(h.state()).toMatchObject({ status: "waiting", resetsAt: RESETS_AT });
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

  it("never gives a newer spawn that decides nothing an older launch's default", () => {
    const h = harness();
    h.service.noteLaunch(launch(true, 1));
    // A shell queued under the same id after it; only the shell is sent.
    h.service.noteSpawn("t1", PROJECT, 2);
    h.service.handleSpawnResult("t1", confirmed(2));
    expect(h.service.isArmed("t1")).toBe(false);
    expect(h.active).toEqual([true, false]);
  });

  it("still arms the running launch when a shell queued behind it is refused", () => {
    const h = harness();
    h.service.noteLaunch(launch(true, 1));
    h.service.noteSpawn("t1", PROJECT, 2);
    h.service.handleSpawnResult("t1", confirmed(1));
    h.service.handleSpawnResult("t1", { success: false, launchGeneration: 2 });
    expect(h.state()).toEqual({ status: "armed" });
  });

  it("notes no other spawn for an id no launch awaits", () => {
    const h = harness();
    h.service.noteSpawn("t1", PROJECT, 1);
    expect(h.active).toEqual([]);
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
      store: h.store,
      readCheckpoint: async () => null,
      readTurn: async () => undefined,
      isQuitting: () => false,
    });
    const arming = service.set("t1", true, PROJECT);
    service.forgetPane("t1");
    answer(codexPane());
    await arming;
    expect(service.isArmed("t1")).toBe(false);
    expect(h.hostArmed).toEqual([]);
  });
});

describe("CodexLimitContinuation — across a cold restart (#18193)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const RESTORED: CodexLimitStopRef = { run: "run-restored", seq: 1 };
  const claudePane = () => codexPane({ launchAgentId: "claude", detectedAgentId: "claude" });

  /** The first run: a pane armed from its menu, stopped and waiting when Daintree quits. */
  async function quitWhileWaiting(terminal: ContinuationTerminal, turn?: ContinuationTurn) {
    const backend = memoryBackend();
    const before = harness(backend);
    before.setTerminal(terminal);
    before.setTurn(turn);
    await before.service.set("t1", true, PROJECT);
    await before.service.handleStop("t1", STOP);
    expect(before.state()).toMatchObject({ status: "waiting", resetsAt: RESETS_AT });
    await quit(before);
    return backend;
  }

  async function quit(run: ReturnType<typeof harness>) {
    await run.service.checkpointForQuit();
    // Then the quit's own teardown ends the process.
    run.setQuitting(true);
    run.service.handleProcessChange("t1");
    run.service.dispose();
  }

  /** The next run: the pane restored on the conversation it had. */
  async function restore(
    backend: ContinuationStoreBackend,
    terminal: ContinuationTerminal,
    resume: { sessionId?: string; startsFresh?: boolean } = {}
  ) {
    const after = harness(backend);
    after.setTerminal(terminal);
    await after.store.ready();
    after.service.noteLaunch({
      terminalId: "t1",
      projectId: PROJECT,
      launchGeneration: 1,
      arms: false,
      restore: {
        agentId: terminal.launchAgentId!,
        sessionId: "sessionId" in resume ? resume.sessionId : "session-1",
        startsFresh: resume.startsFresh ?? false,
      },
    });
    after.service.handleSpawnResult("t1", { success: true, launchGeneration: 1, spawnedAt: 5_000 });
    return after;
  }

  /** The restored process redraws the saved stop; what its banner reads as now is no substitute. */
  async function redraw(after: ReturnType<typeof harness>) {
    after.setStop({
      reset: { status: "unknown", reason: "unreadable-time" },
      stamp: { ...RESTORED, observedAt: Date.now(), identity: IDENTITY },
      restored: true,
    });
    await after.service.handleStop("t1", RESTORED);
  }

  it.each([
    ["Codex", codexPane],
    ["Claude Code", claudePane],
  ])(
    "continues a restored %s pane once at the saved reset, never at a re-read one",
    async (_agent, pane) => {
      const backend = await quitWhileWaiting(pane());
      const after = await restore(backend, pane());
      const continueAt = RESETS_AT + CONTINUE_AFTER_RESET_MS;
      // Armed as it was, waiting at the saved reset, and its host told what to look for.
      expect(after.state()).toEqual({ status: "waiting", resetsAt: RESETS_AT, continueAt });
      expect(after.hostArmed).toContainEqual(["t1", true, IDENTITY]);

      await redraw(after);
      expect(after.state()).toEqual({ status: "waiting", resetsAt: RESETS_AT, continueAt });
      await vi.advanceTimersByTimeAsync(continueAt - Date.now() - 1);
      expect(after.continueAt).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(after.continueAt).toHaveBeenCalledTimes(1);
      expect(after.continueAt).toHaveBeenCalledWith("t1", RESTORED);
      expect(after.state()).toMatchObject({ status: "continued", line: "continue" });
    }
  );

  it.each([
    ["Codex", codexPane],
    ["Claude Code", claudePane],
  ])(
    "continues a restored %s pane whose reset passed while closed, once its redraw settles",
    async (_agent, pane) => {
      const backend = await quitWhileWaiting(pane());
      vi.setSystemTime(RESETS_AT + 8 * 60 * 60_000);
      const after = await restore(backend, pane());
      expect(after.state()).toMatchObject({ status: "waiting", resetsAt: RESETS_AT });
      // Overdue, but nothing is typed into a pane whose resumed agent hasn't shown the stop.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(after.continueAt).not.toHaveBeenCalled();

      await redraw(after);
      expect(after.continueAt).toHaveBeenCalledTimes(1);
      expect(after.continueAt).toHaveBeenCalledWith("t1", RESTORED);
      await vi.runAllTimersAsync();
      expect(after.continueAt).toHaveBeenCalledTimes(1);
    }
  );

  it("records the host's reason when the restored pane took input since its restore", async () => {
    const backend = await quitWhileWaiting(codexPane());
    vi.setSystemTime(RESETS_AT + 60 * 60_000);
    const after = await restore(backend, codexPane());
    after.continueAt.mockResolvedValueOnce({ status: "skipped", reason: "input-since" });
    await redraw(after);
    expect(after.state()).toMatchObject({ status: "skipped", reason: "input-since" });
  });

  it("skips a restored Claude pane whose conversation took a newer turn, typing nothing", async () => {
    const backend = await quitWhileWaiting(claudePane(), { uuid: "limit-entry", apiError: true });
    const after = await restore(backend, claudePane());
    // Resumed elsewhere while Daintree was closed, and limited again in the same words.
    after.setTurn({ uuid: "newer-entry", apiError: true });
    await redraw(after);
    expect(after.state()).toMatchObject({ status: "skipped", reason: "banner-not-last" });
    expect(after.hostArmed.at(-1)).toEqual(["t1", true, null]);
    await vi.runAllTimersAsync();
    expect(after.continueAt).not.toHaveBeenCalled();
  });

  it("binds a restored Claude pane whose conversation still ends on the saved limit", async () => {
    const backend = await quitWhileWaiting(claudePane(), { uuid: "limit-entry", apiError: true });
    const after = await restore(backend, claudePane());
    after.setTurn({ uuid: "limit-entry", apiError: true });
    await redraw(after);
    await vi.advanceTimersByTimeAsync(RESETS_AT + CONTINUE_AFTER_RESET_MS - START);
    expect(after.continueAt).toHaveBeenCalledTimes(1);
  });

  it("gives up a restored wait whose agent never redraws the stop, saying why", async () => {
    const backend = await quitWhileWaiting(codexPane());
    const after = await restore(backend, codexPane());
    after.setStop({ reset: { status: "unknown", reason: "no-banner" }, stamp: null });
    await vi.advanceTimersByTimeAsync(RESTORE_BIND_MS);
    expect(after.state()).toMatchObject({ status: "skipped", reason: "banner-gone" });
    expect(after.hostArmed.at(-1)).toEqual(["t1", true, null]);
    await vi.runAllTimersAsync();
    expect(after.continueAt).not.toHaveBeenCalled();
  });

  it("drops the saved stop when a stop of the restored pane's own comes first", async () => {
    const backend = await quitWhileWaiting(codexPane());
    const after = await restore(backend, codexPane());
    const nextReset = RESETS_AT + 24 * 60 * 60_000;
    after.setStop(known(nextReset, RESTORED));
    await after.service.handleStop("t1", RESTORED);
    expect(after.state()).toMatchObject({ status: "waiting", resetsAt: nextReset });
  });

  it.each([
    ["starts a fresh conversation", { startsFresh: true }],
    ["resumes another conversation", { sessionId: "session-2" }],
    ["resumes no named conversation", { sessionId: undefined }],
  ])("skips a restore that %s, keeping the pane armed", async (_label, resume) => {
    const backend = await quitWhileWaiting(codexPane());
    const after = await restore(backend, codexPane(), resume);
    expect(after.state()).toMatchObject({ status: "skipped", reason: "process-changed" });
    await vi.runAllTimersAsync();
    expect(after.continueAt).not.toHaveBeenCalled();
  });

  it("never continues again a reset continued before the quit", async () => {
    const backend = memoryBackend();
    const before = harness(backend);
    await before.service.set("t1", true, PROJECT);
    await before.service.handleStop("t1", STOP);
    // The line is on its way as Daintree quits: its answer never comes.
    before.continueAt.mockImplementationOnce(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(RESETS_AT + CONTINUE_AFTER_RESET_MS - START);
    expect(before.continueAt).toHaveBeenCalledTimes(1);
    await quit(before);

    const after = await restore(backend, codexPane());
    expect(after.state()).toMatchObject({ status: "skipped", reason: "already-continued" });
    await redraw(after);
    await vi.runAllTimersAsync();
    expect(after.continueAt).not.toHaveBeenCalled();
  });

  it("keeps a reset owed when the host held the pane's output unread as Daintree quit", async () => {
    const backend = memoryBackend();
    const before = harness(backend);
    before.continueAt.mockResolvedValueOnce({ status: "skipped", reason: "reads-paused" });
    await before.service.set("t1", true, PROJECT);
    await before.service.handleStop("t1", STOP);
    await vi.advanceTimersByTimeAsync(RESETS_AT + CONTINUE_AFTER_RESET_MS - START);
    expect(before.state()).toMatchObject({ status: "waiting" });
    await quit(before);

    const after = await restore(backend, codexPane());
    await redraw(after);
    expect(after.continueAt).toHaveBeenCalledTimes(1);
  });

  it("forgets the saved stop when the process ends outside a quit", async () => {
    const backend = memoryBackend();
    const before = harness(backend);
    await before.service.set("t1", true, PROJECT);
    await before.service.handleStop("t1", STOP);
    before.service.handleProcessChange("t1");
    await quit(before);

    const after = await restore(backend, codexPane());
    expect(after.state()).toEqual({ status: "armed" });
  });

  it("keeps the saved stop when the quit's teardown ends the process before the checkpoint", async () => {
    const backend = memoryBackend();
    const before = harness(backend);
    await before.service.set("t1", true, PROJECT);
    await before.service.handleStop("t1", STOP);
    before.setQuitting(true);
    before.service.handleProcessChange("t1");
    await before.store.flush();
    before.service.dispose();

    const after = await restore(backend, codexPane());
    expect(after.state()).toMatchObject({ status: "waiting", resetsAt: RESETS_AT });
  });

  it("revives a saved stop only for the first restore of its pane in a run", async () => {
    const backend = await quitWhileWaiting(codexPane());
    const after = await restore(backend, codexPane());
    after.service.handleSpawn("t1", 6_000);
    after.service.noteLaunch({
      terminalId: "t1",
      projectId: PROJECT,
      launchGeneration: 2,
      arms: false,
      restore: { agentId: "codex", sessionId: "session-1", startsFresh: false },
    });
    after.service.handleSpawnResult("t1", { success: true, launchGeneration: 2, spawnedAt: 7_000 });
    expect(after.state()).toEqual({ status: "armed" });
  });

  describe("as Daintree quits", () => {
    it("saves Claude Code's own wait from the pane's sighting, and continues it after the restore", async () => {
      const backend = memoryBackend();
      const before = harness(backend);
      before.setTerminal(claudePane());
      before.setTurn({ uuid: "limit-entry", apiError: true });
      await before.service.set("t1", true, PROJECT);
      // Claude's own countdown is on screen: nothing is pending on Daintree's side.
      before.setCheckpoint({ kind: "own-wait", identity: IDENTITY, resetsAt: RESETS_AT });
      await quit(before);

      const after = await restore(backend, claudePane());
      after.setTurn({ uuid: "limit-entry", apiError: true });
      expect(after.state()).toMatchObject({ status: "waiting", resetsAt: RESETS_AT });
      await redraw(after);
      await vi.advanceTimersByTimeAsync(RESETS_AT + CONTINUE_AFTER_RESET_MS - START);
      expect(after.continueAt).toHaveBeenCalledTimes(1);
    });

    it("drops a saved stop the pane no longer holds untouched", async () => {
      const backend = memoryBackend();
      const before = harness(backend);
      await before.service.set("t1", true, PROJECT);
      await before.service.handleStop("t1", STOP);
      // Input or a dialog since the stop: its host answers that it holds none.
      before.setCheckpoint(null);
      await quit(before);

      const after = await restore(backend, codexPane());
      expect(after.state()).toEqual({ status: "armed" });
    });

    it("keeps a saved stop when the pane's host doesn't answer", async () => {
      const backend = memoryBackend();
      const before = harness(backend);
      await before.service.set("t1", true, PROJECT);
      await before.service.handleStop("t1", STOP);
      before.setCheckpoint(undefined);
      await quit(before);

      const after = await restore(backend, codexPane());
      expect(after.state()).toMatchObject({ status: "waiting", resetsAt: RESETS_AT });
    });

    it("types nothing once the quit has begun", async () => {
      const h = harness(memoryBackend());
      await h.service.set("t1", true, PROJECT);
      await h.service.handleStop("t1", STOP);
      await h.service.checkpointForQuit();
      await vi.advanceTimersByTimeAsync(RESETS_AT + CONTINUE_AFTER_RESET_MS - START);
      expect(h.continueAt).not.toHaveBeenCalled();
    });
  });

  describe("menu choices", () => {
    it("arms a pane restored without a preset that arms it, as its menu left it", async () => {
      const backend = memoryBackend();
      const before = harness(backend);
      await before.service.set("t1", true, PROJECT);
      await quit(before);

      const after = await restore(backend, codexPane());
      expect(after.state()).toEqual({ status: "armed" });
      expect(after.hostArmed[0]).toEqual(["t1", true]);
    });

    it("leaves a pane its menu disarmed unarmed, whatever its preset says", async () => {
      const backend = memoryBackend();
      const before = harness(backend);
      before.service.noteLaunch({
        terminalId: "t1",
        projectId: PROJECT,
        launchGeneration: 1,
        arms: true,
      });
      before.service.handleSpawnResult("t1", {
        success: true,
        launchGeneration: 1,
        spawnedAt: 2_000,
      });
      await before.service.set("t1", false, PROJECT);
      await quit(before);

      const after = harness(backend);
      await after.store.ready();
      after.service.noteLaunch({
        terminalId: "t1",
        projectId: PROJECT,
        launchGeneration: 1,
        arms: true,
      });
      after.service.handleSpawnResult("t1", {
        success: true,
        launchGeneration: 1,
        spawnedAt: 5_000,
      });
      expect(after.service.isArmed("t1")).toBe(false);
    });
  });
});
