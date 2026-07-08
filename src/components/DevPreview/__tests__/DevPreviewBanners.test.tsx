// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { DevPreviewStuckBanner, DevPreviewHmrDeadBanner } from "../DevPreviewBanners";
import type { UseDevServerReturn } from "@/hooks/useDevServer";

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="overflow-content">{children}</div>
  ),
}));

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

describe("DevPreviewStuckBanner", () => {
  it("renders the tier-2 warning with a single restart action", () => {
    const onRestart = vi.fn();
    render(
      <DevPreviewStuckBanner
        tier={2}
        error={null}
        isRestarting={false}
        onRestart={onRestart}
        onRemedy={vi.fn()}
      />
    );
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Dev server is slow to start")).toBeTruthy();
    screen.getByRole("button", { name: /restart dev server/i }).click();
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("promotes the recommended remedy to primary and demotes restart to the overflow menu", () => {
    const error = {
      recommendedActionId: "devPreview.restartAndClearCache",
      message: "Stale build cache detected.",
    } as unknown as UseDevServerReturn["error"];
    const onRemedy = vi.fn();
    const onRestart = vi.fn();
    render(
      <DevPreviewStuckBanner
        tier={3}
        error={error}
        isRestarting={false}
        onRestart={onRestart}
        onRemedy={onRemedy}
      />
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    // Plain restart is demoted into the overflow menu, not the inline primary action.
    const overflow = screen.getByTestId("overflow-content");
    const restartButton = screen.getByRole("button", { name: /^restart dev server$/i });
    expect(overflow.contains(restartButton)).toBe(true);

    screen.getByRole("button", { name: /restart and clear cache/i }).click();
    expect(onRemedy).toHaveBeenCalledWith("devPreview.restartAndClearCache");
    expect(onRestart).not.toHaveBeenCalled();

    restartButton.click();
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("falls back to a single restart action at tier 3 without a recommended remedy", () => {
    render(
      <DevPreviewStuckBanner
        tier={3}
        error={null}
        isRestarting={false}
        onRestart={vi.fn()}
        onRemedy={vi.fn()}
      />
    );
    expect(screen.getByText("Dev server still hasn't started")).toBeTruthy();
    expect(screen.getByRole("button", { name: /restart dev server/i })).toBeTruthy();
  });

  it("switches to long-compile copy at tier 3 while phaseLabel is Compiling and there's no error message", () => {
    render(
      <DevPreviewStuckBanner
        tier={3}
        error={null}
        isRestarting={false}
        phaseLabel="Compiling"
        onRestart={vi.fn()}
        onRemedy={vi.fn()}
      />
    );
    expect(screen.getByText("First compile is taking longer than usual")).toBeTruthy();
  });

  it("disables the restart action while a restart is already in flight", () => {
    render(
      <DevPreviewStuckBanner
        tier={2}
        error={null}
        isRestarting={true}
        onRestart={vi.fn()}
        onRemedy={vi.fn()}
      />
    );
    const restartButton = screen.getByRole("button", {
      name: /restart dev server/i,
    }) as HTMLButtonElement;
    expect(restartButton.disabled).toBe(true);
  });
});

describe("DevPreviewHmrDeadBanner", () => {
  it("renders the dead-HMR warning and invokes onReload", () => {
    const onReload = vi.fn();
    render(<DevPreviewHmrDeadBanner onReload={onReload} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Live reload disconnected")).toBeTruthy();
    screen.getByRole("button", { name: /reload/i }).click();
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
