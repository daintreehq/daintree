/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MainWorktreeSummaryRows } from "../MainWorktreeSummaryRows";
import type { ForgeProjectHealthPayload } from "@shared/types/ipc/forge";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

function renderWithTooltip(ui: ReactNode) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

const baseHealth: ForgeProjectHealthPayload = {
  ciStatus: "success",
  prCount: 3,
  issueCount: 12,
  latestRelease: null,
  securityAlerts: { visible: false, count: 0 },
  mergeVelocity: { mergedCounts: { 60: 0, 120: 0, 180: 0 } },
  repoUrl: "",
  hasRemote: true,
  loading: false,
};

describe("MainWorktreeSummaryRows", () => {
  it("renders nothing when health is null", () => {
    renderWithTooltip(<MainWorktreeSummaryRows health={null} />);
    expect(screen.queryByTestId("main-worktree-summary")).toBeNull();
  });

  it("renders GitHub pulse row with CI success", () => {
    renderWithTooltip(<MainWorktreeSummaryRows health={baseHealth} />);
    const row = screen.getByTestId("github-pulse-row");
    expect(row.textContent).toContain("passing");
    expect(row.textContent).toContain("3");
    expect(row.textContent).toContain("12");
  });

  it("renders CI failure status", () => {
    const health: ForgeProjectHealthPayload = { ...baseHealth, ciStatus: "failure" };
    renderWithTooltip(<MainWorktreeSummaryRows health={health} />);
    const row = screen.getByTestId("github-pulse-row");
    expect(row.textContent).toContain("failing");
  });

  it("renders CI pending status", () => {
    const health: ForgeProjectHealthPayload = { ...baseHealth, ciStatus: "pending" };
    renderWithTooltip(<MainWorktreeSummaryRows health={health} />);
    const row = screen.getByTestId("github-pulse-row");
    expect(row.textContent).toContain("pending");
  });

  it("renders CI none status", () => {
    const health: ForgeProjectHealthPayload = { ...baseHealth, ciStatus: "none" };
    renderWithTooltip(<MainWorktreeSummaryRows health={health} />);
    const row = screen.getByTestId("github-pulse-row");
    expect(row.textContent).toContain("no CI");
  });

  it("renders GitHub health row when health data is present", () => {
    renderWithTooltip(<MainWorktreeSummaryRows health={baseHealth} />);
    expect(screen.queryByTestId("aggregate-worktree-row")).toBeNull();
    expect(screen.getByTestId("github-pulse-row")).toBeTruthy();
  });

  it("uses tabular-nums for numeric displays", () => {
    renderWithTooltip(<MainWorktreeSummaryRows health={baseHealth} />);
    const container = screen.getByTestId("main-worktree-summary");
    const monoSpans = container.querySelectorAll(".tabular-nums");
    expect(monoSpans.length).toBeGreaterThan(0);
  });
});
