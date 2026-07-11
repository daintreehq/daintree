// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

const mockUseDndPlaceholder = vi.fn();
vi.mock("../DndProvider", () => ({
  useDndPlaceholder: () => mockUseDndPlaceholder(),
}));
vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: () => ({ agentId: null }),
}));

import { DockPlaceholder } from "../DockPlaceholder";

// The mock's return value is untyped (any), so a plain literal stands in for the
// active panel without an unsafe cast — DockPlaceholder only reads `kind`.
function ghostPanel(kind: string) {
  return { id: "p1", kind, title: "Ghost", location: "dock", isVisible: true };
}

/**
 * Regression coverage for #11055. The dock renders the placeholder in compact
 * mode; browser/dev-preview panels used to overflow --dock-item-height and grow
 * the whole dock bar during a drag. jsdom can't measure heights, so we assert
 * the two structural properties that produce the fix: the box is no longer
 * content-height-driven, and the overflowing body is dropped on the dock path.
 */
describe("DockPlaceholder height containment (#11055)", () => {
  it("renders an invisible spacer with no ghost art when not dragging", () => {
    mockUseDndPlaceholder.mockReturnValue({ activeTerminal: null, isDragging: false });
    const { container } = render(<DockPlaceholder />);
    const root = container.querySelector("[aria-hidden='true']");
    expect(root).not.toBeNull();
    expect(container.querySelector("[data-placeholder-body]")).toBeNull();
  });

  it("clamps the ghost to a definite height and drops the browser body while dragging", () => {
    mockUseDndPlaceholder.mockReturnValue({
      activeTerminal: ghostPanel("browser"),
      isDragging: true,
    });
    const { container } = render(<DockPlaceholder />);
    const root = container.querySelector("[aria-hidden='true']");
    // The #11055 bug was `h-full` resolving to auto height that grew with the
    // ghost content. The box must be pinned to a definite height instead.
    expect(root?.className ?? "").not.toContain("h-full");
    // And the tall browser body must be absent on the compact dock path.
    expect(container.querySelector("[data-placeholder-body]")).toBeNull();
  });

  it("drops the dev-preview split body while dragging", () => {
    mockUseDndPlaceholder.mockReturnValue({
      activeTerminal: ghostPanel("dev-preview"),
      isDragging: true,
    });
    const { container } = render(<DockPlaceholder />);
    expect(container.querySelector("[data-placeholder-body]")).toBeNull();
  });
});
