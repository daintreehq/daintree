import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  pid: number | undefined = 60_000;
  posted: unknown[] = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }
}

const state = vi.hoisted(() => ({ children: [] as unknown[] }));

vi.mock("electron", () => ({
  utilityProcess: {
    fork: () => {
      const child = new FakeChild();
      state.children.push(child);
      return child;
    },
  },
}));

vi.mock("../../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../../processTerminationIntent.js", () => ({
  noteTerminationIntent: vi.fn(),
}));

type ReaderModule = typeof import("../canopyReaderProcess.js");

let readerModule: ReaderModule;

function spawn() {
  const reader = new readerModule.CanopyReaderProcess("/models/reader", vi.fn());
  return { reader, child: state.children.at(-1) as FakeChild };
}

beforeEach(async () => {
  state.children.length = 0;
  vi.resetModules();
  readerModule = await import("../canopyReaderProcess.js");
  // Fake pids must never reach the OS.
  vi.spyOn(process, "kill").mockImplementation(() => true);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("waitForRetiringReaders", () => {
  it("returns at once when nothing is retiring", async () => {
    await expect(readerModule.waitForRetiringReaders(1_000)).resolves.toBe(0);
  });

  it("ignores a live reader nobody retired", async () => {
    spawn();
    await expect(readerModule.waitForRetiringReaders(1_000)).resolves.toBe(0);
  });

  it("settles as soon as every retiring reader has exited", async () => {
    const first = spawn();
    const second = spawn();
    first.reader.retire();
    second.reader.retire();
    expect(first.child.posted).toContainEqual({ type: "destroy" });

    let settled: number | undefined;
    void readerModule.waitForRetiringReaders(1_000).then((pending) => {
      settled = pending;
    });
    first.child.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBeUndefined();
    second.child.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(0);
    // The budget timer goes with the wait, as do each reader's own timers.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up at the budget and reports what is still draining", async () => {
    const drained = spawn();
    const stuck = spawn();
    drained.reader.retire();
    stuck.reader.retire();
    let settled: number | undefined;
    void readerModule.waitForRetiringReaders(400).then((pending) => {
      settled = pending;
    });
    drained.child.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(399);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(1);
    expect(process.kill).not.toHaveBeenCalled();
  });
});

describe("an idle local reader's process", () => {
  it("is still waited for at quit once the local reader has let it go (#16816)", async () => {
    const { CanopyLocalReader } = await import("../canopyLocalReader.js");
    const IDLE_MS = 1_000;
    const local = new CanopyLocalReader(async () => "/models/reader", undefined, IDLE_MS);
    const read = local.read(
      {
        agent: "claude",
        title: "",
        screen: "",
        lines: ["$ "],
        observed: { agentState: null, waitingReason: null, secondsInState: null },
      },
      new AbortController().signal
    );
    await vi.advanceTimersByTimeAsync(0);
    const child = state.children.at(-1) as FakeChild;
    child.emit("message", { type: "ready" });
    await vi.advanceTimersByTimeAsync(0);
    const asked = child.posted.find(
      (m): m is { type: "read"; id: number } => (m as { type: string }).type === "read"
    )!;
    child.emit("message", {
      type: "reading",
      id: asked.id,
      ms: 9,
      reading: {
        category: "idle",
        category_probs: [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.94],
        needs_attention: 0.1,
        needs_attention_raw: 0.1,
        blocked_on_user: 0.05,
        notable: 0.1,
        question_line: -1,
        status_line: -1,
        action_line: -1,
        task_line: -1,
        summary_lines: [],
        card_lines: [],
        card_mode: "summary",
        option_lines: [],
        tests: "unknown",
        changes: "unknown",
        risk: "none",
        instruction: "none",
        progress: "none",
        failure_repeats: "0",
        score: "10",
      },
    });
    await expect(read).resolves.toMatchObject({ classifier: { category: "idle" } });

    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(child.posted).toContainEqual({ type: "destroy" });
    expect(local.loaded).toBe(false);

    let settled: number | undefined;
    void readerModule.waitForRetiringReaders(5_000).then((pending) => {
      settled = pending;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBeUndefined();
    child.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(0);
  });
});
