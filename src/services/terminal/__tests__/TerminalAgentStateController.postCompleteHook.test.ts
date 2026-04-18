// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TerminalAgentStateController } from "../TerminalAgentStateController";
import type { ManagedTerminal } from "../types";
import type { PostCompleteHook } from "../types";

const mockUpdateAgentState = vi.fn();
vi.mock("@/store/panelStore", () => ({
  usePanelStore: {
    getState: () => ({
      updateAgentState: mockUpdateAgentState,
    }),
  },
}));

const mockLogError = vi.fn();
vi.mock("@/utils/logger", () => ({
  logError: (...args: unknown[]) => mockLogError(...args),
}));

function makeMockBufferLine(text: string) {
  return {
    translateToString: (trimRight?: boolean) => (trimRight ? text.trimEnd() : text),
  };
}

function makeMockBuffer(lines: string[]) {
  return {
    active: {
      length: lines.length,
      getLine: (i: number) => (i >= 0 && i < lines.length ? makeMockBufferLine(lines[i]!) : null),
      baseY: 0,
      type: "normal",
    },
  };
}

function makeMockMarker(line: number) {
  return {
    line,
    isDisposed: false,
    dispose: vi.fn(),
    onDispose: { dispose: vi.fn() },
  };
}

function makeMockManaged(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
  return {
    kind: "agent",
    agentState: undefined,
    canonicalAgentState: undefined,
    agentStateSubscribers: new Set(),
    terminal: {
      buffer: makeMockBuffer([]),
      registerMarker: vi.fn(() => makeMockMarker(0)),
    },
    ...overrides,
  } as unknown as ManagedTerminal;
}

