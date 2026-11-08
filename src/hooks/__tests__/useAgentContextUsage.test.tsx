// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readContextUsage = vi.hoisted(() => vi.fn());
const readCodexContextUsage = vi.hoisted(() => vi.fn());

vi.mock("@/clients/claudeClient", () => ({
  claudeClient: { readContextUsage },
}));

vi.mock("@/clients/codexClient", () => ({
  codexClient: { readContextUsage: readCodexContextUsage },
}));

import {
  CONTEXT_USAGE_FIRST_READ_MS,
  CONTEXT_USAGE_FOLLOW_UP_READ_MS,
  CONTEXT_USAGE_MOUNT_FLOOR_MS,
  __resetAgentContextUsageCache,
  useAgentContextUsage,
} from "../useAgentContextUsage";
import type { AgentState } from "@/types";
import type {
  AgentContextUsageProvider,
  AgentContextUsageResult,
} from "@shared/types/ipc/agentContextUsage";

const STAMP = Date.parse("2026-09-18T10:00:00.000Z");

function ok(contextTokens: number, recordedAt = STAMP): AgentContextUsageResult {
  return { status: "ok", provider: "claude", contextTokens, recordedAt };
}

interface Props {
  provider?: AgentContextUsageProvider;
  enabled: boolean;
  agentState?: AgentState;
  generation: string;
}

function mount(initial: Partial<Props> = {}) {
  return renderHook(
    ({ provider = "claude", ...props }: Props) =>
      useAgentContextUsage("t-1", { provider, ...props }),
    { initialProps: { enabled: true, agentState: "waiting", generation: "1:0", ...initial } }
  );
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  readContextUsage.mockReset();
  readContextUsage.mockResolvedValue(ok(126_717));
  readCodexContextUsage.mockReset();
  readCodexContextUsage.mockResolvedValue({
    status: "ok",
    provider: "codex",
    contextTokens: 192_480,
    contextWindow: 475_000,
    recordedAt: STAMP,
  });
  Reflect.set(window, "electron", {});
  __resetAgentContextUsageCache();
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "electron");
});

