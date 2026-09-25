/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { WslGitEligibility } from "@shared/types";

const client = vi.hoisted(() => ({
  setWslGit: vi.fn<(id: string, enabled: boolean) => Promise<void>>(),
  dismissWslBanner: vi.fn<(id: string) => Promise<void>>(),
  reprobeWsl: vi.fn<(id: string) => Promise<void>>(),
}));

vi.mock("@/clients/worktreeConfigClient", () => ({ worktreeConfigClient: client }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));

import { WslGitBanner, WSL_RECHECK_WINDOW_MS } from "../WslGitBanner";

function Host({
  eligibility,
  mounted = true,
  onCardClick = () => {},
}: {
  eligibility?: WslGitEligibility;
  mounted?: boolean;
  onCardClick?: () => void;
}) {
  return (
    <div data-worktree-row="" onClick={onCardClick}>
      <button type="button" data-card-select-overlay="" aria-label="Select worktree" />
      {mounted && (
        <WslGitBanner worktreeId="wt-1" wslDistro="Debian" wslGitEligible={eligibility} />
      )}
    </div>
  );
}

const banner = () => screen.getByTestId("wsl-git-banner");
const liveRegion = () => banner().querySelector('[role="status"][aria-live="polite"]');

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  client.setWslGit.mockResolvedValue(undefined);
  client.dismissWslBanner.mockResolvedValue(undefined);
  client.reprobeWsl.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("WslGitBanner", () => {
  it.each<WslGitEligibility>(["eligible", "ineligible"])(
    "never lets a %s-state button press select the card underneath",
    async (eligibility) => {
      const count = render(<Host eligibility={eligibility} />).container.querySelectorAll(
        '[data-testid="wsl-git-banner"] button'
      ).length;
      expect(count).toBeGreaterThan(0);
      // One fresh mount per button: pressing one disables the others while its
      // request is in flight, and each must be pressed while enabled.
      for (let i = 0; i < count; i++) {
        document.body.innerHTML = "";
        const onCardClick = vi.fn();
        render(<Host eligibility={eligibility} onCardClick={onCardClick} />);
        fireEvent.click(banner().querySelectorAll("button")[i]!);
        await flush();
        expect(onCardClick).not.toHaveBeenCalled();
      }
    }
  );

  it("keeps a press on a loading or disabled button from reaching the card", async () => {
    client.setWslGit.mockReturnValue(new Promise(() => {}));
    const onCardClick = vi.fn();
    render(<Host eligibility="eligible" onCardClick={onCardClick} />);
    const [enable, dismiss] = banner().querySelectorAll("button");
    fireEvent.click(enable!);
    await flush();
    expect(onCardClick).not.toHaveBeenCalled();
    // Both are now pointer-events-none, so a real pointer lands on their row.
    fireEvent.click(enable!.parentElement!);
    fireEvent.click(dismiss!);
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("is not itself a live region, so a notice present at mount is not announced", () => {
    render(<Host eligibility="eligible" />);
    expect(banner().getAttribute("role")).toBeNull();
    expect(banner().getAttribute("aria-live")).toBeNull();
  });

  it("hands focus to the card when it unmounts from under a focused button", () => {
    const { rerender } = render(<Host eligibility="eligible" />);
    const button = banner().querySelector("button")!;
    button.focus();
    expect(document.activeElement).toBe(button);
    rerender(<Host eligibility="eligible" mounted={false} />);
    expect(document.activeElement?.hasAttribute("data-card-select-overlay")).toBe(true);
  });

  it("does not steal focus on unmount when focus is elsewhere", () => {
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    const { rerender } = render(<Host eligibility="eligible" />);
    outside.focus();
    rerender(<Host eligibility="eligible" mounted={false} />);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("keeps the answer on screen while the host re-probes, and reports an unchanged result", async () => {
    const { rerender } = render(<Host eligibility="ineligible" />);
    const before = banner().textContent;
    const region = liveRegion();
    expect(region?.textContent).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Re-check" }));
    await flush();
    rerender(<Host eligibility="unprobed" />);
    expect(banner().getAttribute("data-state")).toBe("ineligible");
    expect(banner().getAttribute("aria-busy")).toBe("true");

    rerender(<Host eligibility="ineligible" />);
    expect(banner().getAttribute("aria-busy")).toBeNull();
    // The same live region that existed before the change now carries a result.
    expect(liveRegion()).toBe(region);
    expect(region?.textContent).not.toBe("");
    expect(banner().textContent).not.toBe(before);
  });

  it("surfaces a failed re-check in the pre-existing live region", async () => {
    client.reprobeWsl.mockRejectedValue(new Error("wsl.exe not found"));
    render(<Host eligibility="ineligible" />);
    const region = liveRegion();
    fireEvent.click(screen.getByRole("button", { name: "Re-check" }));
    await flush();
    await flush();
    expect(liveRegion()).toBe(region);
    expect(region?.textContent).not.toBe("");
  });

  it("stops waiting and says so when a retry from the stalled state gets no answer", async () => {
    vi.useFakeTimers();
    render(<Host eligibility="unprobed" />);
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(banner().getAttribute("data-state")).toBe("stuck");
    const retry = banner().querySelector("button")!;
    const label = retry.textContent;

    fireEvent.click(retry);
    await flush();
    expect(banner().getAttribute("aria-busy")).toBe("true");
    expect(retry.textContent).toBe(label);

    await act(async () => {
      vi.advanceTimersByTime(WSL_RECHECK_WINDOW_MS);
    });
    expect(banner().getAttribute("aria-busy")).toBeNull();
    expect(liveRegion()?.textContent).not.toBe("");
  });

  it("surfaces a failed enable instead of only logging it", async () => {
    client.setWslGit.mockRejectedValue(new Error("ipc down"));
    render(<Host eligibility="eligible" />);
    fireEvent.click(banner().querySelector("button")!);
    await flush();
    await flush();
    expect(liveRegion()?.textContent).not.toBe("");
  });

  it("keeps the held answer through a slow re-check instead of collapsing to a skeleton", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<Host eligibility="ineligible" />);
    fireEvent.click(screen.getByRole("button", { name: "Re-check" }));
    await flush();
    rerender(<Host eligibility="unprobed" />);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(banner().getAttribute("data-state")).toBe("ineligible");
    expect(screen.getByRole("button", { name: "Re-check" })).toBeTruthy();
  });

  it("retires a no-answer result once a late answer arrives", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<Host eligibility="unprobed" />);
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    fireEvent.click(banner().querySelector("button")!);
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(WSL_RECHECK_WINDOW_MS);
    });
    expect(liveRegion()?.textContent).not.toBe("");
    rerender(<Host eligibility="ineligible" />);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(banner().getAttribute("data-state")).toBe("ineligible");
    expect(liveRegion()?.textContent).toBe("");
  });

  it("announces a re-check whose answer changed, though nothing new is written on screen", async () => {
    const { rerender } = render(<Host eligibility="ineligible" />);
    fireEvent.click(screen.getByRole("button", { name: "Re-check" }));
    await flush();
    rerender(<Host eligibility="unprobed" />);
    rerender(<Host eligibility="eligible" />);
    expect(banner().getAttribute("data-state")).toBe("eligible");
    expect(liveRegion()?.textContent).not.toBe("");
  });

  it("says a stalled probe once for every card that stalls with it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    render(
      <>
        <Host eligibility="unprobed" />
        <Host eligibility="unprobed" />
      </>
    );
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    const regions = screen
      .getAllByTestId("wsl-git-banner")
      .map((b) => b.querySelector('[role="status"][aria-live="polite"]')?.textContent ?? "");
    expect(
      regions.every((_, i) => screen.getAllByTestId("wsl-git-banner")[i]!.dataset.state === "stuck")
    ).toBe(true);
    expect(regions.filter((t) => t !== "")).toHaveLength(1);
  });
});
