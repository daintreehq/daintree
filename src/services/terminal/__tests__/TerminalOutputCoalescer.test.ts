import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalOutputCoalescer, type CoalescerOutput } from "../TerminalOutputCoalescer";

describe("TerminalOutputCoalescer", () => {
  let now = 0;
  let timeoutId = 0;
  let scheduledTimeouts: Map<number, { callback: () => void; when: number }>;

  function createCoalescer(onOutput: (output: CoalescerOutput) => void): TerminalOutputCoalescer {
    return new TerminalOutputCoalescer(
      (callback: () => void, delayMs: number) => {
        const id = ++timeoutId;
        scheduledTimeouts.set(id, { callback, when: now + delayMs });
        return id;
      },
      (id: number) => {
        scheduledTimeouts.delete(id);
      },
      () => now,
      onOutput
    );
  }

  function advanceTime(ms: number): void {
    now += ms;
    const toExecute = Array.from(scheduledTimeouts.entries())
      .filter(([_, { when }]) => when <= now)
      .sort((a, b) => a[1].when - b[1].when);

    for (const [id, { callback }] of toExecute) {
      scheduledTimeouts.delete(id);
      callback();
    }
  }

  beforeEach(() => {
    now = 1000;
    timeoutId = 0;
    scheduledTimeouts = new Map();
  });

  afterEach(() => {
    scheduledTimeouts.clear();
  });

  it("flushForTerminal writes pending buffered chunks immediately", () => {
    const outputs: CoalescerOutput[] = [];
    const coalescer = createCoalescer((output) => {
      outputs.push(output);
    });

    coalescer.bufferData("t1", "hello");
    coalescer.flushForTerminal("t1");

    expect(outputs).toEqual([{ id: "t1", data: "hello" }]);

    advanceTime(100);
    expect(outputs).toHaveLength(1);
  });

  it("markInteractive enables immediate flush for small payloads", () => {
    const outputs: CoalescerOutput[] = [];
    const coalescer = createCoalescer((output) => {
      outputs.push(output);
    });

    coalescer.markInteractive("t1", 1000);
    coalescer.bufferData("t1", "a");

    expect(outputs).toEqual([{ id: "t1", data: "a" }]);

    advanceTime(100);
    expect(outputs).toHaveLength(1);
  });

  it("buffers data and flushes after standard delay", () => {
    const outputs: CoalescerOutput[] = [];
    const coalescer = createCoalescer((output) => {
      outputs.push(output);
    });

    coalescer.bufferData("t1", "hello");
    expect(outputs).toHaveLength(0);

    advanceTime(8);
    expect(outputs).toEqual([{ id: "t1", data: "hello" }]);
  });

  it("resetForTerminal clears pending buffers", () => {
    const outputs: CoalescerOutput[] = [];
    const coalescer = createCoalescer((output) => {
      outputs.push(output);
    });

    coalescer.bufferData("t1", "hello");
    coalescer.resetForTerminal("t1");

    advanceTime(100);
    expect(outputs).toHaveLength(0);
  });

  it("joins multiple string chunks when flushing", () => {
    const outputs: CoalescerOutput[] = [];
    const coalescer = createCoalescer((output) => {
      outputs.push(output);
    });

    coalescer.bufferData("t1", "hello");
    advanceTime(1);
    coalescer.bufferData("t1", " ");
    advanceTime(1);
    coalescer.bufferData("t1", "world");

    advanceTime(8);
    expect(outputs).toEqual([{ id: "t1", data: "hello world" }]);
  });
});
