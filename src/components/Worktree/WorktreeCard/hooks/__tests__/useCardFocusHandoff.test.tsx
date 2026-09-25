/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { useCardFocusHandoff } from "../useCardFocusHandoff";

function Notice() {
  const ref = useCardFocusHandoff<HTMLDivElement>();
  return (
    <div ref={ref}>
      <button type="button">Act</button>
    </div>
  );
}

describe("useCardFocusHandoff", () => {
  it("falls back to the grid when the cell it sits in cannot take focus", () => {
    function Grid({ shown }: { shown: boolean }) {
      return (
        <div role="grid" tabIndex={0} aria-label="Worktrees">
          <div role="row">
            <div role="gridcell">{shown && <Notice />}</div>
          </div>
        </div>
      );
    }
    const { rerender } = render(<Grid shown />);
    screen.getByRole("button", { name: "Act" }).focus();
    rerender(<Grid shown={false} />);
    expect(document.activeElement).toBe(screen.getByRole("grid"));
  });
});
