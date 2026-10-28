import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceHostEvent,
  WorktreeSetupStepDescriptor,
} from "../../../shared/types/workspace-host.js";
import { RUN_ANSWER_GRACE_MS, WorktreeSetupBridge } from "../worktreeSetupBridge.js";

const STEP: WorktreeSetupStepDescriptor = {
  pluginId: "acme",
  pluginName: "Acme",
  pluginVersion: "1.0.0",
  stepId: "db",
  label: "Provision DB",
  timeoutMs: 10_000,
};
const TARGET = { worktreeId: "/repo/wt", worktreePath: "/repo/wt", branch: null };

function lastRequestId(events: WorkspaceHostEvent[]): string {
  const event = events.at(-1);
  if (!event || !("setupRequestId" in event)) throw new Error("no setup event sent");
  return event.setupRequestId;
}

describe("WorktreeSetupBridge", () => {
  let events: WorkspaceHostEvent[];
  let bridge: WorktreeSetupBridge;

  beforeEach(() => {
    events = [];
    bridge = new WorktreeSetupBridge((event) => events.push(event));
  });

  afterEach(() => {
    bridge.dispose();
    vi.useRealTimers();
  });

  it("settles a list with the answer correlated to it", async () => {
    const listed = bridge.listSteps();
    expect(events.at(-1)?.type).toBe("worktree-setup:list");

    bridge.handleResult({ setupRequestId: lastRequestId(events), ok: true, value: [STEP] });

    await expect(listed).resolves.toEqual([STEP]);
  });

  it("rejects with main's error", async () => {
    const listed = bridge.listSteps();
    bridge.handleResult({ setupRequestId: lastRequestId(events), ok: false, error: "boom" });
    await expect(listed).rejects.toThrow("boom");
  });

  it("sends the step and its worktree, and resolves with the outcome", async () => {
    const run = bridge.runStep(STEP, TARGET);
    expect(events.at(-1)).toMatchObject({ type: "worktree-setup:run", step: STEP, target: TARGET });

    bridge.handleResult({
      setupRequestId: lastRequestId(events),
      ok: true,
      value: { state: "failed", error: "quota exceeded" },
    });

    await expect(run).resolves.toEqual({ state: "failed", error: "quota exceeded" });
  });

  it("does not coalesce two identical runs: each is its own request", () => {
    void bridge.runStep(STEP, TARGET).catch(() => undefined);
    void bridge.runStep(STEP, TARGET).catch(() => undefined);
    const runs = events.filter((event) => event.type === "worktree-setup:run");
    expect(runs).toHaveLength(2);
    expect(
      new Set(runs.map((event) => "setupRequestId" in event && event.setupRequestId)).size
    ).toBe(2);
  });

  it("cancels in main and rejects when its signal aborts", async () => {
    const controller = new AbortController();
    const run = bridge.runStep(STEP, TARGET, controller.signal);
    const id = lastRequestId(events);

    controller.abort();

    await expect(run).rejects.toThrow("Cancelled");
    expect(events.at(-1)).toEqual({ type: "worktree-setup:cancel", setupRequestId: id });
    // A late answer finds nothing to settle.
    bridge.handleResult({ setupRequestId: id, ok: true, value: { state: "succeeded" } });
  });

  it("gives up, and cancels in main, when main outlasts the step's own timeout", async () => {
    vi.useFakeTimers();
    const run = bridge.runStep(STEP, TARGET);
    const id = lastRequestId(events);
    const settled = expect(run).rejects.toThrow("No answer");

    await vi.advanceTimersByTimeAsync(STEP.timeoutMs);
    expect(events.at(-1)?.type).toBe("worktree-setup:run");
    await vi.advanceTimersByTimeAsync(RUN_ANSWER_GRACE_MS);

    await settled;
    expect(events.at(-1)).toEqual({ type: "worktree-setup:cancel", setupRequestId: id });
  });

  it("rejects everything still pending on dispose", async () => {
    const listed = bridge.listSteps();
    bridge.dispose();
    await expect(listed).rejects.toThrow("disposed");
  });
});
