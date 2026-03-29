/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MainWorktreeSummaryRows, type AggregateCounts } from "../MainWorktreeSummaryRows";
import type { ProjectHealthData } from "@shared/types";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

function renderWithTooltip(ui: ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

const baseCounts: AggregateCounts = {
  worktrees: 5,
  working: 2,
  waiting: 1,
  finished: 1,
};

const baseHealth: ProjectHealthData = {
  ciStatus: "success",
  prCount: 3,
  issueCount: 12,
};

describe("MainWorktreeSummaryRows", () => {
  it("renders nothing when no aggregateCounts and no health", () => {
    renderWithTooltip(<MainWorktreeSummaryRows aggregateCounts={undefined} health={null} />);
    expect(screen.queryByTestId("main-worktree-summary")).toBeNull();
  });

  it("renders nothing when worktrees is 0 and no health", () => {
    renderWithTooltip(
      <MainWorktreeSummaryRows
        aggregateCounts={{ worktrees: 0, working: 0, waiting: 0, finished: 0 }}
        health={null}
      />
    );
    expect(screen.queryByTestId("main-worktree-summary")).toBeNull();
  });

  it("renders worktree count and working/waiting agent counts", () => {
    renderWithTooltip(<MainWorktreeSummaryRows aggregateCounts={baseCounts} health={null} />);
    const row = screen.getByTestId("aggregate-worktree-row");
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("5");
    expect(row.textContent).toContain("2");
    expect(row.textContent).toContain("1");
  });

  it("shows finished count only when working and waiting are both 0", () => {
    const counts: AggregateCounts = { worktrees: 3, working: 0, waiting: 0, finished: 3 };
    renderWithTooltip(<MainWorktreeSummaryRows aggregateCounts={counts} health={null} />);
    const row = screen.getByTestId("aggregate-worktree-row");
    expect(row.textContent).toContain("3");
  });

  it("hides finished count when working or waiting are active", () => {
    renderWithTooltip(<MainWorktreeSummaryRows aggregateCounts={baseCounts} health={null} />);
    const row = screen.getByTestId("aggregate-worktree-row");
    const spans = row.querySelectorAll("span.font-mono");
    const texts = Array.from(spans).map((s) => s.textContent);
    expect(texts).toEqual(["5", "2", "1"]);
  });

  it("renders GitHub pulse row with CI success", () => {
    renderWithTooltip(<MainWorktreeSummaryRows aggregateCounts={undefined} health={baseHealth} />);
    const row = screen.getByTestId("github-pulse-row");
    expect(row.textContent).toContain("passing");
    expect(row.textContent).toContain("3");
    expect(row.textContent).toContain("12");
  });

  it("renders CI failure status", () => {
    const health: ProjectHealthData = { ...baseHealth, ciStatus: "failure" };
    renderWithTooltip(<MainWorktreeSummaryRows aggregateCounts={undefined} health={health} />);
    const row = screen.getByTestId("github-pulse-row");
    expect(row.textContent).toContain("failing");
  });

  it("renders CI pending status", () => {
    const health: ProjectHealthData = { ...baseHealth, ciStatus: "pending" };
    renderWithTooltip(<MainWorktreeSummaryRows aggregateCounts={undefined} health={health} />);
    const row = screen.getByTestId("github-pulse-row");
    expect(row.textContent).toContain("pending");
  });

  it("renders CI none status", () => {
    const health: ProjectHealthData = { ...baseHealth, ciStatus: "none" };
    renderWithTooltip(<MainWorktreeSummaryRows aggregateCounts={undefined} health={health} />);
    const row = screen.getByTestId("github-pulse-row");
    expect(row.textContent).toContain("no CI");
  });

  it("renders both rows when both data sources are present", () => {
    renderWithTooltip(<MainWorktreeSummaryRows aggregateCounts={baseCounts} health={baseHealth} />);
    expect(screen.getByTestId("aggregate-worktree-row")).toBeTruthy();
    expect(screen.getByTestId("github-pulse-row")).toBeTruthy();
  });

  it("uses tabular-nums for numeric displays", () => {
    renderWithTooltip(<MainWorktreeSummaryRows aggregateCounts={baseCounts} health={baseHealth} />);
    const container = screen.getByTestId("main-worktree-summary");
    const monoSpans = container.querySelectorAll(".tabular-nums");
    expect(monoSpans.length).toBeGreaterThan(0);
  });
});
