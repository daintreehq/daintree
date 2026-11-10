// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { SectionBar } from "../CanopySectionBar";

function bar(fold: Partial<NonNullable<Parameters<typeof SectionBar>[0]["fold"]>> = {}) {
  const onEnter = vi.fn();
  const view = render(
    <SectionBar
      id="s"
      label="Section"
      fold={{ expanded: false, controls: "rows", onToggle: vi.fn(), onEnter, ...fold }}
    />
  );
  return { onEnter, button: view.container.querySelector("button")! };
}

describe("SectionBar's arrow keys", () => {
  it("goes down from a shut bar through onLeaveDown, taking the key once it moved", () => {
    const onLeaveDown = vi.fn(() => true);
    const { onEnter, button } = bar({ onLeaveDown });
    // fireEvent returns false when the handler cancelled the event.
    expect(fireEvent.keyDown(button, { key: "ArrowDown" })).toBe(false);
    expect(onLeaveDown).toHaveBeenCalledTimes(1);
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("leaves the key alone when nothing is below a shut bar to take it", () => {
    const { button } = bar({ onLeaveDown: () => false });
    expect(fireEvent.keyDown(button, { key: "ArrowDown" })).toBe(true);
    const bare = bar();
    expect(fireEvent.keyDown(bare.button, { key: "ArrowDown" })).toBe(true);
    expect(bare.onEnter).not.toHaveBeenCalled();
  });

  it("goes down from an open bar into its first row, never on past the section", () => {
    const onLeaveDown = vi.fn(() => true);
    const { onEnter, button } = bar({ expanded: true, onLeaveDown });
    expect(fireEvent.keyDown(button, { key: "ArrowDown" })).toBe(false);
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onLeaveDown).not.toHaveBeenCalled();
  });

  it("goes up through onLeaveUp whether the bar is shut or open, and not without one", () => {
    for (const expanded of [false, true]) {
      const onLeaveUp = vi.fn();
      const { button } = bar({ expanded, onLeaveUp });
      expect(fireEvent.keyDown(button, { key: "ArrowUp" })).toBe(false);
      expect(onLeaveUp).toHaveBeenCalledTimes(1);
    }
    const { button } = bar();
    expect(fireEvent.keyDown(button, { key: "ArrowUp" })).toBe(true);
  });
});
