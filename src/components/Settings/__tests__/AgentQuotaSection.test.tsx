// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { CodexQuotaResult } from "@shared/types/ipc/agentQuota";

const readQuota = vi.hoisted(() => vi.fn<() => Promise<CodexQuotaResult>>());
const clock = vi.hoisted(() => ({ now: 0 }));

vi.mock("@/clients/codexClient", () => ({ codexClient: { readQuota } }));
vi.mock("@/hooks/useGlobalMinuteTicker", () => ({
  useGlobalMinuteClock: () => clock.now,
}));

import { AgentQuotaSection, windowLabel } from "../AgentQuotaSection";

const NOW = 1_700_000_000_000;

function meters() {
  return Array.from(document.querySelectorAll('[role="meter"]'));
}

async function renderFor(agentId: string) {
  render(<AgentQuotaSection agentId={agentId} />);
  await act(async () => {});
}

beforeEach(() => {
  clock.now = NOW;
  readQuota.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("AgentQuotaSection (#12797)", () => {
  it("says Claude's live quota is unavailable without asking for it", async () => {
    await renderFor("claude");
    expect(screen.getByText("Live quota unavailable")).toBeTruthy();
    expect(readQuota).not.toHaveBeenCalled();
    expect(meters()).toHaveLength(0);
  });

  it("renders nothing for an agent with no quota story", async () => {
    await renderFor("gemini");
    expect(document.body.textContent).toBe("");
    expect(readQuota).not.toHaveBeenCalled();
  });

  it("shows each Codex window as a meter with its percentage and reset", async () => {
    readQuota.mockResolvedValue({
      status: "ok",
      planType: "plus",
      fetchedAt: NOW,
      windows: [
        { usedPercent: 42.4, windowDurationMins: 300, resetsAt: NOW + 3_600_000 },
        { usedPercent: 7, windowDurationMins: 10080, resetsAt: null },
      ],
    });
    await renderFor("codex");

    expect(meters().map((m) => m.getAttribute("aria-valuenow"))).toEqual(["42", "7"]);
    expect(screen.getByText("5-hour limit")).toBeTruthy();
    expect(screen.getByText("Weekly limit")).toBeTruthy();
    expect(screen.getByText("Reset time not reported")).toBeTruthy();
    expect(screen.getByText("Current reading")).toBeTruthy();
  });

  it("shows unavailable, with no meter, when Codex reports no quota", async () => {
    readQuota.mockResolvedValue({ status: "unavailable", reason: "read-failed", fetchedAt: NOW });
    await renderFor("codex");

    expect(screen.getByText("Quota unavailable")).toBeTruthy();
    expect(meters()).toHaveLength(0);
    expect(document.body.textContent).not.toContain("0%");
  });

  it("treats a rejected IPC read as unavailable rather than zero", async () => {
    readQuota.mockRejectedValue(new Error("ipc gone"));
    await renderFor("codex");

    expect(screen.getByText("Quota unavailable")).toBeTruthy();
    expect(meters()).toHaveLength(0);
  });

  it("marks an old reading stale instead of presenting it as current", async () => {
    readQuota.mockResolvedValue({
      status: "ok",
      planType: null,
      fetchedAt: NOW - 10 * 60_000,
      windows: [{ usedPercent: 50, windowDurationMins: 300, resetsAt: NOW - 1 }],
    });
    await renderFor("codex");

    expect(screen.getByText("Stale reading")).toBeTruthy();
    expect(meters()[0].getAttribute("aria-valuetext")).toBe("50% used, stale");
    expect(screen.getByText("Reset time has passed. Waiting for a new reading.")).toBeTruthy();
  });
});

describe("windowLabel", () => {
  it("names windows by duration", () => {
    expect(windowLabel(300)).toBe("5-hour limit");
    expect(windowLabel(10080)).toBe("Weekly limit");
    expect(windowLabel(1440)).toBe("1-day limit");
    expect(windowLabel(90)).toBe("90-minute limit");
  });
});
