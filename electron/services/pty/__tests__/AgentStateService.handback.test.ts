import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStateService } from "../AgentStateService.js";
import { events } from "../../events.js";
import { HandbackTracker } from "../HandbackTracker.js";
import type { TerminalInfo } from "../types.js";
import { buildHandbackInstruction } from "../../../../shared/utils/handback.js";
import * as detector from "../HandbackDetector.js";

vi.mock("../HandbackDetector.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../HandbackDetector.js")>();
  return { ...actual, findHandback: vi.fn(actual.findHandback) };
});

const CODE = "k7f3qa";
const ECHO = `> Fix the flaky test ${buildHandbackInstruction(CODE)}`;
const MARKER = `DAINTREE-DONE-${CODE}: fixed the race in the retry loop END-${CODE}`;

function createTerminal(overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: "term-1",
    cwd: "/repo",
    shell: "/bin/zsh",
    spawnedAt: Date.now(),
    analysisEnabled: false,
    lastInputTime: 0,
    lastOutputTime: 0,
    lastCheckTime: 0,
    restartCount: 0,
    launchAgentId: "claude",
    agentState: "working",
    ptyProcess: {} as never,
    outputBuffer: "",
    semanticBuffer: [],
    ...overrides,
  } as TerminalInfo;
}

/** A terminal holding one delivered request, whose screen reads `screen`. */
function askedTerminal(screen: string[], overrides: Partial<TerminalInfo> = {}) {
  const tracker = new HandbackTracker(() => screen);
  tracker.registerDelivered(CODE);
  return createTerminal({ handbackTracker: tracker, ...overrides });
}

function capturePayloads() {
  const payloads: Array<{ lastHandback?: unknown; state: string }> = [];
  events.on("agent:state-changed", (payload) => payloads.push(payload));
  return payloads;
}

