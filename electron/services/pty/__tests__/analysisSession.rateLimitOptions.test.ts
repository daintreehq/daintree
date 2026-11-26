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

/** What the pane already shows above Claude Code's live area: a short session, or one filling the pane. */
const HISTORIES = {
  short: ["● The parser now handles empty input, and its tests pass.", ""],
  filled: Array.from({ length: ROWS * 2 }, (_, i) => `  ⎿  Read src/parser/part${i}.ts`),
};

/** Claude Code 2.1.332's live area at its input row, with a draft's slash suggestion under it. */
function promptArea(draft = ""): string[] {
  const below =
    draft === ""
      ? ["  ? for shortcuts"]
      : [`  ${COMMAND}   Choose what to do when you hit a usage limit`];
  return [RULE, `❯ ${draft}`, RULE, ...below];
}

// The menu `/rate-limit-options` opens in place of the input row, reconstructed
// from a 120×40 capture of Claude Code 2.1.332: drawn once 23 ms after Enter,
// then no byte for 35.2 s until Escape (#18175).
const MENU_AREA = [
  `❯ ${COMMAND}`,
  "  What do you want to do?",
  "  ❯ 1. Stop and wait for limit to reset",
  "    2. Switch to usage credits",
  "  Enter to confirm · Esc to cancel",
];

/**
 * An Ink renderer: the history is written once, and each live-area frame
 * erases the one before it and redraws in place.
 */
function inkRenderer(history: string[]) {
  let drawn = 0;
  return (lines: string[]): string => {
    const lead = drawn === 0 ? history.map((line) => `${line}\r\n`).join("") : "";
    const erase = drawn === 0 ? "" : "\x1b[2K\x1b[1A".repeat(drawn - 1) + "\x1b[2K\x1b[G";
    drawn = lines.length;
    return `\x1b[?2026h${lead}${erase}${lines.join("\r\n")}\x1b[?2026l`;
  };
}

/** A Claude pane already published as waiting at its empty input row. */
function settledInfo(): TerminalInfo {
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
    agentState: "waiting",
    waitingReason: "prompt",
    lastStateChange: 0,
    ptyProcess: {} as never,
    semanticBuffer: [],
  } as unknown as TerminalInfo;
}

const sessions: AnalysisSession[] = [];
const unsubscribers: Array<() => void> = [];

/** A worker-side Claude pane, idle at its input row, whose activity reaches a real AgentStateService. */
async function claudePaneAtPrompt(history: string[], pollingIntervalMs: number) {
  const info = settledInfo();
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
  const render = inkRenderer(history);
  const draw = (lines: string[]) =>
    session.feedChunk(render(lines), { agentLive: true, agentState: info.agentState });
  const published = () => ({ agentState: info.agentState, waitingReason: info.waitingReason });

  draw(promptArea());
  await vi.advanceTimersByTimeAsync(100);
  session.startMonitor({
    agentId: "claude",
    initialState: "idle",
    skipInitialStateEmit: true,
    hasProcessValidator: false,
    pollingIntervalMs,
  });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(published()).toEqual({ agentState: "waiting", waitingReason: "prompt" });
  return { info, session, draw, published };
}

type Pane = Awaited<ReturnType<typeof claudePaneAtPrompt>>;

/** Typed a key at a time with its echo, then Enter 1.6 s after the first key. */
async function typeCommand(pane: Pane) {
  for (let i = 1; i <= COMMAND.length; i++) {
    pane.session.notifyInput(COMMAND[i - 1]!);
    await vi.advanceTimersByTimeAsync(5);
    pane.draw(promptArea(COMMAND.slice(0, i)));
    await vi.advanceTimersByTimeAsync(80);
  }
  await vi.advanceTimersByTimeAsync(1_631 - COMMAND.length * 85);
  pane.session.notifyInput("\r");
}

/**
 * As `terminal.sendCommand` delivers it on an idle lane: the submission noted at
 * enqueue and again as it runs, one body write, then Enter after the submit delay.
 */
async function sendCommand(pane: Pane) {
  pane.session.notifySubmission();
  pane.session.notifySubmission();
  pane.session.notifyInput(COMMAND);
  expect(pane.published().agentState).toBe("working");
  await vi.advanceTimersByTimeAsync(5);
  pane.draw(promptArea(COMMAND));
  await vi.advanceTimersByTimeAsync(getSubmitEnterDelay(pane.info) - 5);
  pane.session.notifyInput("\r");
}

afterEach(() => {
  while (sessions.length) sessions.pop()?.free();
  while (unsubscribers.length) unsubscribers.pop()?.();
  vi.useRealTimers();
});

describe("Claude Code's /rate-limit-options menu (#18175)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 26, 3, 0));
  });

  const cases = (["short", "filled"] as const).flatMap((history) =>
    (
      [
        ["typed", typeCommand],
        ["sent", sendCommand],
      ] as const
    ).flatMap(([how, submit]) =>
      [50, 500].map((pollingIntervalMs) => ({ history, how, submit, pollingIntervalMs }))
    )
  );

  it.each(cases)(
    "publishes an approval wait while the menu waits on its choice ($history history, $how, $pollingIntervalMs ms polling)",
    async ({ history, submit, pollingIntervalMs }) => {
      const pane = await claudePaneAtPrompt(HISTORIES[history], pollingIntervalMs);
      const publishedChanges: Array<{ state: string; waitingReason?: string; at: number }> = [];
      unsubscribers.push(
        events.on("agent:state-changed", (payload) =>
          publishedChanges.push({
            state: payload.state,
            waitingReason: payload.waitingReason,
            at: Date.now(),
          })
        )
      );

      await submit(pane);
      await vi.advanceTimersByTimeAsync(23);
      pane.draw(MENU_AREA);
      const drawnAt = Date.now();
      expect(pane.published()).toEqual({ agentState: "working", waitingReason: undefined });

      // The pane writes nothing more, and it reads as an approval wait by the
      // first poll after 8 quiet seconds.
      await vi.advanceTimersByTimeAsync(8_000 + pollingIntervalMs);
      expect(pane.published()).toEqual({ agentState: "waiting", waitingReason: "approval" });

      await vi.advanceTimersByTimeAsync(25_000 - (Date.now() - drawnAt));
      expect(pane.published()).toEqual({ agentState: "waiting", waitingReason: "approval" });

      // Escape 35.2 s after the draw, and the input row redrawn 59 ms later.
      await vi.advanceTimersByTimeAsync(35_177 - (Date.now() - drawnAt));
      pane.session.notifyInput("\x1b");
      await vi.advanceTimersByTimeAsync(59);
      pane.draw(promptArea());
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
