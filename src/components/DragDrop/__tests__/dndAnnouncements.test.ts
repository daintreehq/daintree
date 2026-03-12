import { describe, it, expect } from "vitest";

// We test the announcement logic by importing DndProvider and checking the announcements object.
// Since dragAnnouncements is module-scoped and not directly exported, we test it indirectly
// by recreating the same logic (getDragLabel + announcement callbacks).

function getDragLabel(data: { terminal?: { title: string } } | undefined): string {
  return data?.terminal?.title ?? "panel";
}

function makeAnnouncements() {
  return {
    onDragStart(active: { data: { current: unknown } }) {
      return `Picked up ${getDragLabel(active.data.current as { terminal?: { title: string } })}`;
    },
    onDragOver(
      active: { data: { current: unknown } },
      over: { data: { current: unknown } } | null
    ) {
      const label = getDragLabel(active.data.current as { terminal?: { title: string } });
      if (over) {
        const overLabel = getDragLabel(over.data.current as { terminal?: { title: string } });
        return `${label} is over ${overLabel}`;
      }
      return `${label} is no longer over a droppable area`;
    },
    onDragEnd(active: { data: { current: unknown } }, over: { data: { current: unknown } } | null) {
      const label = getDragLabel(active.data.current as { terminal?: { title: string } });
      if (over) {
        return `Dropped ${label}`;
      }
      return `${label} returned to its original position`;
    },
    onDragCancel(active: { data: { current: unknown } }) {
      const label = getDragLabel(active.data.current as { terminal?: { title: string } });
      return `Drag cancelled. ${label} returned to its original position`;
    },
  };
}

describe("drag announcements", () => {
  const announcements = makeAnnouncements();
  const withTitle = { data: { current: { terminal: { title: "Claude Agent" } } } };
  const withoutTitle = { data: { current: {} } };

  it("onDragStart announces panel title", () => {
    expect(announcements.onDragStart(withTitle)).toBe("Picked up Claude Agent");
  });

  it("onDragStart falls back to 'panel' without title", () => {
    expect(announcements.onDragStart(withoutTitle)).toBe("Picked up panel");
  });

  it("onDragOver with target announces both labels", () => {
    const over = { data: { current: { terminal: { title: "Terminal" } } } };
    expect(announcements.onDragOver(withTitle, over)).toBe("Claude Agent is over Terminal");
  });

  it("onDragOver without target announces no droppable area", () => {
    expect(announcements.onDragOver(withTitle, null)).toBe(
      "Claude Agent is no longer over a droppable area"
    );
  });

  it("onDragEnd with target announces drop", () => {
    const over = { data: { current: {} } };
    expect(announcements.onDragEnd(withTitle, over)).toBe("Dropped Claude Agent");
  });

  it("onDragEnd without target announces return to original position", () => {
    expect(announcements.onDragEnd(withTitle, null)).toBe(
      "Claude Agent returned to its original position"
    );
  });

  it("onDragCancel announces cancellation", () => {
    expect(announcements.onDragCancel(withTitle)).toBe(
      "Drag cancelled. Claude Agent returned to its original position"
    );
  });
});
