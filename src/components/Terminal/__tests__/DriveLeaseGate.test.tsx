// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { DriveLeaseView } from "@shared/types/ipc/driveLease";
import { DriveLeaseGate } from "../DriveLeaseGate";
import {
  _resetDriveLeaseBannerForTesting,
  seedDriveLeaseView,
} from "@/components/Recovery/driveLeaseState";
import {
  _resetTerminalInputGateForTesting,
  setHostInputBlock,
} from "@/services/terminal/inputGate";
import { setTakeControlPending } from "@/components/Recovery/takeControlPending";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";

vi.mock("@/config/agents", () => ({
  getAgentConfig: (id: string) => (id === "claude" ? { name: "Claude" } : undefined),
}));

function heldBy(clientName: string, holderAwayMs?: number): DriveLeaseView {
  return {
    projectId: "p1",
    holder: {
      leaseId: 4,
      endpointId: "view-2",
      clientId: "client-2",
      clientName,
      isHostLocal: false,
      acquiredAt: 1,
    },
    drivingHere: false,
    isHolderEndpoint: false,
    viewerIsHostLocal: true,
    ...(holderAwayMs !== undefined ? { holderAwayMs } : {}),
  };
}

afterEach(() => {
  cleanup();
  _resetDriveLeaseBannerForTesting();
  _resetTerminalInputGateForTesting();
});

describe("DriveLeaseGate", () => {
  it("names the waiting agent and says it starts on its own", () => {
    render(<DriveLeaseGate agentId="claude" />);

    const text = screen.getByRole("status").textContent;
    expect(text).toContain("Claude is waiting for control");
    expect(text).toContain("Claude starts here on its own once this window has control");
  });

  it("falls back to the agent id when the registry has no name for it", () => {
    render(<DriveLeaseGate agentId="custom" />);

    expect(screen.getByRole("status").textContent).toContain("custom starts here");
  });

  it("speaks of the terminal for a plain shell", () => {
    render(<DriveLeaseGate />);

    expect(screen.getByRole("status").textContent).toContain("The terminal starts here");
  });

  it("names who has control and offers it here, with what that does to them", () => {
    act(() => seedDriveLeaseView(heldBy("greg-mbp")));
    render(<DriveLeaseGate agentId="claude" />);

    expect(screen.getByRole("status").textContent).toContain("greg-mbp has control");
    const button = screen.getByRole("button", { name: "Take control" });
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy && document.getElementById(describedBy)?.textContent).toContain(
      "read-only on greg-mbp"
    );
  });

  it("keeps Take control readable and its consequence in place while a take-over is in flight (#15304)", () => {
    vi.useFakeTimers();
    try {
      act(() => seedDriveLeaseView(heldBy("greg-mbp")));
      render(<DriveLeaseGate agentId="claude" />);
      const button = screen.getByRole("button", { name: "Take control" });
      // Opted in before it's busy: the slot is there idle, holding the width.
      const slot = button.querySelector('[data-slot="button-spinner-slot"]');
      expect(slot).toBeTruthy();
      act(() => setTakeControlPending("p1", true));
      act(() => {
        vi.advanceTimersByTime(UI_DOHERTY_THRESHOLD);
      });
      expect(screen.getByRole("button", { name: "Take control" })).toBe(button);
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(button.getAttribute("aria-disabled")).toBe("true");
      const content = button.querySelector('[data-slot="button-content"]')!;
      expect(content.className).not.toContain("opacity-0");
      expect(content.textContent).toBe("Take control");
      expect(button.querySelector('[data-slot="button-spinner-slot"]')).toBe(slot);
      expect(slot!.querySelector("svg")).toBeTruthy();
      const describedBy = button.getAttribute("aria-describedby");
      expect(describedBy && document.getElementById(describedBy)?.textContent).toContain(
        "read-only on greg-mbp"
      );
    } finally {
      cleanup();
      setTakeControlPending("p1", false);
      vi.useRealTimers();
    }
  });

  it("says an away holder is away without promising when the launch starts", () => {
    act(() => seedDriveLeaseView(heldBy("greg-mbp", 30_000)));
    render(<DriveLeaseGate agentId="claude" />);

    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("greg-mbp is away");
    expect(text).not.toMatch(/\d+s\b/);
  });

  it("waits for the host first while its link is down, with nothing to take", () => {
    act(() => seedDriveLeaseView(heldBy("greg-mbp")));
    act(() => setHostInputBlock({ kind: "disconnected", hostName: "studio-01" }));
    render(<DriveLeaseGate agentId="claude" />);

    expect(screen.getByRole("status").textContent).toContain("Claude is waiting for studio-01");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("leaves the announcing to the window", () => {
    render(<DriveLeaseGate agentId="claude" />);

    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("off");
  });
});
