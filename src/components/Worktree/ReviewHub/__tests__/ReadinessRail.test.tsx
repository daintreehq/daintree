/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReadinessRail } from "../ReadinessRail";
import type { ReviewReadinessItem, ReviewReadinessSummary } from "../reviewReadiness";

const makeSummary = (overrides?: Partial<ReviewReadinessSummary>): ReviewReadinessSummary => ({
  level: "ready",
  commitReady: true,
  pushReady: false,
  prReady: "unknown",
  blockers: [],
  warnings: [],
  infos: [],
  nextActions: [],
  ...overrides,
});

const item = (overrides: Partial<ReviewReadinessItem> & Pick<ReviewReadinessItem, "id">) =>
  ({
    severity: "info",
    label: `label ${overrides.id}`,
    ...overrides,
  }) as ReviewReadinessItem;

describe("ReadinessRail", () => {
  it("renders nothing while readiness is unknown", () => {
    render(<ReadinessRail summary={makeSummary({ level: "unknown" })} onCta={vi.fn()} />);
    expect(screen.queryByTestId("review-readiness-rail")).toBeNull();
  });

  it("shows the level chip with the level encoded for tests and themes", () => {
    render(<ReadinessRail summary={makeSummary({ level: "blocked" })} onCta={vi.fn()} />);
    const chip = screen.getByTestId("review-readiness-level");
    expect(chip.dataset.level).toBe("blocked");
    expect(chip.textContent).toBe("Blocked");
  });

  it("caps visible items at three, blockers first, with an overflow count", () => {
    const summary = makeSummary({
      level: "blocked",
      blockers: [item({ id: "conflicts", severity: "blocker" })],
      warnings: [
        item({ id: "behind-remote", severity: "warning" }),
        item({ id: "ci-failing", severity: "warning" }),
      ],
      infos: [item({ id: "no-remote" }), item({ id: "pr-missing" })],
    });
    render(<ReadinessRail summary={summary} onCta={vi.fn()} />);
    expect(screen.getByTestId("readiness-item-conflicts")).toBeDefined();
    expect(screen.getByTestId("readiness-item-behind-remote")).toBeDefined();
    expect(screen.getByTestId("readiness-item-ci-failing")).toBeDefined();
    expect(screen.queryByTestId("readiness-item-no-remote")).toBeNull();
    expect(screen.queryByTestId("readiness-item-pr-missing")).toBeNull();
    expect(screen.getByTestId("review-readiness-overflow").textContent).toBe("+2 more");
  });

  it("discloses the hidden items' labels on the overflow indicator", () => {
    const summary = makeSummary({
      level: "blocked",
      blockers: [item({ id: "conflicts", severity: "blocker" })],
      warnings: [
        item({ id: "behind-remote", severity: "warning" }),
        item({ id: "ci-failing", severity: "warning" }),
      ],
      infos: [
        item({ id: "no-remote", label: "No remote configured" }),
        item({ id: "pr-missing", label: "No pull request for this branch" }),
      ],
    });
    render(<ReadinessRail summary={summary} onCta={vi.fn()} />);
    const overflow = screen.getByTestId("review-readiness-overflow");
    expect(overflow.getAttribute("title")).toBe(
      "No remote configured\nNo pull request for this branch"
    );
    expect(overflow.getAttribute("aria-label")).toBe(
      "2 more: No remote configured, No pull request for this branch"
    );
  });

  it("labels the rail as a group and announces level changes via a status region", () => {
    const { rerender } = render(
      <ReadinessRail summary={makeSummary({ level: "ready" })} onCta={vi.fn()} />
    );
    const rail = screen.getByTestId("review-readiness-rail");
    expect(rail.getAttribute("role")).toBe("group");
    expect(rail.getAttribute("aria-label")).toBe("Review readiness");
    const chip = screen.getByTestId("review-readiness-level");
    expect(chip.getAttribute("role")).toBe("status");
    rerender(<ReadinessRail summary={makeSummary({ level: "blocked" })} onCta={vi.fn()} />);
    expect(screen.getByTestId("review-readiness-level").textContent).toBe("Blocked");
  });

  it("renders detail inline after the label", () => {
    const summary = makeSummary({
      level: "needs-review",
      warnings: [
        item({ id: "behind-remote", severity: "warning", label: "Behind", detail: "2 commits" }),
      ],
    });
    render(<ReadinessRail summary={summary} onCta={vi.fn()} />);
    expect(screen.getByTestId("readiness-item-behind-remote").textContent).toContain("2 commits");
  });

  it("dispatches the item's CTA on click and omits the button when absent", () => {
    const onCta = vi.fn();
    const summary = makeSummary({
      level: "needs-review",
      warnings: [
        item({
          id: "behind-remote",
          severity: "warning",
          action: { kind: "pull-rebase" },
        }),
        item({ id: "generated-only", severity: "warning" }),
      ],
    });
    render(<ReadinessRail summary={summary} onCta={onCta} />);
    fireEvent.click(screen.getByTestId("readiness-cta-behind-remote"));
    expect(onCta).toHaveBeenCalledWith({ kind: "pull-rebase" });
    expect(screen.queryByTestId("readiness-cta-generated-only")).toBeNull();
  });
});
