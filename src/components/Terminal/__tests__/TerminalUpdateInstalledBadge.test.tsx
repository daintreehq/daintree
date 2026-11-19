// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const clock = vi.hoisted(() => ({ now: 0 }));
vi.mock("@/hooks/useGlobalMinuteTicker", () => ({
  useGlobalMinuteClock: () => clock.now,
}));

import { TerminalUpdateInstalledBadge } from "../TerminalUpdateInstalledBadge";
import { TooltipProvider } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store/panelStore";
import type { PtyPanelData } from "@shared/types/panel";
import type { UpdateInstalledObservation } from "@shared/types/ipc/agent";

const OBSERVED_AT = 1_700_000_000_000;

function pane(id: string, updateInstalled?: UpdateInstalledObservation): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: "Claude",
    cwd: "/repo",
    cols: 80,
    rows: 24,
    location: "grid",
    launchAgentId: "claude",
    detectedAgentId: "claude",
    ...(updateInstalled && { updateInstalled }),
  };
}

function renderBadge(terminalId: string) {
  return render(
    <TooltipProvider>
      <TerminalUpdateInstalledBadge terminalId={terminalId} />
    </TooltipProvider>
  );
}

afterEach(() => {
  cleanup();
  usePanelStore.setState({ panelsById: {}, panelIds: [] });
});

describe("TerminalUpdateInstalledBadge (#17905)", () => {
  it("shows the observation only on the pane that carries it", () => {
    clock.now = OBSERVED_AT + 5 * 60_000;
    usePanelStore.setState({
      panelsById: {
        t1: pane("t1", { observedAt: OBSERVED_AT, namesRestart: true }),
        t2: pane("t2"),
      },
      panelIds: ["t1", "t2"],
    });

    renderBadge("t1");
    renderBadge("t2");

    const badges = screen.queryAllByTestId("terminal-update-installed-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toBe("Update installed");
  });

  it("goes when the host clears the observation", () => {
    usePanelStore.setState({
      panelsById: { t1: pane("t1", { observedAt: OBSERVED_AT, namesRestart: false }) },
      panelIds: ["t1"],
    });
    renderBadge("t1");
    expect(screen.queryByTestId("terminal-update-installed-badge")).not.toBeNull();

    act(() => {
      usePanelStore.getState().setUpdateInstalled("t1", undefined);
    });

    expect(screen.queryByTestId("terminal-update-installed-badge")).toBeNull();
  });

  it.each([
    [true, true],
    [false, false],
  ])("says whether the footer named /restart (%s)", async (namesRestart, mentioned) => {
    clock.now = OBSERVED_AT + 5 * 60_000;
    usePanelStore.setState({
      panelsById: { t1: pane("t1", { observedAt: OBSERVED_AT, namesRestart }) },
      panelIds: ["t1"],
    });
    renderBadge("t1");

    act(() => {
      fireEvent.focus(screen.getByTestId("terminal-update-installed-badge"));
    });
    const tooltip = await screen.findByRole("tooltip");

    expect(tooltip.textContent).toContain("Update installed");
    expect(tooltip.textContent?.includes("/restart")).toBe(mentioned);
  });
});