describe("TerminalAgentStateController — postCompleteHook", () => {
  let controller: TerminalAgentStateController;
  let instances: Map<string, ManagedTerminal>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockUpdateAgentState.mockClear();
    mockLogError.mockClear();
    instances = new Map();
    controller = new TerminalAgentStateController({
      getInstance: (id) => instances.get(id),
    });
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
  });

  it("fires hook on working → waiting transition", () => {
    const hook = vi.fn();
    const bufferLines = ["$ claude", "Working on task...", "Done."];
    const managed = makeMockManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(bufferLines) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
      postCompleteMarker: undefined,
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");

    expect(hook).toHaveBeenCalledOnce();
    expect(hook).toHaveBeenCalledWith("$ claude\nWorking on task...\nDone.");
  });

  it("extracts output from marker line to buffer end", () => {
    const hook = vi.fn();
    const bufferLines = ["old line 1", "old line 2", "new output 1", "new output 2"];
    const marker = makeMockMarker(2);
    const managed = makeMockManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(bufferLines) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
      postCompleteMarker: marker as unknown as ManagedTerminal["postCompleteMarker"],
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");

    expect(hook).toHaveBeenCalledWith("new output 1\nnew output 2");
    expect(marker.dispose).toHaveBeenCalled();
  });

  it("is one-shot — second working → waiting does not fire again", () => {
    const hook = vi.fn();
    const managed = makeMockManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(["line"]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");
    expect(hook).toHaveBeenCalledOnce();

    // Transition back to working, then to waiting again
    managed.agentState = "working";
    controller.setAgentState("t1", "waiting");
    expect(hook).toHaveBeenCalledOnce(); // still once
  });

  it("does not fire on idle → waiting", () => {
    const hook = vi.fn();
    const managed = makeMockManaged({
      agentState: "idle",
      terminal: { buffer: makeMockBuffer([]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");
    expect(hook).not.toHaveBeenCalled();
  });

  it("does not fire on working → idle", () => {
    const hook = vi.fn();
    const managed = makeMockManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer([]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "idle");
    expect(hook).not.toHaveBeenCalled();
  });

  it("does not fire on directing → waiting (revert)", () => {
    const hook = vi.fn();
    const managed = makeMockManaged({
      agentState: "directing",
      canonicalAgentState: "waiting",
      terminal: { buffer: makeMockBuffer([]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");
    // The directing → waiting guard returns early, so hook is not fired
    expect(hook).not.toHaveBeenCalled();
  });

  it("does not fire when no hook is registered", () => {
    const managed = makeMockManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer([]) } as unknown as ManagedTerminal["terminal"],
    });
    instances.set("t1", managed);

    // Should not throw
    expect(() => controller.setAgentState("t1", "waiting")).not.toThrow();
  });

  it("fires only for the terminal with the registered hook", () => {
    const hook1 = vi.fn();
    const hook2 = vi.fn();
    const managed1 = makeMockManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(["t1"]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook1 as PostCompleteHook,
    });
    const managed2 = makeMockManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(["t2"]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook2 as PostCompleteHook,
    });
    instances.set("t1", managed1);
    instances.set("t2", managed2);

    controller.setAgentState("t1", "waiting");

    expect(hook1).toHaveBeenCalledOnce();
    expect(hook2).not.toHaveBeenCalled();
  });

  it("falls back to startLine 0 when marker is disposed", () => {
    const hook = vi.fn();
    const marker = makeMockMarker(5);
    marker.isDisposed = true;
    const bufferLines = ["line 0", "line 1", "line 2"];
    const managed = makeMockManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(bufferLines) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
      postCompleteMarker: marker as unknown as ManagedTerminal["postCompleteMarker"],
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");

    expect(hook).toHaveBeenCalledWith("line 0\nline 1\nline 2");
  });

  it("falls back to startLine 0 when marker line is negative", () => {
    const hook = vi.fn();
    const marker = makeMockMarker(-1);
    const bufferLines = ["all", "lines"];
    const managed = makeMockManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(bufferLines) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
      postCompleteMarker: marker as unknown as ManagedTerminal["postCompleteMarker"],
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");

    expect(hook).toHaveBeenCalledWith("all\nlines");
  });

  it("catches sync errors from hook callback", () => {
    const hook = vi.fn().mockImplementation(() => {
      throw new Error("hook exploded");
    });
    const managed = makeMockManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(["x"]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
    });
    instances.set("t1", managed);

    expect(() => controller.setAgentState("t1", "waiting")).not.toThrow();
    expect(mockLogError).toHaveBeenCalledWith("Post-complete hook error", expect.any(Error));
  });

  it("catches async errors from hook callback", async () => {
    const hook = vi.fn().mockRejectedValue(new Error("async boom"));
    const managed = makeMockManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(["x"]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");

    // Flush the rejected promise
    await vi.advanceTimersByTimeAsync(0);

    expect(mockLogError).toHaveBeenCalledWith("Post-complete hook error", expect.any(Error));
  });

  it("clears hook and marker fields on managed after firing", () => {
    const hook = vi.fn();
    const marker = makeMockMarker(0);
    const managed = makeMockManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer(["x"]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
      postCompleteMarker: marker as unknown as ManagedTerminal["postCompleteMarker"],
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");

    expect(managed.postCompleteHook).toBeUndefined();
    expect(managed.postCompleteMarker).toBeUndefined();
  });

  it("still notifies subscribers after hook fires", () => {
    const hook = vi.fn();
    const subscriber = vi.fn();
    const managed = makeMockManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer([]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
    });
    managed.agentStateSubscribers.add(subscriber);
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");

    expect(hook).toHaveBeenCalledOnce();
    expect(subscriber).toHaveBeenCalledWith("waiting");
  });

  it("produces empty string when buffer is empty", () => {
    const hook = vi.fn();
    const managed = makeMockManaged({
      agentState: "working",
      terminal: { buffer: makeMockBuffer([]) } as unknown as ManagedTerminal["terminal"],
      postCompleteHook: hook as PostCompleteHook,
    });
    instances.set("t1", managed);

    controller.setAgentState("t1", "waiting");

    expect(hook).toHaveBeenCalledWith("");
  });
});
