/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FocusedSubLine } from "../FocusedSubLine";

function renderSubLine(props: Parameters<typeof FocusedSubLine>[0]) {
  return render(
    <TooltipProvider>
      <FocusedSubLine {...props} />
    </TooltipProvider>
  );
}

describe("FocusedSubLine", () => {
  it("is hidden (aria-hidden, no data-open) when open=false", () => {
    renderSubLine({
      open: false,
      changedFileCount: 5,
      lastActivityTimestamp: Date.now(),
      statusLabel: "Running",
    });
    const wrapper = screen.getByTestId("worktree-focused-subline");
    expect(wrapper.getAttribute("aria-hidden")).toBe("true");
    expect(wrapper.hasAttribute("data-open")).toBe(false);
  });

  it("is hidden when open=true but all segments are absent", () => {
    renderSubLine({
      open: true,
      changedFileCount: 0,
      lastActivityTimestamp: null,
      statusLabel: null,
    });
    const wrapper = screen.getByTestId("worktree-focused-subline");
    expect(wrapper.getAttribute("aria-hidden")).toBe("true");
    expect(wrapper.hasAttribute("data-open")).toBe(false);
  });

  it("renders singular 'file' for exactly one change", () => {
    renderSubLine({
      open: true,
      changedFileCount: 1,
      lastActivityTimestamp: null,
      statusLabel: null,
    });
    expect(screen.queryByText("1 file")).not.toBeNull();
  });

  it("renders plural 'files' for more than one change", () => {
    renderSubLine({
      open: true,
      changedFileCount: 3,
      lastActivityTimestamp: null,
      statusLabel: null,
    });
    expect(screen.queryByText("3 files")).not.toBeNull();
  });

  it("hides the change-count segment when changedFileCount is 0", () => {
    renderSubLine({
      open: true,
      changedFileCount: 0,
      lastActivityTimestamp: null,
      statusLabel: "Running teardown",
    });
    expect(screen.queryByText(/\bfile\b/)).toBeNull();
    expect(screen.queryByText("Running teardown")).not.toBeNull();
  });

  it("hides the change-count segment when changedFileCount is undefined", () => {
    renderSubLine({
      open: true,
      changedFileCount: undefined,
      lastActivityTimestamp: null,
      statusLabel: "Running",
    });
    expect(screen.queryByText(/\bfile\b/)).toBeNull();
  });

  it("renders no separator when only one segment is present", () => {
    const { container } = renderSubLine({
      open: true,
      changedFileCount: 2,
      lastActivityTimestamp: null,
      statusLabel: null,
    });
    expect(container.textContent ?? "").not.toContain("·");
  });

  it("renders one separator between two segments", () => {
    const { container } = renderSubLine({
      open: true,
      changedFileCount: 2,
      lastActivityTimestamp: null,
      statusLabel: "Running",
    });
    const dots = (container.textContent ?? "").match(/·/g) ?? [];
    expect(dots).toHaveLength(1);
  });

  it("renders two separators when all three segments are present", () => {
    const { container } = renderSubLine({
      open: true,
      changedFileCount: 2,
      lastActivityTimestamp: Date.now() - 60_000,
      statusLabel: "Running",
    });
    const dots = (container.textContent ?? "").match(/·/g) ?? [];
    expect(dots).toHaveLength(2);
  });

  it("shows data-open and aria-hidden=false when visible with content", () => {
    renderSubLine({
      open: true,
      changedFileCount: 4,
      lastActivityTimestamp: Date.now() - 30_000,
      statusLabel: "Running",
    });
    const wrapper = screen.getByTestId("worktree-focused-subline");
    expect(wrapper.hasAttribute("data-open")).toBe(true);
    expect(wrapper.getAttribute("aria-hidden")).toBe("false");
  });

  it("treats NaN/non-finite timestamps as absent", () => {
    renderSubLine({
      open: true,
      changedFileCount: null,
      lastActivityTimestamp: Number.NaN,
      statusLabel: null,
    });
    const wrapper = screen.getByTestId("worktree-focused-subline");
    expect(wrapper.hasAttribute("data-open")).toBe(false);
  });

  it("treats future timestamps as absent", () => {
    renderSubLine({
      open: true,
      changedFileCount: null,
      lastActivityTimestamp: Date.now() + 60_000,
      statusLabel: null,
    });
    const wrapper = screen.getByTestId("worktree-focused-subline");
    expect(wrapper.hasAttribute("data-open")).toBe(false);
  });

  it("treats whitespace-only statusLabel as absent", () => {
    renderSubLine({
      open: true,
      changedFileCount: null,
      lastActivityTimestamp: null,
      statusLabel: "   ",
    });
    const wrapper = screen.getByTestId("worktree-focused-subline");
    expect(wrapper.hasAttribute("data-open")).toBe(false);
  });

  it("does not mount inner content (LiveTimeAgo) when open=false", () => {
    const { container } = renderSubLine({
      open: false,
      changedFileCount: 5,
      lastActivityTimestamp: Date.now() - 60_000,
      statusLabel: "Running",
    });
    expect(container.querySelectorAll("[aria-label]").length).toBe(0);
    expect(container.textContent ?? "").toBe("");
  });

  it("renders a long status label without dropping it", () => {
    renderSubLine({
      open: true,
      changedFileCount: null,
      lastActivityTimestamp: null,
      statusLabel: "Running teardown: ./scripts/very-long-shutdown-command.sh",
    });
    const label = screen.queryByText(/Running teardown:/);
    expect(label).not.toBeNull();
  });
});