describe("AgentStateService handback detection (#12488)", () => {
  afterEach(() => {
    events.removeAllListeners();
    vi.mocked(detector.findHandback).mockClear();
  });

  it("publishes a marker seen as the agent settles out of working", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([ECHO, "⏺ Done.", `  ${MARKER}`, "> "]);
    const payloads = capturePayloads();

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    const expected = {
      message: "fixed the race in the retry loop",
      observedAt: terminal.lastStateChange,
      truncated: false,
    };
    expect(payloads[0]?.lastHandback).toEqual(expected);
    expect(terminal.lastHandback).toEqual(expected);
  });

  it("carries the submission token of the request that asked", () => {
    const service = new AgentStateService();
    const tracker = new HandbackTracker(() => [MARKER]);
    tracker.noteSubmission(CODE, "token-1")?.();
    const terminal = createTerminal({ handbackTracker: tracker });

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(terminal.lastHandback?.submissionToken).toBe("token-1");
  });

  it("fires a code once: a later settle over the same screen publishes nothing", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([MARKER]);
    const payloads = capturePayloads();

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");
    service.updateAgentState(terminal, { type: "busy" }, "activity", 1.0);
    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(payloads.filter((p) => p.lastHandback !== undefined)).toHaveLength(1);
    expect(terminal.handbackTracker?.hasRequests()).toBe(false);
  });

  it("publishes a marker seen early in output on the next settle, once", () => {
    // The output observer retires the code, so the settle detects nothing;
    // the renderer's lastHandback still has to learn of it.
    const service = new AgentStateService();
    const early = { message: "fixed it", observedAt: 1, truncated: false };
    const terminal = createTerminal({ lastHandback: early, lastHandbackUnpublished: true });
    const payloads = capturePayloads();

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");
    service.updateAgentState(terminal, { type: "busy" }, "activity", 1.0);
    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(payloads[0]?.lastHandback).toEqual(early);
    expect(payloads.filter((p) => p.lastHandback !== undefined)).toHaveLength(1);
  });

  it("publishes nothing for the echoed instruction and keeps waiting", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([ECHO, "⏺ Looking into it…"]);
    const payloads = capturePayloads();

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(payloads[0]?.lastHandback).toBeUndefined();
    expect(terminal.lastHandback).toBeUndefined();
    expect(terminal.handbackTracker?.deliveredRequests()).toHaveLength(1);
  });

  it("publishes nothing for a half-streamed marker", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([ECHO, `⏺ DAINTREE-DONE-${CODE}: fixed the ra`]);

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(terminal.lastHandback).toBeUndefined();
  });

  it("ignores a replayed marker from an earlier turn's code", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([
      "DAINTREE-DONE-oldold: the previous task END-oldold",
      ECHO,
      "⏺ Working on it",
    ]);

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(terminal.lastHandback).toBeUndefined();
  });

  it("never looks while the agent is working", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([MARKER], { agentState: "waiting" });

    // waiting → working: an agent that mentions the marker mid-task is still working.
    service.updateAgentState(terminal, { type: "busy" }, "activity", 1.0);

    expect(terminal.agentState).toBe("working");
    expect(terminal.lastHandback).toBeUndefined();
    expect(detector.findHandback).not.toHaveBeenCalled();
  });

  it("only looks at a settle out of working", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([MARKER], { agentState: "waiting" });

    // waiting → idle is a settle state, but not one the agent worked into.
    service.updateAgentState(terminal, { type: "watchdog-timeout" }, "timeout", 0.6);

    expect(terminal.agentState).toBe("idle");
    expect(terminal.lastHandback).toBeUndefined();
    expect(detector.findHandback).not.toHaveBeenCalled();
  });

  it("does not look for a request whose submission has not reached the pty", () => {
    const service = new AgentStateService();
    const tracker = new HandbackTracker(() => [MARKER]);
    tracker.noteSubmission(CODE);
    const terminal = createTerminal({ handbackTracker: tracker });

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(terminal.lastHandback).toBeUndefined();
    expect(detector.findHandback).not.toHaveBeenCalled();
  });

  it("falls back to the raw semantic buffer, keeping cursor-painted gaps as spaces", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([], {
      semanticBuffer: [`\x1b[1m⏺\x1b[0m DAINTREE-DONE-${CODE}:\x1b[1Cfixed\x1b[1Cit END-${CODE}`],
    });

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");

    expect(terminal.lastHandback?.message).toBe("fixed it");
  });

  it("looks at an exit settle, then drops what is left", () => {
    const service = new AgentStateService();
    const tracker = new HandbackTracker(() => [MARKER]);
    tracker.registerDelivered(CODE);
    tracker.noteSubmission("zzzzzz");
    const terminal = createTerminal({ handbackTracker: tracker });

    service.updateAgentState(terminal, { type: "exit", code: 0 });

    expect(terminal.agentState).toBe("exited");
    expect(terminal.lastHandback?.message).toBe("fixed the race in the retry loop");
    expect(tracker.hasRequests()).toBe(false);
  });

  it("clears the handback and outstanding requests on respawn without looking", () => {
    const service = new AgentStateService();
    const terminal = askedTerminal([MARKER], {
      agentState: "exited",
      lastHandback: { message: "old", observedAt: 1, truncated: false },
    });
    const payloads = capturePayloads();

    service.updateAgentState(terminal, { type: "respawn" });

    expect(terminal.agentState).toBe("idle");
    expect(terminal.lastHandback).toBeUndefined();
    expect(terminal.handbackTracker?.hasRequests()).toBe(false);
    expect(payloads[0]?.lastHandback).toBeUndefined();
    expect(detector.findHandback).not.toHaveBeenCalled();
  });

  it("never runs the detector for a terminal nobody asked about", () => {
    const service = new AgentStateService();
    const terminal = createTerminal({ semanticBuffer: [MARKER] });
    const payloads = capturePayloads();

    service.updateAgentState(terminal, { type: "prompt" }, "activity", 1.0, "prompt");
    service.updateAgentState(terminal, { type: "busy" }, "activity", 1.0);
    service.updateAgentState(terminal, { type: "exit", code: 0 });

    expect(detector.findHandback).not.toHaveBeenCalled();
    expect(terminal.lastHandback).toBeUndefined();
    expect(payloads.every((p) => p.lastHandback === undefined)).toBe(true);
  });
});
