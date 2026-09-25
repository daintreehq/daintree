// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { TerminalInputBlockBanner } from "../TerminalInputBlockBanner";

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
});