describe("useAgentContextUsage", () => {
  it("reads once when a pane mounts settled", async () => {
    const { result } = mount();

    expect(result.current).toBeNull();
    await advance(CONTEXT_USAGE_FIRST_READ_MS);

    expect(readContextUsage).toHaveBeenCalledTimes(1);
    expect(readContextUsage).toHaveBeenCalledWith({ terminalId: "t-1" });
    expect(result.current).toEqual({ contextTokens: 126_717, recordedAt: STAMP });

    await advance(CONTEXT_USAGE_FOLLOW_UP_READ_MS * 5);
    expect(readContextUsage).toHaveBeenCalledTimes(1);
  });

  it("reads nothing while the agent works, then twice once its turn settles", async () => {
    const { result, rerender } = mount({ agentState: "working" });
    await advance(CONTEXT_USAGE_FOLLOW_UP_READ_MS * 5);
    expect(readContextUsage).not.toHaveBeenCalled();
    expect(result.current).toBeNull();

    readContextUsage.mockResolvedValueOnce(ok(90_000)).mockResolvedValueOnce(ok(91_000));
    rerender({ enabled: true, agentState: "waiting", generation: "1:0" });
    await advance(CONTEXT_USAGE_FIRST_READ_MS);
    expect(readContextUsage).toHaveBeenCalledTimes(1);
    expect(result.current?.contextTokens).toBe(90_000);

    await advance(CONTEXT_USAGE_FOLLOW_UP_READ_MS - CONTEXT_USAGE_FIRST_READ_MS);
    expect(readContextUsage).toHaveBeenCalledTimes(2);
    expect(result.current?.contextTokens).toBe(91_000);
  });

  it("reads after every turn, however soon after the last reading", async () => {
    const { rerender } = mount({ agentState: "working" });
    for (const turn of [1, 2, 3]) {
      rerender({ enabled: true, agentState: "waiting", generation: "1:0" });
      await advance(CONTEXT_USAGE_FOLLOW_UP_READ_MS);
      expect(readContextUsage).toHaveBeenCalledTimes(turn * 2);
      rerender({ enabled: true, agentState: "working", generation: "1:0" });
    }
  });

  // Waiting then completed is one boundary, not two, and must not cancel the
  // follow-up the first one scheduled.
  it("treats a move between settled states as the same boundary", async () => {
    const { rerender } = mount({ agentState: "working" });
    rerender({ enabled: true, agentState: "waiting", generation: "1:0" });
    await advance(CONTEXT_USAGE_FIRST_READ_MS);
    rerender({ enabled: true, agentState: "completed", generation: "1:0" });
    await advance(CONTEXT_USAGE_FOLLOW_UP_READ_MS);

    expect(readContextUsage).toHaveBeenCalledTimes(2);
  });

  // Starting to type a reply is not the agent working again: the turn's reads
  // still happen.
  it("keeps the turn's reads when someone starts typing a reply", async () => {
    const { rerender } = mount({ agentState: "working" });
    rerender({ enabled: true, agentState: "waiting", generation: "1:0" });
    await advance(100);
    rerender({ enabled: true, agentState: "directing", generation: "1:0" });
    await advance(CONTEXT_USAGE_FOLLOW_UP_READ_MS);

    expect(readContextUsage).toHaveBeenCalledTimes(2);
  });

  // The follow-up exists to catch records the first read was too early for; a
  // first read still out when it fires may have been, so it is not reused.
  it("asks again for the follow-up rather than reusing a first read still out", async () => {
    const answers: ((value: AgentContextUsageResult) => void)[] = [];
    readContextUsage.mockImplementation(
      () => new Promise<AgentContextUsageResult>((resolve) => answers.push(resolve))
    );
    const { result, rerender } = mount({ agentState: "working" });
    rerender({ enabled: true, agentState: "waiting", generation: "1:0" });
    await advance(CONTEXT_USAGE_FOLLOW_UP_READ_MS);
    expect(readContextUsage).toHaveBeenCalledTimes(1);

    await act(async () => answers[0]!(ok(80_000)));
    expect(readContextUsage).toHaveBeenCalledTimes(2);
    await act(async () => answers[1]!(ok(81_000)));

    expect(result.current?.contextTokens).toBe(81_000);
  });

  it("asks nothing more once work resumes behind a follow-up still queued", async () => {
    let answer: (value: AgentContextUsageResult) => void = () => {};
    readContextUsage.mockImplementation(
      () => new Promise<AgentContextUsageResult>((resolve) => (answer = resolve))
    );
    const { rerender } = mount({ agentState: "working" });
    rerender({ enabled: true, agentState: "waiting", generation: "1:0" });
    await advance(CONTEXT_USAGE_FOLLOW_UP_READ_MS);
    rerender({ enabled: true, agentState: "working", generation: "1:0" });
    await act(async () => answer(ok(80_000)));
    await advance(CONTEXT_USAGE_FOLLOW_UP_READ_MS);

    expect(readContextUsage).toHaveBeenCalledTimes(1);
  });

  // A turn's reads are spent once its cycle runs: going quiet and coming back
  // without working again is no new turn.
  it("doesn't count one turn twice", async () => {
    const { rerender } = mount({ agentState: "working" });
    rerender({ enabled: true, agentState: "waiting", generation: "1:0" });
    await advance(CONTEXT_USAGE_FOLLOW_UP_READ_MS);
    expect(readContextUsage).toHaveBeenCalledTimes(2);

    rerender({ enabled: false, agentState: "waiting", generation: "1:0" });
    rerender({ enabled: true, agentState: "waiting", generation: "1:0" });
    await advance(CONTEXT_USAGE_FOLLOW_UP_READ_MS);

    expect(readContextUsage).toHaveBeenCalledTimes(2);
  });

  it("cancels the reads still pending when work resumes", async () => {
    const { rerender } = mount({ agentState: "working" });
    rerender({ enabled: true, agentState: "waiting", generation: "1:0" });
    await advance(CONTEXT_USAGE_FIRST_READ_MS - 1);
    rerender({ enabled: true, agentState: "working", generation: "1:0" });
    await advance(CONTEXT_USAGE_FOLLOW_UP_READ_MS * 5);

    expect(readContextUsage).not.toHaveBeenCalled();
  });

  it("keeps the last reading on screen while the next turn works", async () => {
    const { result, rerender } = mount();
    await advance(CONTEXT_USAGE_FIRST_READ_MS);
    rerender({ enabled: true, agentState: "working", generation: "1:0" });

    expect(result.current?.contextTokens).toBe(126_717);
  });

  it("drops the reading when the next read answers that there is none", async () => {
    const { result, rerender } = mount();
    await advance(CONTEXT_USAGE_FIRST_READ_MS);
    expect(result.current).not.toBeNull();

    readContextUsage.mockResolvedValue({ status: "unavailable", reason: "unrecognized" });
    rerender({ enabled: true, agentState: "working", generation: "1:0" });
    rerender({ enabled: true, agentState: "waiting", generation: "1:0" });
    await advance(CONTEXT_USAGE_FIRST_READ_MS);

    expect(result.current).toBeNull();
  });

  it("drops the reading when the next read itself fails", async () => {
    const { result, rerender } = mount();
    await advance(CONTEXT_USAGE_FIRST_READ_MS);
    expect(result.current).not.toBeNull();

    readContextUsage.mockRejectedValue(new Error("EACCES: /Users/x/.claude/projects/a.jsonl"));
    rerender({ enabled: true, agentState: "working", generation: "1:0" });
    rerender({ enabled: true, agentState: "waiting", generation: "1:0" });
    await advance(CONTEXT_USAGE_FIRST_READ_MS);

    expect(result.current).toBeNull();
  });

  it("reads nothing and shows nothing for a pane it isn't enabled for", async () => {
    const { result } = mount({ enabled: false });
    await advance(CONTEXT_USAGE_FOLLOW_UP_READ_MS * 5);

    expect(readContextUsage).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("hides the reading once the agent is gone", async () => {
    const { result, rerender } = mount();
    await advance(CONTEXT_USAGE_FIRST_READ_MS);
    rerender({ enabled: false, agentState: "exited", generation: "1:0" });

    expect(result.current).toBeNull();
  });

  it("never shows the previous session's reading for a new one", async () => {
    const { result, rerender } = mount();
    await advance(CONTEXT_USAGE_FIRST_READ_MS);
    readContextUsage.mockResolvedValue(ok(5_000));

    rerender({ enabled: true, agentState: "waiting", generation: "2:0" });
    expect(result.current).toBeNull();
    await advance(CONTEXT_USAGE_FIRST_READ_MS);

    expect(result.current?.contextTokens).toBe(5_000);
  });

  it("rehydrates a remount from its cache without reading again", async () => {
    const first = mount();
    await advance(CONTEXT_USAGE_FIRST_READ_MS);
    first.unmount();

    const second = mount();
    expect(second.result.current?.contextTokens).toBe(126_717);
    await advance(CONTEXT_USAGE_FOLLOW_UP_READ_MS);
    expect(readContextUsage).toHaveBeenCalledTimes(1);

    second.unmount();
    await advance(CONTEXT_USAGE_MOUNT_FLOOR_MS);
    mount();
    await advance(CONTEXT_USAGE_FIRST_READ_MS);
    expect(readContextUsage).toHaveBeenCalledTimes(2);
  });

  it("asks once for two instances of the same session", async () => {
    let answer: (value: AgentContextUsageResult) => void = () => {};
    readContextUsage.mockImplementation(
      () => new Promise<AgentContextUsageResult>((resolve) => (answer = resolve))
    );
    const a = mount();
    const b = mount();
    await advance(CONTEXT_USAGE_FIRST_READ_MS);
    await act(async () => answer(ok(42_000)));

    expect(readContextUsage).toHaveBeenCalledTimes(1);
    expect(a.result.current?.contextTokens).toBe(42_000);
    expect(b.result.current?.contextTokens).toBe(42_000);
  });

  it("leaves no timer behind on unmount", async () => {
    const { unmount } = mount();
    unmount();
    await advance(CONTEXT_USAGE_FOLLOW_UP_READ_MS * 5);

    expect(readContextUsage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("useAgentContextUsage for Codex", () => {
  it("asks the Codex reader and keeps the window the rollout states", async () => {
    const { result } = mount({ provider: "codex" });
    await advance(CONTEXT_USAGE_FIRST_READ_MS);

    expect(readContextUsage).not.toHaveBeenCalled();
    expect(readCodexContextUsage).toHaveBeenCalledWith({ terminalId: "t-1" });
    expect(result.current).toEqual({
      contextTokens: 192_480,
      contextWindow: 475_000,
      recordedAt: STAMP,
    });
  });

  it("takes no window when the rollout states none", async () => {
    readCodexContextUsage.mockResolvedValue({
      status: "ok",
      provider: "codex",
      contextTokens: 25_757,
      recordedAt: STAMP,
    });
    const { result } = mount({ provider: "codex" });
    await advance(CONTEXT_USAGE_FIRST_READ_MS);

    expect(result.current).toEqual({ contextTokens: 25_757, recordedAt: STAMP });
  });

  it("refuses an answer about another agent than the one it asked about", async () => {
    readCodexContextUsage.mockResolvedValue(ok(126_717));
    const { result } = mount({ provider: "codex" });
    await advance(CONTEXT_USAGE_FIRST_READ_MS);

    expect(readCodexContextUsage).toHaveBeenCalledTimes(1);
    expect(result.current).toBeNull();
  });

  it("keeps each agent's reading of the same pane apart", async () => {
    const { result, rerender } = mount();
    await advance(CONTEXT_USAGE_FIRST_READ_MS);
    expect(result.current?.contextTokens).toBe(126_717);

    rerender({ provider: "codex", enabled: true, agentState: "waiting", generation: "1:0" });
    expect(result.current).toBeNull();
    await advance(CONTEXT_USAGE_FIRST_READ_MS);

    expect(readCodexContextUsage).toHaveBeenCalledTimes(1);
    expect(result.current?.contextTokens).toBe(192_480);
  });

  it("doesn't take one agent's turn as the next one's", async () => {
    const { rerender } = mount({ agentState: "working" });
    rerender({ provider: "codex", enabled: true, agentState: "waiting", generation: "1:0" });
    await advance(CONTEXT_USAGE_FOLLOW_UP_READ_MS * 5);

    // A pane that settled under another agent reads once, as a mount would.
    expect(readCodexContextUsage).toHaveBeenCalledTimes(1);
    expect(readContextUsage).not.toHaveBeenCalled();
  });
});
