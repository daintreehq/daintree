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
    const onLeaveDown = vi.fn(() => false);
    const { button } = bar({ onLeaveDown });
    expect(fireEvent.keyDown(button, { key: "ArrowDown" })).toBe(true);
    expect(onLeaveDown).toHaveBeenCalledTimes(1);
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

describe("SectionBar's arrow keys beyond the bar", () => {
  function inParent(fold: Parameters<typeof SectionBar>[0]["fold"]) {
    const reached = vi.fn();
    const view = render(
      <div onKeyDown={(event) => reached(event.key)}>
        <SectionBar id="s" label="Section" fold={fold} />
      </div>
    );
    return { reached, button: view.container.querySelector("button")! };
  }
  const base = { controls: "rows", onToggle: vi.fn(), onEnter: vi.fn() };

  it("keeps a handled arrow to itself, and lets an unhandled one on", () => {
    const { reached, button } = inParent({
      ...base,
      expanded: false,
      onLeaveUp: vi.fn(),
      onLeaveDown: () => true,
    });
    fireEvent.keyDown(button, { key: "ArrowUp" });
    fireEvent.keyDown(button, { key: "ArrowDown" });
    expect(reached).not.toHaveBeenCalled();
    fireEvent.keyDown(button, { key: "ArrowLeft" });
    expect(reached).toHaveBeenCalledWith("ArrowLeft");

    const idle = inParent({ ...base, expanded: false, onLeaveDown: () => false });
    fireEvent.keyDown(idle.button, { key: "ArrowDown" });
    expect(idle.reached).toHaveBeenCalledWith("ArrowDown");
  });
});
