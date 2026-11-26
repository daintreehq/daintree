import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisSession } from "../analysis/AnalysisSession.js";
import { AgentStateService } from "../AgentStateService.js";
import { events } from "../../events.js";
import type { TerminalInfo } from "../types.js";
import type { WorkerToHostMessage } from "../analysisWorkerProtocol.js";
import { getSubmitEnterDelay } from "../terminalInput.js";

const COLS = 120;
const ROWS = 40;
const RULE = "─".repeat(COLS);
const COMMAND = "/rate-limit-options";

const TRANSCRIPT = ["● The parser now handles empty input, and its tests pass.", ""];

/** Claude Code 2.1.332 at an empty prompt. */
function promptFrame(draft = ""): string[] {
  const suggestions =
    draft === ""
      ? ["  ? for shortcuts"]
      : [`  ${COMMAND}   Choose what to do when you hit a usage limit`];
  return [...TRANSCRIPT, RULE, `❯ ${draft}`, RULE, ...suggestions];
}

// The menu `/rate-limit-options` opens, reconstructed from a 120×40 capture of
// Claude Code 2.1.332: drawn once 23 ms after Enter, then no byte for 35.2 s
// until Escape (#18175).
const MENU_FRAME = [
  ...TRANSCRIPT,
  `❯ ${COMMAND}`,
  "  What do you want to do?",
  "  ❯ 1. Stop and wait for limit to reset",
  "    2. Switch to usage credits",
  "  Enter to confirm · Esc to cancel",
];

/**
 * An Ink renderer: each frame erases the one before it and redraws in place,
 * inside a synchronized-output bracket.
 */
function inkRenderer() {
  let drawn = 0;
  return (lines: string[]): string => {
    const erase = drawn === 0 ? "" : "\x1b[2K\x1b[1A".repeat(drawn - 1) + "\x1b[2K\x1b[G";
    drawn = lines.length;
    return `\x1b[?2026h${erase}${lines.join("\r\n")}\x1b[?2026l`;
  };
}

function createInfo(): TerminalInfo {
  return {
    id: "rate-limit-options",
    cwd: "/repo",
    shell: "/bin/zsh",
    spawnedAt: 1,
    analysisEnabled: true,
    lastInputTime: 0,
    lastOutputTime: 0,
    lastCheckTime: 0,
    agentIncarnation: 0,
    restartCount: 0,
    launchAgentId: "claude",
    detectedAgentId: "claude",
    agentState: "idle",
    ptyProcess: {} as never,
    semanticBuffer: [],
  } as TerminalInfo;
}

const sessions: AnalysisSession[] = [];

/** A worker-side Claude pane whose activity reaches a real AgentStateService. */
function claudePane(pollingIntervalMs: number) {
  const info = createInfo();
  const service = new AgentStateService();
  const session = new AnalysisSession(
    {
      terminalId: info.id,
      cols: COLS,
      rows: ROWS,
      scrollback: 1000,
      restore: false,
      spawnedAt: info.spawnedAt,
      epoch: 1,
    },
    (message: WorkerToHostMessage) => {
      if (message.type === "activity-state") {
        service.handleActivityState(info, message.state, message.metadata);
      }
    }
  );
  sessions.push(session);
  const render = inkRenderer();
  const draw = (lines: string[]) =>
    session.feedChunk(render(lines), { agentLive: true, agentState: info.agentState });
  const published = () => ({ agentState: info.agentState, waitingReason: info.waitingReason });
  return { info, session, draw, published, pollingIntervalMs };
}

/** Booted and settled at its empty prompt, as an idle pane is when a command is sent. */
async function settledAtPrompt(pollingIntervalMs: number) {
  const pane = claudePane(pollingIntervalMs);
  pane.draw(promptFrame());
  pane.session.startMonitor({
    agentId: "claude",
    initialState: "busy",
    skipInitialStateEmit: false,
    hasProcessValidator: false,
    pollingIntervalMs,
  });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(pane.published()).toEqual({ agentState: "waiting", waitingReason: "prompt" });
  return pane;
}

