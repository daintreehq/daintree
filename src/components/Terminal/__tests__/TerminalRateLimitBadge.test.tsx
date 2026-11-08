// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const clock = vi.hoisted(() => ({ now: 0 }));
const dispatchMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }));
const readQuota = vi.hoisted(() => vi.fn());
vi.mock("@/clients/codexClient", () => ({
  codexClient: {
    readQuota: (...args: unknown[]) => readQuota(...args),
    refreshQuota: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));
vi.mock("@/hooks/useGlobalMinuteTicker", () => ({
  useGlobalMinuteClock: () => clock.now,
}));

import { TerminalRateLimitBadge } from "../TerminalRateLimitBadge";
import {
  RATE_LIMIT_OBSERVATION_TTL_MS,
  useRateLimitObservationStore,
} from "@/store/rateLimitObservationStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store/panelStore";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import type { AgentSettings } from "@shared/types/agentSettings";
import type { PtyPanelData } from "@shared/types/panel";

function renderBadge(terminalId: string) {
  return render(
    <TooltipProvider>
      <TerminalRateLimitBadge terminalId={terminalId} />
    </TooltipProvider>
  );
}

beforeEach(() => {
  readQuota.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  useRateLimitObservationStore.setState({ observedAtByTerminalId: {} });
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
});

describe("TerminalRateLimitBadge (#12797)", () => {
  it("renders nothing for a pane with no observation", () => {
    renderBadge("t1");
    expect(screen.queryByTestId("terminal-rate-limit-badge")).toBeNull();
  });

  it("shows the observation only on the pane it was seen in", () => {
    const observedAt = 1_700_000_000_000;
    clock.now = observedAt + 60_000;
    useRateLimitObservationStore.setState({ observedAtByTerminalId: { t1: observedAt } });

    renderBadge("t1");
    renderBadge("t2");

    const badges = screen.queryAllByTestId("terminal-rate-limit-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toBe("Rate limit reported");
  });

  it("disappears once the retention window has passed", () => {
    const observedAt = 1_700_000_000_000;
    clock.now = observedAt + RATE_LIMIT_OBSERVATION_TTL_MS - 60_000;
    useRateLimitObservationStore.setState({ observedAtByTerminalId: { t1: observedAt } });

    const view = renderBadge("t1");
    expect(screen.queryByTestId("terminal-rate-limit-badge")).not.toBeNull();

    clock.now = observedAt + RATE_LIMIT_OBSERVATION_TTL_MS;
    view.rerender(
      <TooltipProvider>
        <TerminalRateLimitBadge terminalId="t1" />
      </TooltipProvider>
    );
    expect(screen.queryByTestId("terminal-rate-limit-badge")).toBeNull();
  });

  it("stays a status chip on a pane with nowhere else to move (#13746)", () => {
    const observedAt = 1_700_000_000_000;
    clock.now = observedAt + 60_000;
    useRateLimitObservationStore.setState({ observedAtByTerminalId: { t1: observedAt } });

    renderBadge("t1");

    const badge = screen.getByTestId("terminal-rate-limit-badge");
    expect(badge.tagName).toBe("DIV");
    expect(badge.getAttribute("role")).toBe("status");
  });

  it("opens a preset menu on an agent pane that has another preset (#13746)", () => {
    const observedAt = 1_700_000_000_000;
    clock.now = observedAt + 60_000;
    useRateLimitObservationStore.setState({ observedAtByTerminalId: { t1: observedAt } });
    const settings: AgentSettings = {
      agents: {
        codex: {
          customPresets: [
            { id: "personal", name: "Personal" },
            { id: "work", name: "Work" },
          ],
        },
      },
    };
    useAgentSettingsStore.setState({ settings });
    const pane: PtyPanelData = {
      id: "t1",
      kind: "terminal",
      title: "Codex [Personal]",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      location: "grid",
      launchAgentId: "codex",
      agentPresetId: "personal",
    };
    usePanelStore.setState({ panelsById: { t1: pane }, panelIds: ["t1"] });

    renderBadge("t1");

    const badge = screen.getByTestId("terminal-rate-limit-badge");
    expect(badge.textContent).toBe("Rate limit reported");
    act(() => {
      fireEvent.keyDown(badge, { key: "Enter" });
    });

    // Only the other preset is offered; the pane is already on Personal.
    const items = screen.getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Work"]);
    act(() => {
      fireEvent.click(items[0]!);
    });

    // Asked even though the agent isn't working: the conversation ends either way.
    expect(screen.getByText("Restart 'Codex [Personal]' on 'Work'?")).toBeTruthy();
    expect(dispatchMock).not.toHaveBeenCalled();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Restart on preset" }));
    });
    expect(dispatchMock).toHaveBeenCalledWith(
      "terminal.restartOnPreset",
      { terminalId: "t1", presetId: "work", confirmed: true },
      { source: "user" }
    );
  });

  it("shows each account's known quota window in the switch menu, read only once it opens (#16407)", async () => {
    const observedAt = 1_700_000_000_000;
    clock.now = observedAt + 60_000;
    useRateLimitObservationStore.setState({ observedAtByTerminalId: { t1: observedAt } });
    useAgentSettingsStore.setState({
      settings: {
        agents: {
          codex: {
            accounts: [{ id: "lab", name: "Lab", configDir: "/Users/me/.codex-lab" }],
          },
        },
      } as AgentSettings,
    });
    readQuota.mockResolvedValue([
      {
        key: "lab",
        isDefault: false,
        presetNames: [],
        accountIds: ["lab"],
        result: {
          status: "ok",
          planType: null,
          windows: [{ usedPercent: 35, windowDurationMins: 10080, resetsAt: null }],
          fetchedAt: Date.now(),
        },
      },
    ]);
    const pane: PtyPanelData = {
      id: "t1",
      kind: "terminal",
      title: "Codex",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      location: "grid",
      launchAgentId: "codex",
    };
    usePanelStore.setState({ panelsById: { t1: pane }, panelIds: ["t1"] });

    renderBadge("t1");
    await act(async () => {});
    expect(readQuota).not.toHaveBeenCalled();

    act(() => {
      fireEvent.keyDown(screen.getByTestId("terminal-rate-limit-badge"), { key: "Enter" });
    });
    await act(async () => {});
    expect(readQuota).toHaveBeenCalled();
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
    // The pane is on the default login, so the only move is to Lab.
    expect(items).toEqual(["LabWeekly limit 35% used"]);
  });
});
