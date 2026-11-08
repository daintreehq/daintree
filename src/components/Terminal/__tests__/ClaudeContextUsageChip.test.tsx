// @vitest-environment jsdom
import React from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContextUsageResult } from "@shared/types/ipc/agentContextUsage";

const readContextUsage = vi.hoisted(() => vi.fn());

vi.mock("@/clients/claudeClient", () => ({
  claudeClient: { readContextUsage },
}));

vi.mock("zustand/react/shallow", () => ({
  useShallow: (fn: (...args: unknown[]) => unknown) => fn,
}));

let mockPanel: Record<string, unknown> = {};

vi.mock("@/store", () => ({
  usePanelStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ panelsById: { t1: mockPanel } }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

import { ClaudeContextUsageChip } from "../ClaudeContextUsageChip";
import {
  CONTEXT_USAGE_FIRST_READ_MS,
  __resetClaudeContextUsageCache,
} from "@/hooks/useClaudeContextUsage";

const NOW = Date.parse("2026-09-18T10:05:00.000Z");
const RECORDED = Date.parse("2026-09-18T10:03:00.000Z");

function ok(contextTokens: number): AgentContextUsageResult {
  return { status: "ok", provider: "claude", contextTokens, recordedAt: RECORDED };
}

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CONTEXT_USAGE_FIRST_READ_MS);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  readContextUsage.mockReset();
  readContextUsage.mockResolvedValue(ok(126_717));
  Reflect.set(window, "electron", {});
  __resetClaudeContextUsageCache();
  mockPanel = {
    id: "t1",
    kind: "terminal",
    detectedAgentId: "claude",
    agentState: "waiting",
    startedAt: 1_000,
    agentIncarnation: 0,
  };
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "electron");
});

describe("ClaudeContextUsageChip", () => {
  it("shows the count alone, never a share of a window", async () => {
    render(<ClaudeContextUsageChip terminalId="t1" />);
    await settle();

    const chip = screen.getByTestId("terminal-context-usage");
    expect(chip.textContent).toBe("127k context");
    expect(chip.textContent).not.toMatch(/%|\//);
    expect(screen.getByTestId("tooltip-content").textContent).not.toMatch(/%|of 200/);
  });

  it("names the exact count, where it was read and when, to assistive tech and on hover", async () => {
    render(<ClaudeContextUsageChip terminalId="t1" />);
    await settle();

    const chip = screen.getByTestId("terminal-context-usage");
    const label = chip.getAttribute("aria-label") ?? "";
    expect(label).toContain("126,717 tokens");
    expect(label).toContain("read from the transcript");
    expect(label).toContain(new Date(RECORDED).toLocaleString());
    expect(chip.getAttribute("role")).toBe("status");
    expect(chip.getAttribute("aria-live")).toBe("off");
    expect(chip.tabIndex).toBe(0);

    const tooltip = screen.getByTestId("tooltip-content");
    expect(tooltip.textContent).toContain("126,717 tokens of context");
    expect(tooltip.textContent).toContain("read from the transcript");
    expect(tooltip.querySelector("time")?.getAttribute("dateTime")).toBe(
      new Date(RECORDED).toISOString()
    );
  });

  it("shows no placeholder while there is no reading yet", () => {
    const { container } = render(<ClaudeContextUsageChip terminalId="t1" />);

    expect(container.innerHTML).toBe("");
  });

  it("shows nothing when the transcript gave no reading", async () => {
    readContextUsage.mockResolvedValue({ status: "unavailable", reason: "unrecognized" });
    const { container } = render(<ClaudeContextUsageChip terminalId="t1" />);
    await settle();

    expect(readContextUsage).toHaveBeenCalledTimes(1);
    expect(container.innerHTML).toBe("");
  });

  it.each<[string, Record<string, unknown>]>([
    ["another agent", { detectedAgentId: "codex" }],
    ["a plain shell", { detectedAgentId: undefined }],
    ["an agent that exited", { agentState: "exited" }],
    ["a pane with no process", { hasPty: false }],
  ])("reads nothing and shows nothing for %s", async (_label, change) => {
    mockPanel = { ...mockPanel, ...change };
    const { container } = render(<ClaudeContextUsageChip terminalId="t1" />);
    await settle();

    expect(readContextUsage).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
  });
});
