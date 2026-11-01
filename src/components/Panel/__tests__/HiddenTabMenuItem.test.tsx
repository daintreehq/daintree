// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { act, render } from "@testing-library/react";
import type { FleetRunRow } from "@shared/types/ipc/fleet";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { HiddenTabMenuItem } from "../HiddenTabMenuItem";
import type { TabInfo } from "../TabButton";

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => (
    <div role="menuitem">{children}</div>
  ),
}));

vi.mock("@/components/Terminal/TerminalIcon", () => ({
  TerminalIcon: () => <span data-terminal-icon="" />,
}));

// A tab scrolled out of the strip reads its run the way the tab does (#16057):
// amber only for an unread Canopy ask, never for a prompt that asks nothing.

afterEach(() => {
  useFleetSnapshotStore.setState({ snapshot: null });
});

function deliverRun(overrides: Partial<FleetRunRow>) {
  act(() => {
    useFleetSnapshotStore.getState().applySnapshot({
      runs: [
        {
          runId: "tab-1",
          workspaceId: "p1",
          spawnedAt: 1,
          cwd: "/repo",
          agentState: "waiting",
          ...overrides,
        },
      ],
      changedAt: 2,
      degraded: false,
      lastSuccessfulAt: 2,
    });
  });
}

const tab: TabInfo = {
  id: "tab-1",
  title: "Claude",
  kind: "terminal",
  chrome: deriveTerminalChrome({ launchAgentId: "claude" }),
  agentState: "waiting",
  isActive: false,
};

const spoken = (container: HTMLElement) => container.querySelector(".sr-only")?.textContent ?? "";

describe("HiddenTabMenuItem", () => {
  it("says nothing for a prompt that asks nothing, and waiting for an unread ask", () => {
    const { container } = render(<HiddenTabMenuItem tab={tab} onSelect={vi.fn()} />);
    deliverRun({});
    expect(spoken(container)).toBe("");
    expect(container.querySelector(".text-state-waiting")).toBeNull();
    deliverRun({ canopy: { kind: "asked", quote: "Run it?", readAt: 1, seen: false } });
    expect(spoken(container)).toBe(", waiting");
    expect(container.querySelector(".text-state-waiting")).not.toBeNull();
  });

  it("says unread for a hand-back, finished once read, and blocked for an error wait", () => {
    const { container } = render(<HiddenTabMenuItem tab={tab} onSelect={vi.fn()} />);
    deliverRun({ handBack: { stoppedAt: 1 } });
    expect(spoken(container)).toBe(", unread");
    deliverRun({ handBack: { stoppedAt: 1, seenAt: 2 } });
    expect(spoken(container)).toBe(", finished");
    deliverRun({ waitingReason: "error" });
    expect(spoken(container)).toBe(", blocked");
  });
});
