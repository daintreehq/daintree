/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorktreeActivityChip, type WorktreeActivityChipProps } from "../WorktreeActivityChip";
import { LiveTimeAgo } from "../../LiveTimeAgo";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

const NOW = new Date("2025-06-15T12:00:00Z").getTime();
const human = { name: "Jane Doe", email: "jane@example.com" };

function renderChip(props: WorktreeActivityChipProps) {
  return render(
    <TooltipProvider>
      <WorktreeActivityChip {...props} />
    </TooltipProvider>
  );
}

/** What the chip's label should read for a timestamp, from the label's own renderer. */
function expectedLabel(timestamp: number): string {
  const { container, unmount } = render(
    <TooltipProvider>
      <LiveTimeAgo timestamp={timestamp} noTooltip />
    </TooltipProvider>
  );
  const text = container.textContent ?? "";
  unmount();
  return text;
}

const chip = () => screen.queryByRole("group", { name: "Last activity" });

describe("WorktreeActivityChip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it.each([
    ["both missing", {}],
    ["both null", { lastActivityTimestamp: null, lastCommitTimestampMs: null }],
    ["both invalid", { lastActivityTimestamp: Number.NaN, lastCommitTimestampMs: 0 }],
    ["both in the future", { lastActivityTimestamp: NOW + 1, lastCommitTimestampMs: NOW + 1 }],
  ])("renders nothing when %s", (_label, props) => {
    const { container } = renderChip(props);
    expect(container.textContent).toBe("");
    expect(chip()).toBeNull();
  });

  it("shows the activity time when it is valid, even with an older commit", () => {
    const activity = NOW - 90_000;
    renderChip({ lastActivityTimestamp: activity, lastCommitTimestampMs: NOW - 3 * 3_600_000 });
    expect(chip()!.textContent).toBe(expectedLabel(activity));
  });

  it.each([
    ["missing", undefined],
    ["invalid", Number.NaN],
    ["in the future", NOW + 60_000],
  ])("falls back to the commit time when activity is %s", (_label, activity) => {
    const commit = NOW - 2 * 86_400_000;
    renderChip({ lastActivityTimestamp: activity, lastCommitTimestampMs: commit });
    expect(chip()!.textContent).toBe(expectedLabel(commit));
  });

  it("marks the dot active only for fresh activity", () => {
    const { rerender, container } = renderChip({ lastActivityTimestamp: NOW - 10_000 });
    const dot = () => container.querySelector("[data-activity-active]");
    expect(dot()!.getAttribute("data-activity-active")).toBe("true");

    rerender(
      <TooltipProvider>
        <WorktreeActivityChip lastActivityTimestamp={NOW - 3 * 3_600_000} />
      </TooltipProvider>
    );
    expect(dot()!.getAttribute("data-activity-active")).toBe("false");
  });

  it("is reachable by keyboard and exposes its age in the accessible text", () => {
    renderChip({ lastActivityTimestamp: NOW - 3 * 3_600_000 });
    const trigger = chip()!;
    expect(trigger.tabIndex).toBe(0);
    const time = trigger.querySelector("time")!;
    // Compact "3h" is not what a screen reader should say.
    expect(time.getAttribute("aria-label")).toBe("3 hours ago");
    expect(time.getAttribute("dateTime")).toBe(new Date(NOW - 3 * 3_600_000).toISOString());
  });

  it("opens the commit card on keyboard focus and closes it on Escape", () => {
    renderChip({
      lastActivityTimestamp: NOW - 3 * 3_600_000,
      lastCommitTimestampMs: NOW - 3 * 3_600_000,
      author: human,
      commitMessage: "fix: drain the queue in order",
    });
    expect(screen.queryByText("Jane Doe")).toBeNull();

    act(() => {
      fireEvent.focus(chip()!);
    });
    expect(screen.getAllByText("Jane Doe").length).toBeGreaterThan(0);
    expect(screen.getAllByText("fix: drain the queue in order").length).toBeGreaterThan(0);

    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    expect(screen.queryByText("Jane Doe")).toBeNull();
  });

  it("keeps the commit card open past the transient-tooltip window", () => {
    renderChip({
      lastCommitTimestampMs: NOW - 60_000,
      author: human,
      commitMessage: "feat: long read",
    });
    act(() => {
      fireEvent.focus(chip()!);
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getAllByText("feat: long read").length).toBeGreaterThan(0);
  });

  it("shows the no-author header when the commit has no author", () => {
    renderChip({ lastCommitTimestampMs: NOW - 86_400_000, commitMessage: "imported" });
    act(() => {
      fireEvent.focus(chip()!);
    });
    expect(screen.getAllByText("Last commit").length).toBeGreaterThan(0);
  });
});
