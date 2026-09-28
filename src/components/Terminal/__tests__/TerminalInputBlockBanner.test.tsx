// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { DriveLeaseView } from "@shared/types/ipc/driveLease";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { TerminalInputBlockBanner } from "../TerminalInputBlockBanner";
import {
  _resetTerminalInputGateForTesting,
  getTerminalInputBlock,
  setLeaseInputBlock,
} from "@/services/terminal/inputGate";

const takeOver = vi.fn<(payload: { projectId: string }) => Promise<DriveLeaseView>>();

beforeEach(() => {
  _resetTerminalInputGateForTesting();
  takeOver.mockReset();
  Object.defineProperty(window, "electron", {
    value: { driveLease: { takeOver } },
    writable: true,
    configurable: true,
  });
});

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe("TerminalInputBlockBanner", () => {
  it("names the host a dropped link is waiting on, as a status with no actions", () => {
    render(<TerminalInputBlockBanner block={{ kind: "disconnected", hostName: "studio-01" }} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("studio-01");
    expect(status.querySelectorAll("button")).toHaveLength(0);
  });

  it("names the machine that drives the project", () => {
    render(
      <TerminalInputBlockBanner block={{ kind: "driven-elsewhere", driverName: "greg-mbp" }} />
    );
    expect(screen.getByRole("status").textContent).toContain("greg-mbp");
  });

  it("offers no take-over while ownership is still unknown", () => {
    render(<TerminalInputBlockBanner block={{ kind: "lease-unknown", hostName: "studio-01" }} />);
    expect(screen.getByRole("status").querySelectorAll("button")).toHaveLength(0);
  });

  it("takes the project over and opens input here once the host agrees", async () => {
    const block = {
      kind: "driven-elsewhere",
      driverName: "greg-mbp",
      projectId: "proj-1",
      hostLocal: false,
    } as const;
    setLeaseInputBlock(block);
    takeOver.mockResolvedValue({
      projectId: "proj-1",
      holder: {
        leaseId: 3,
        endpointId: "view-4",
        clientId: "client-1",
        clientName: "studio-01",
        isHostLocal: false,
        acquiredAt: 2,
      },
      drivingHere: true,
      isHolderEndpoint: true,
      viewerIsHostLocal: false,
    });
    render(<TerminalInputBlockBanner block={block} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    });

    expect(takeOver).toHaveBeenCalledWith({ projectId: "proj-1" });
    expect(getTerminalInputBlock()).toBeNull();
  });

  it("says take back on the host's own screen", () => {
    render(
      <TerminalInputBlockBanner
        block={{
          kind: "driven-elsewhere",
          driverName: "greg-mbp",
          projectId: "proj-1",
          hostLocal: true,
        }}
      />
    );
    expect(screen.getByRole("button", { name: "Take back" })).toBeTruthy();
  });

  it("keeps the block when the host refuses the takeover", async () => {
    const block = {
      kind: "driven-elsewhere",
      driverName: "greg-mbp",
      projectId: "proj-1",
    } as const;
    setLeaseInputBlock(block);
    takeOver.mockRejectedValue(new Error("[AppError|DRIVEN_ELSEWHERE] no"));
    render(<TerminalInputBlockBanner block={block} />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    });

    expect(getTerminalInputBlock()).toEqual(block);
  });
});
