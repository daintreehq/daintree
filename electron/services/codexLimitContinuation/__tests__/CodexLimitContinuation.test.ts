import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodexLimitContinueChange,
  CodexLimitContinueResult,
  CodexLimitStopRef,
} from "../../../../shared/types/codexLimitContinuation.js";
import type { CodexLimitStop } from "../../codex/CodexLimitReset.js";
import {
  CONTINUE_AFTER_RESET_MS,
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

  it("judges a wait whose time passed in sleep on wake, once, though its timer fires too", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    await h.service.handleStop("t1", STOP);
    // Asleep: the wall clock moves on, the timer doesn't.
    vi.setSystemTime(RESETS_AT + 6 * 60 * 60_000);
    h.service.checkDue();
    await vi.advanceTimersByTimeAsync(RESETS_AT + CONTINUE_AFTER_RESET_MS);
    expect(h.continueAt).toHaveBeenCalledTimes(1);
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

  it("never times one stop by another's reset", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    h.setStop(known(RESETS_AT, { run: "run-a", seq: 2 }));
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

  it("drops a pending wait the moment the pane is disarmed", async () => {
    const h = harness();
    await h.service.set("t1", true, PROJECT);
    await h.service.handleStop("t1", STOP);
    await h.service.set("t1", false, PROJECT);
    await vi.runAllTimersAsync();
    expect(h.continueAt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
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
