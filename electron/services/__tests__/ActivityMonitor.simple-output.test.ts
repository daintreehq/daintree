import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActivityMonitor } from "../ActivityMonitor.js";
import { AGENT_OUTPUT_ACTIVITY_LINE_COUNT } from "../pty/AgentActivityTemperature.js";
import { buildActivityMonitorOptions } from "../pty/terminalActivityPatterns.js";
import {
  createVisibleCellContentSnapshot,
  createVisibleContentSnapshot,
  type VisibleContentCell,
} from "../pty/SustainedChangeTracker.js";

function visibleCell(partial: Partial<VisibleContentCell> = {}): VisibleContentCell {
  const chars = partial.chars ?? "●";
  return {
    chars,
    code: partial.code ?? chars.codePointAt(0) ?? 0,
    width: partial.width ?? 1,
    fgColorMode: partial.fgColorMode ?? 0,
    fgColor: partial.fgColor ?? 0,
    attributes: partial.attributes ?? 0,
  };
}

function visibleRow(text: string, partial: Partial<VisibleContentCell> = {}): VisibleContentCell[] {
  return Array.from(text).map((chars) =>
    visibleCell({
      ...partial,
      chars,
      code: chars.codePointAt(0) ?? 0,
    })
  );
}

describe("ActivityMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  describe("Simple output-driven agent state", () => {
    it("requires sustained visible changes before recovering to working", () => {
      const onStateChange = vi.fn();
      let visible = "waiting 0";
      const monitor = new ActivityMonitor("agent-simple-1", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [visible],
        getCursorLine: () => visible,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();

      vi.advanceTimersByTime(100);
      visible = "tick 1";
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      visible = "tick 2";
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      visible = "tick 3";
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      visible = "tick 4";
      vi.advanceTimersByTime(50);

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("agent-simple-1", 1000, "busy", {
        trigger: "output",
      });

      vi.advanceTimersByTime(5999);
      expect(monitor.getState()).toBe("busy");

      vi.advanceTimersByTime(200);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenCalledWith("agent-simple-1", 1000, "idle", {
        trigger: "timeout",
        waitingReason: "prompt",
      });

      monitor.dispose();
    });

    it("ignores line-wrap-only reflows while idle", () => {
      const onStateChange = vi.fn();
      let visibleLines = ["Claude Code is waiting for input"];
      const monitor = new ActivityMonitor("agent-simple-reflow", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => visibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      onStateChange.mockClear();

      visibleLines = ["Claude Code", "is waiting", "for input"];
      vi.advanceTimersByTime(3000);

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("ignores repeated separator width changes in visual snapshots", () => {
      const onStateChange = vi.fn();
      let separatorLength = 5;
      const getVisibleContentSnapshot = vi.fn((count: number) => {
        expect(count).toBe(AGENT_OUTPUT_ACTIVITY_LINE_COUNT);
        return createVisibleContentSnapshot("-".repeat(separatorLength));
      });
      const monitor = new ActivityMonitor("agent-simple-separator-resize", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["-----"],
        getVisibleContentSnapshot,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      onStateChange.mockClear();

      for (const length of [10, 20, 40, 8]) {
        separatorLength = length;
        vi.advanceTimersByTime(700);
      }

      expect(getVisibleContentSnapshot).toHaveBeenCalled();
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("samples only the visible tail for simple output recovery", () => {
      const onStateChange = vi.fn();
      let visibleLines = Array.from({ length: 30 }, (_, i) => `historical line ${i + 1}`);
      const getVisibleLines = vi.fn((count: number) => visibleLines.slice(-count));
      const monitor = new ActivityMonitor("agent-simple-tail", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines,
        getCursorLine: () => visibleLines[visibleLines.length - 1],
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      expect(getVisibleLines).toHaveBeenCalledWith(AGENT_OUTPUT_ACTIVITY_LINE_COUNT);
      getVisibleLines.mockClear();

      vi.advanceTimersByTime(100);
      onStateChange.mockClear();

      for (let i = 0; i < 4; i += 1) {
        visibleLines = [...visibleLines];
        visibleLines[i] = `rewritten historical line ${i + 1}`;
        monitor.onData(visibleLines[i]!);
        vi.advanceTimersByTime(700);
      }

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();
      expect(getVisibleLines).toHaveBeenCalledWith(AGENT_OUTPUT_ACTIVITY_LINE_COUNT);

      for (let i = 0; i < 4; i += 1) {
        visibleLines = [...visibleLines];
        visibleLines[visibleLines.length - 1] = `visible activity ${i + 1}`;
        monitor.onData(visibleLines[visibleLines.length - 1]!);
        vi.advanceTimersByTime(700);
      }

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("agent-simple-tail", 1000, "busy", {
        trigger: "output",
      });

      monitor.dispose();
    });

    it("recovers from sustained color-only visual cell changes", () => {
      const onStateChange = vi.fn();
      let fgColor = 1;
      const monitor = new ActivityMonitor("agent-simple-color-spinner", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["●●●"],
        getVisibleContentSnapshot: () =>
          createVisibleCellContentSnapshot([visibleRow("●●●", { fgColorMode: 1, fgColor })]),
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      fgColor = 2;
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      fgColor = 3;
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      fgColor = 4;
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      fgColor = 5;
      vi.advanceTimersByTime(50);

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("agent-simple-color-spinner", 1000, "busy", {
        trigger: "output",
      });

      monitor.dispose();
    });

    it("treats resize as suppressed baseline reseed before simple output recovery", () => {
      const onStateChange = vi.fn();
      let visible = "waiting";
      const monitor = new ActivityMonitor("agent-simple-resize", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [visible],
        getCursorLine: () => visible,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      onStateChange.mockClear();

      monitor.notifyResize(1000);
      visible = "resize reflow";
      vi.advanceTimersByTime(500);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      visible = "post resize baseline";
      vi.advanceTimersByTime(600);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      for (let i = 0; i < 4; i += 1) {
        visible = `post resize activity ${i + 1}`;
        monitor.onData(visible);
        vi.advanceTimersByTime(700);
      }

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("agent-simple-resize", 1000, "busy", {
        trigger: "output",
      });

      monitor.dispose();
    });

    it("does not recover to working from resize-only reflow bursts", () => {
      const onStateChange = vi.fn();
      let visible = "waiting";
      const monitor = new ActivityMonitor("agent-simple-resize-burst", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [visible],
        getCursorLine: () => visible,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      onStateChange.mockClear();

      monitor.notifyResize(1000);
      visible = "reflow frame 1";
      vi.advanceTimersByTime(800);
      expect(monitor.getState()).toBe("idle");

      monitor.notifyResize(1000);
      visible = "reflow frame 2";
      vi.advanceTimersByTime(800);
      expect(monitor.getState()).toBe("idle");

      monitor.notifyResize(1000);
      visible = "reflow frame 3";
      vi.advanceTimersByTime(800);
      expect(monitor.getState()).toBe("idle");

      visible = "post resize baseline";
      vi.advanceTimersByTime(1000);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(3000);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalledWith(
        "agent-simple-resize-burst",
        1000,
        "busy",
        expect.anything()
      );

      monitor.dispose();
    });

    it("recovers from a sustained one-character activity indicator", () => {
      const onStateChange = vi.fn();
      let visible = "Working |";
      const monitor = new ActivityMonitor("agent-simple-spinner", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [visible],
        getCursorLine: () => visible,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(100);

      visible = "Working /";
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      visible = "Working -";
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      visible = "Working \\";
      vi.advanceTimersByTime(50);
      expect(monitor.getState()).toBe("idle");

      vi.advanceTimersByTime(650);
      visible = "Working |";
      vi.advanceTimersByTime(50);

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("agent-simple-spinner", 1000, "busy", {
        trigger: "output",
      });

      monitor.dispose();
    });

    it("ignores unchanged redraw frames while idle", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("agent-simple-redraw", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["waiting"],
        getCursorLine: () => "waiting",
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(500);
      monitor.onData("\rwaiting");
      vi.advanceTimersByTime(600);

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalled();

      monitor.dispose();
    });

    it("resets the 6s silence window on tiny repeated visible changes", () => {
      const onStateChange = vi.fn();
      let visible = "tick 1";
      const monitor = new ActivityMonitor("agent-simple-2", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [visible],
        getCursorLine: () => visible,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      monitor.notifySubmission();
      vi.advanceTimersByTime(5900);
      visible = "tick 2";
      monitor.onData(visible);
      vi.advanceTimersByTime(50);
      vi.advanceTimersByTime(5900);

      expect(monitor.getState()).toBe("busy");

      vi.advanceTimersByTime(200);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange.mock.calls.filter((call) => call[2] === "busy")).toHaveLength(1);

      monitor.dispose();
    });

    it("reuses the cached viewport snapshot once quiet and recomputes after new data", () => {
      const onStateChange = vi.fn();
      const getVisibleContentSnapshot = vi.fn(() => createVisibleContentSnapshot("waiting"));
      const monitor = new ActivityMonitor("agent-simple-snapshot-cache", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["waiting"],
        getVisibleContentSnapshot,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      vi.advanceTimersByTime(2000);
      getVisibleContentSnapshot.mockClear();

      // Quiet past the settle window: polling must stop re-extracting the viewport
      vi.advanceTimersByTime(1000);
      expect(getVisibleContentSnapshot).not.toHaveBeenCalled();

      // New data restarts extraction on the next polls
      monitor.onData("new output");
      vi.advanceTimersByTime(100);
      expect(getVisibleContentSnapshot).toHaveBeenCalled();

      monitor.dispose();
    });

    it("coalesces viewport extraction during a byte stream but still observes redraws", () => {
      const onStateChange = vi.fn();
      let visible = "waiting";
      const getVisibleContentSnapshot = vi.fn(() => createVisibleContentSnapshot(visible));
      const monitor = new ActivityMonitor(
        "agent-simple-active-snapshot-cache",
        1000,
        onStateChange,
        {
          agentId: "claude",
          getVisibleLines: () => [visible],
          getVisibleContentSnapshot,
          initialState: "idle",
          skipInitialStateEmit: true,
        }
      );

      monitor.startPolling();
      vi.advanceTimersByTime(100);
      getVisibleContentSnapshot.mockClear();

      for (let i = 0; i < 10; i += 1) {
        visible = `stream ${i}`;
        monitor.onData(visible);
        vi.advanceTimersByTime(50);
      }

      const streamCaptures = getVisibleContentSnapshot.mock.calls.length;
      expect(streamCaptures).toBeGreaterThan(0);
      expect(streamCaptures).toBeLessThan(10);

      visible = "asynchronous redraw";
      vi.advanceTimersByTime(50);
      expect(getVisibleContentSnapshot).toHaveBeenCalledTimes(streamCaptures + 1);

      monitor.dispose();
    });

    it("keeps Enter immediate in simple agent mode", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("agent-simple-enter", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.onInput("run\r");

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("agent-simple-enter", 1000, "busy", {
        trigger: "input",
      });

      monitor.dispose();
    });
  });

  describe("Simple-output mode detection layers (#9873)", () => {
    const CLAUDE_WORKING = "✽ Deliberating… (esc to interrupt · 15s)";

    function driveBusyViaOutputChanges(
      monitor: ActivityMonitor,
      setVisible: (text: string) => void
    ): void {
      for (let i = 1; i <= 4; i++) {
        vi.advanceTimersByTime(650);
        setVisible(`tick ${i}`);
        vi.advanceTimersByTime(50);
      }
      expect(monitor.getState()).toBe("busy");
    }

    it("detects completion with extracted cost/tokens in simple polling", () => {
      const onStateChange = vi.fn();
      let visible = ["waiting 0"];
      const monitor = new ActivityMonitor("simple-completion", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => visible,
        getCursorLine: () => visible[visible.length - 1],
        initialState: "idle",
        skipInitialStateEmit: true,
        completionPatterns: [/Total cost:/],
      });

      monitor.startPolling();
      driveBusyViaOutputChanges(monitor, (text) => {
        visible = [text];
      });
      onStateChange.mockClear();

      visible = ["All done.", "Total cost: $1.23"];
      // Quiet gate: completion must not fire while output is still fresh
      vi.advanceTimersByTime(1000);
      expect(onStateChange.mock.calls.filter((call) => call[2] === "completed")).toHaveLength(0);

      vi.advanceTimersByTime(700);
      expect(onStateChange).toHaveBeenCalledWith("simple-completion", 1000, "completed", {
        trigger: "pattern",
        patternConfidence: 0.9,
        sessionCost: 1.23,
        sessionTokens: undefined,
      });

      // Completion hold settles to idle shortly after
      vi.advanceTimersByTime(600);
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("does not treat a cost line as completion while output keeps flowing", () => {
      const onStateChange = vi.fn();
      let visible = ["working"];
      const monitor = new ActivityMonitor("simple-midstream", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => visible,
        getCursorLine: () => visible[visible.length - 1],
        initialState: "idle",
        skipInitialStateEmit: true,
        completionPatterns: [/Total cost:/],
      });

      monitor.startPolling();
      driveBusyViaOutputChanges(monitor, (text) => {
        visible = [text];
      });
      onStateChange.mockClear();

      // Cost line scrolls past, but output keeps changing every 500ms —
      // lastActivity stays fresh, so the completion scan never fires.
      visible = ["Total cost: $0.50", "step output 0"];
      for (let i = 1; i <= 6; i++) {
        vi.advanceTimersByTime(500);
        visible = ["Total cost: $0.50", `step output ${i}`];
      }
      expect(onStateChange.mock.calls.filter((call) => call[2] === "completed")).toHaveLength(0);
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("blocks completion while raw bytes stream past a static viewport", () => {
      const onStateChange = vi.fn();
      let visible = ["waiting 0"];
      const monitor = new ActivityMonitor("simple-stream-quiet", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => visible,
        getCursorLine: () => visible[visible.length - 1],
        initialState: "idle",
        skipInitialStateEmit: true,
        completionPatterns: [/Total cost:/],
      });

      monitor.startPolling();
      driveBusyViaOutputChanges(monitor, (text) => {
        visible = [text];
      });
      onStateChange.mockClear();

      // Viewport settles on a cost line, but raw PTY bytes keep arriving —
      // lastDataTimestamp stays fresh, so the completion scan must not fire.
      visible = ["Total cost: $2.00"];
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(500);
        monitor.onData("streaming bytes that never repaint the viewport");
      }
      expect(onStateChange.mock.calls.filter((call) => call[2] === "completed")).toHaveLength(0);

      // Once the stream goes quiet, completion fires.
      vi.advanceTimersByTime(1600);
      expect(onStateChange.mock.calls.filter((call) => call[2] === "completed")).toHaveLength(1);

      monitor.dispose();
    });

    it("exits boot early when a prompt appears in visible history", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("simple-boot-prompt", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["$", "waiting for setup"],
        getCursorLine: () => "waiting for setup",
        pollingMaxBootMs: 20000,
      });

      monitor.startPolling();
      onStateChange.mockClear();

      // History scan is locked for the first 3s — boot holds busy
      vi.advanceTimersByTime(2000);
      expect(monitor.getState()).toBe("busy");

      // Prompt in history exits boot well before the 20s timeout, so the
      // idle gate can fire at the normal 8s quiet mark
      vi.advanceTimersByTime(6300);
      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenCalledWith(
        "simple-boot-prompt",
        1000,
        "idle",
        expect.objectContaining({ trigger: "timeout", waitingReason: "prompt" })
      );

      monitor.dispose();
    });

    it("classifies a waiting reason when the idle transition fires", () => {
      const onStateChange = vi.fn();
      let visible = ["waiting 0"];
      const monitor = new ActivityMonitor("simple-waiting", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => visible,
        getCursorLine: () => visible[visible.length - 1],
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();
      driveBusyViaOutputChanges(monitor, (text) => {
        visible = [text];
      });
      onStateChange.mockClear();

      visible = ["Should I delete the old branch?"];
      vi.advanceTimersByTime(8200);

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).toHaveBeenCalledWith("simple-waiting", 1000, "idle", {
        trigger: "timeout",
        waitingReason: "question",
      });

      monitor.dispose();
    });

    it("stays busy during boot even when output is silent past the idle gate", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("simple-boot-guard", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => ["connecting to MCP servers..."],
        getCursorLine: () => "connecting to MCP servers...",
        pollingMaxBootMs: 20000,
      });

      monitor.startPolling();
      expect(monitor.getState()).toBe("busy");
      onStateChange.mockClear();

      // Well past the 8s idle gate, but still booting — must not go idle
      vi.advanceTimersByTime(12000);
      expect(monitor.getState()).toBe("busy");
      expect(onStateChange.mock.calls.filter((call) => call[2] === "idle")).toHaveLength(0);

      // Boot timeout fires; with a static screen the idle gate may now fire
      vi.advanceTimersByTime(9000);
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("consults compiled working patterns from the simple onData path", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("simple-patterns", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [CLAUDE_WORKING],
        getCursorLine: () => CLAUDE_WORKING,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      // Sustained pattern signal across the recovery debounce window
      monitor.onData(CLAUDE_WORKING);
      expect(monitor.getLastPatternResult()?.isWorking).toBe(true);
      vi.advanceTimersByTime(1600);
      monitor.onData(CLAUDE_WORKING);

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith(
        "simple-patterns",
        1000,
        "busy",
        expect.objectContaining({ trigger: "pattern" })
      );

      monitor.dispose();
    });

    it("does not promote idle→busy from patterns during focus suppression", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("simple-focus", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => [CLAUDE_WORKING],
        getCursorLine: () => CLAUDE_WORKING,
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.notifyFocus(2000);
      monitor.onData(CLAUDE_WORKING);
      vi.advanceTimersByTime(1600);
      monitor.onData(CLAUDE_WORKING);

      // Pattern buffer is fed (detection layer live) but no state change
      type MonitorInternals = { patternBuf: { getText(): string } };
      const internals = monitor as unknown as MonitorInternals;
      expect(internals.patternBuf.getText().length).toBeGreaterThan(0);
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("recovers waiting→working from sustained byte volume and stays working through the stream (#10664)", () => {
      const onStateChange = vi.fn();
      let visible = ["idle prompt"];
      const monitor = new ActivityMonitor("simple-volume", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => visible,
        getCursorLine: () => visible[visible.length - 1],
        initialState: "idle",
        skipInitialStateEmit: true,
        simpleOutputVolumeRecovery: {
          enabled: true,
          leakRatePerMs: 0.1,
          activationThreshold: 512,
          maxBytesPerFrame: 256,
        },
      });

      monitor.startPolling();
      // Drive boot exit + a real work cycle, then let the agent settle back to
      // waiting with a static screen the polling cycle can't recover from.
      driveBusyViaOutputChanges(monitor, (text) => {
        visible = [text];
      });
      visible = ["idle prompt"];
      vi.advanceTimersByTime(8200);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // Heavy streaming output whose visible-content diff registers no change
      // (pure appended text). Only the byte-volume floor can recover here.
      const chunk = "investigation result ".repeat(16); // > maxBytesPerFrame
      monitor.onData(chunk);
      expect(monitor.getState()).toBe("idle"); // one frame is capped below threshold
      monitor.onData(chunk);

      expect(monitor.getState()).toBe("busy");
      expect(onStateChange).toHaveBeenCalledWith("simple-volume", 1000, "busy", {
        trigger: "output",
      });

      // The visible screen never changes, so the only thing keeping the agent
      // working is the volume floor refreshing the activity clock. Keep
      // streaming for well past WORKING_HOLD_MS (1.5s) and IDLE_DEBOUNCE_MS (8s)
      // and confirm it does not bounce back to waiting mid-stream.
      for (let i = 0; i < 60; i += 1) {
        vi.advanceTimersByTime(500);
        monitor.onData(chunk);
      }
      expect(monitor.getState()).toBe("busy");
      expect(onStateChange.mock.calls.filter((call) => call[2] === "idle")).toHaveLength(0);

      // Once the stream stops, the agent settles back to waiting after the gate.
      visible = ["idle prompt"];
      vi.advanceTimersByTime(8200);
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("does not recover idle→busy from byte volume during focus suppression (#10664)", () => {
      const onStateChange = vi.fn();
      let visible = ["idle prompt"];
      const monitor = new ActivityMonitor("simple-volume-focus", 1000, onStateChange, {
        agentId: "claude",
        getVisibleLines: () => visible,
        getCursorLine: () => visible[visible.length - 1],
        initialState: "idle",
        skipInitialStateEmit: true,
        simpleOutputVolumeRecovery: {
          enabled: true,
          leakRatePerMs: 0.1,
          activationThreshold: 512,
          maxBytesPerFrame: 256,
        },
      });

      monitor.startPolling();
      driveBusyViaOutputChanges(monitor, (text) => {
        visible = [text];
      });
      visible = ["idle prompt"];
      vi.advanceTimersByTime(8200);
      expect(monitor.getState()).toBe("idle");
      onStateChange.mockClear();

      // A window-focus repaint suppresses promotion (#8867). Even a volume
      // burst that crosses the threshold must not flip idle→busy.
      monitor.notifyFocus(2000);
      const chunk = "investigation result ".repeat(16);
      monitor.onData(chunk);
      monitor.onData(chunk);
      monitor.onData(chunk);

      expect(monitor.getState()).toBe("idle");
      expect(onStateChange).not.toHaveBeenCalledWith(
        "simple-volume-focus",
        1000,
        "busy",
        expect.anything()
      );

      monitor.dispose();
    });

    it("wires simpleOutputVolumeRecovery for agent terminals only (#10664)", () => {
      const agentOptions = buildActivityMonitorOptions("claude", {});
      expect(agentOptions.simpleOutputVolumeRecovery?.enabled).toBe(true);
      // Threshold must exceed the per-frame cap so a single chunk can never fire
      // the bucket on its own — recovery requires sustained volume.
      const recovery = agentOptions.simpleOutputVolumeRecovery!;
      expect(recovery.activationThreshold!).toBeGreaterThan(recovery.maxBytesPerFrame!);

      // Non-agent terminals don't get the recovery detector.
      const plainOptions = buildActivityMonitorOptions(undefined, {});
      expect(plainOptions.simpleOutputVolumeRecovery).toBeUndefined();
    });
  });

  describe("notifySubmission (hybrid input bar)", () => {
    it("should immediately transition to busy on submission (Issue #2185)", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        getVisibleLines: () => ["> "],
        getCursorLine: () => "> ",
        initialState: "idle",
        skipInitialStateEmit: true,
      });

      monitor.startPolling();

      // Simulate hybrid input bar submit - should immediately go busy
      monitor.notifySubmission();

      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should work without polling enabled", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.notifySubmission();

      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should not fire duplicate busy when already busy", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.notifySubmission();
      monitor.notifySubmission();

      expect(onStateChange).toHaveBeenCalledTimes(1);

      monitor.dispose();
    });
  });

  describe("Output-driven activity", () => {
    it("should NOT trigger busy from output during typing echo window - Issue #1476", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(true),
      };
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        processStateValidator,
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 1,
          maxBytesPerFrame: 65536,
          leakRatePerMs: 0.001,
        },
      });

      // User types (sets recent input timestamp)
      monitor.onInput("h");

      // Output during echo window should NOT trigger busy
      monitor.onData("h");

      expect(onStateChange).not.toHaveBeenCalled();
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should trigger busy from output when there is pending input (Enter pressed)", () => {
      const onStateChange = vi.fn();
      const processStateValidator = {
        hasActiveChildren: vi.fn().mockReturnValue(true),
      };
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        processStateValidator,
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 1,
          maxBytesPerFrame: 65536,
          leakRatePerMs: 0.001,
        },
      });

      // Press Enter first to set pending input
      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });

      // Reset to test output confirmation
      onStateChange.mockClear();
      monitor.onData("agent output");

      // Already busy, output just confirms - no duplicate call
      expect(onStateChange).not.toHaveBeenCalled();
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should not re-emit busy when output arrives after Enter has set state to busy", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 1,
          maxBytesPerFrame: 65536,
          leakRatePerMs: 0.001,
        },
      });

      monitor.onInput("\r");
      expect(onStateChange).toHaveBeenCalledWith("test-1", 1000, "busy", { trigger: "input" });
      onStateChange.mockClear();

      monitor.onData("agent output");

      // Already busy from input — output confirms but doesn't re-emit busy
      expect(onStateChange).not.toHaveBeenCalled();
      expect(monitor.getState()).toBe("busy");

      monitor.dispose();
    });

    it("should NOT trigger busy from output during echo window even without validator - Issue #1476", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange, {
        outputActivityDetection: {
          enabled: true,
          activationThreshold: 1,
          maxBytesPerFrame: 65536,
          leakRatePerMs: 0.001,
        },
      });

      // User types (sets recent input timestamp)
      monitor.onInput("x");

      // Output during echo window should NOT trigger busy
      monitor.onData("x");

      expect(onStateChange).not.toHaveBeenCalled();
      expect(monitor.getState()).toBe("idle");

      monitor.dispose();
    });

    it("should not trigger on empty data", () => {
      const onStateChange = vi.fn();
      const monitor = new ActivityMonitor("test-1", 1000, onStateChange);

      monitor.onData();
      monitor.onData(undefined);

      expect(onStateChange).not.toHaveBeenCalled();
    });
  });
});