type Pane = Awaited<ReturnType<typeof settledAtPrompt>>;

/** Typed a key at a time with its echo, then Enter 1.6 s after the first key. */
async function typeCommand(pane: Pane) {
  for (let i = 1; i <= COMMAND.length; i++) {
    pane.session.notifyInput(COMMAND[i - 1]!);
    await vi.advanceTimersByTimeAsync(5);
    pane.draw(promptFrame(COMMAND.slice(0, i)));
    await vi.advanceTimersByTimeAsync(80);
  }
  await vi.advanceTimersByTimeAsync(1_631 - COMMAND.length * 85);
  pane.session.notifyInput("\r");
}

/** As `terminal.sendCommand` delivers it: one body write, then Enter after the submit delay. */
async function sendCommand(pane: Pane) {
  pane.session.notifySubmission();
  pane.session.notifyInput(COMMAND);
  await vi.advanceTimersByTimeAsync(5);
  pane.draw(promptFrame(COMMAND));
  await vi.advanceTimersByTimeAsync(getSubmitEnterDelay(pane.info) - 5);
  pane.session.notifySubmission();
  pane.session.notifyInput("\r");
}

afterEach(() => {
  while (sessions.length) sessions.pop()?.free();
  events.removeAllListeners();
  vi.useRealTimers();
  vi.clearAllTimers();
});

describe("Claude Code's /rate-limit-options menu (#18175)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 26, 3, 0));
  });

  it.each([
    { how: "typed", submit: typeCommand, pollingIntervalMs: 50 },
    { how: "typed", submit: typeCommand, pollingIntervalMs: 500 },
    { how: "sent", submit: sendCommand, pollingIntervalMs: 50 },
    { how: "sent", submit: sendCommand, pollingIntervalMs: 500 },
  ])(
    "publishes an approval wait while the menu waits on its choice ($how, $pollingIntervalMs ms polling)",
    async ({ submit, pollingIntervalMs }) => {
      const pane = await settledAtPrompt(pollingIntervalMs);
      const publishedChanges: Array<{ state: string; waitingReason?: string; at: number }> = [];
      events.on("agent:state-changed", (payload) =>
        publishedChanges.push({
          state: payload.state,
          waitingReason: payload.waitingReason,
          at: Date.now(),
        })
      );

      await submit(pane);
      await vi.advanceTimersByTimeAsync(23);
      pane.draw(MENU_FRAME);
      const drawnAt = Date.now();
      expect(pane.published()).toEqual({ agentState: "working", waitingReason: undefined });

      // The pane writes nothing more; the first poll after the 8 s quiet window settles it.
      await vi.advanceTimersByTimeAsync(8_000 + pollingIntervalMs);
      expect(pane.published()).toEqual({ agentState: "waiting", waitingReason: "approval" });

      await vi.advanceTimersByTimeAsync(25_000 - (Date.now() - drawnAt));
      expect(pane.published()).toEqual({ agentState: "waiting", waitingReason: "approval" });

      // Escape 35.2 s after the draw, and the prompt redrawn 59 ms later.
      await vi.advanceTimersByTimeAsync(35_177 - (Date.now() - drawnAt));
      pane.session.notifyInput("\x1b");
      await vi.advanceTimersByTimeAsync(59);
      pane.draw(promptFrame());
      const redrawnAt = Date.now();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(pane.published()).toEqual({ agentState: "waiting", waitingReason: "prompt" });

      expect(publishedChanges.map(({ state, waitingReason }) => [state, waitingReason])).toEqual([
        ["working", undefined],
        ["waiting", "approval"],
        ["waiting", "prompt"],
      ]);
      expect(publishedChanges[1]!.at - drawnAt).toBeLessThanOrEqual(8_000 + pollingIntervalMs);
      expect(publishedChanges[2]!.at).toBeGreaterThan(redrawnAt);
    }
  );
});
