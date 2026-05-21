import { describe, it, expect } from "vitest";
import type { MutableRefObject } from "react";
import type { Active, Over } from "@dnd-kit/core";
import { createDragAnnouncements, type DragAnnouncementRefs } from "../DndProvider";
import { makeSortableAnnouncements } from "../sortableAnnouncements";

// Build a refs harness with controlled values so the factory's pickup-time
// pins (keyboard flag, total) can be driven from tests.
function makeRefs(
  initial: Partial<{
    isKeyboardDrag: boolean;
    pinnedTotal: number | null;
  }> = {}
): DragAnnouncementRefs {
  return {
    isKeyboardDragRef: { current: initial.isKeyboardDrag ?? false } as MutableRefObject<boolean>,
    pinnedTotalRef: {
      current: initial.pinnedTotal ?? null,
    } as MutableRefObject<number | null>,
  };
}

// Construct a minimal Active/Over shape — the factory only reads `id` and
// `data.current` — and cast through `as never` to satisfy dnd-kit's deep
// type without dragging the full ref/rect machinery into a unit test.
function makeActive(data: unknown): Active {
  return { id: "active-id", data: { current: data } } as unknown as Active;
}

function makeOver(id: string, data: unknown): Over {
  return { id, data: { current: data } } as unknown as Over;
}

const resolveActive = (active: Active): string => {
  const data = active.data.current as { terminal?: { title?: string } } | undefined;
  return data?.terminal?.title ?? "panel";
};
const resolveOver = (over: Over): string => {
  const data = over.data.current as { terminal?: { title?: string } } | undefined;
  return data?.terminal?.title ?? String(over.id);
};

describe("createDragAnnouncements — global DndProvider factory", () => {
  it("onDragStart announces pickup with keyboard instructions", () => {
    const announcements = createDragAnnouncements(makeRefs(), resolveActive, resolveOver);
    expect(
      announcements.onDragStart!({ active: makeActive({ terminal: { title: "Claude Agent" } }) })
    ).toBe("Picked up Claude Agent. Press arrow keys to move, Space to drop, Escape to cancel.");
  });

  it("onDragStart falls back to 'panel' when no title is resolvable", () => {
    const announcements = createDragAnnouncements(makeRefs(), resolveActive, resolveOver);
    expect(announcements.onDragStart!({ active: makeActive({}) })).toBe(
      "Picked up panel. Press arrow keys to move, Space to drop, Escape to cancel."
    );
  });

  it("onDragOver returns undefined for pointer drags so the polite queue isn't flooded", () => {
    const announcements = createDragAnnouncements(
      makeRefs({ isKeyboardDrag: false }),
      resolveActive,
      resolveOver
    );
    const result = announcements.onDragOver!({
      active: makeActive({ terminal: { title: "Claude Agent" } }),
      over: makeOver("term-1", { terminal: { title: "Terminal" } }),
    });
    expect(result).toBeUndefined();
  });

  it("onDragOver emits the running prose for keyboard drags so users hear position", () => {
    const announcements = createDragAnnouncements(
      makeRefs({ isKeyboardDrag: true }),
      resolveActive,
      resolveOver
    );
    expect(
      announcements.onDragOver!({
        active: makeActive({ terminal: { title: "Claude Agent" } }),
        over: makeOver("term-1", { terminal: { title: "Terminal" } }),
      })
    ).toBe("Claude Agent is over Terminal");
  });

  it("onDragOver keyboard drag without target announces no droppable area", () => {
    const announcements = createDragAnnouncements(
      makeRefs({ isKeyboardDrag: true }),
      resolveActive,
      resolveOver
    );
    expect(
      announcements.onDragOver!({
        active: makeActive({ terminal: { title: "Claude Agent" } }),
        over: null,
      })
    ).toBe("Claude Agent is no longer over a droppable area");
  });

  it("onDragEnd announces destination position from over sortable.index plus pinned total", () => {
    const announcements = createDragAnnouncements(
      makeRefs({ pinnedTotal: 5 }),
      resolveActive,
      resolveOver
    );
    expect(
      announcements.onDragEnd!({
        active: makeActive({ terminal: { title: "Claude Agent" } }),
        over: makeOver("term-2", { sortable: { index: 2 } }),
      })
    ).toBe("Dropped Claude Agent at position 3 of 5");
  });

  it("onDragEnd omits position when over has no sortable metadata", () => {
    // No source-index fallback: the resolved destination is unknown, so the
    // announcement stays generic rather than misleading the user with the
    // pickup position dressed up as the drop position.
    const announcements = createDragAnnouncements(
      makeRefs({ pinnedTotal: 8 }),
      resolveActive,
      resolveOver
    );
    expect(
      announcements.onDragEnd!({
        active: makeActive({ terminal: { title: "Claude Agent" } }),
        over: makeOver("term-x", {}),
      })
    ).toBe("Dropped Claude Agent");
  });

  it("onDragEnd omits position when pinned total is null", () => {
    const announcements = createDragAnnouncements(makeRefs(), resolveActive, resolveOver);
    expect(
      announcements.onDragEnd!({
        active: makeActive({ terminal: { title: "Claude Agent" } }),
        over: makeOver("term-x", { sortable: { index: 0 } }),
      })
    ).toBe("Dropped Claude Agent");
  });

  it("onDragEnd omits position when total is zero", () => {
    const announcements = createDragAnnouncements(
      makeRefs({ pinnedTotal: 0 }),
      resolveActive,
      resolveOver
    );
    expect(
      announcements.onDragEnd!({
        active: makeActive({ terminal: { title: "Claude Agent" } }),
        over: makeOver("term-x", { sortable: { index: 0 } }),
      })
    ).toBe("Dropped Claude Agent");
  });

  it("onDragEnd without target announces return to original position", () => {
    const announcements = createDragAnnouncements(
      makeRefs({ pinnedTotal: 5 }),
      resolveActive,
      resolveOver
    );
    expect(
      announcements.onDragEnd!({
        active: makeActive({ terminal: { title: "Claude Agent" } }),
        over: null,
      })
    ).toBe("Claude Agent returned to its original position");
  });

  it("onDragCancel announces cancellation with active label", () => {
    const announcements = createDragAnnouncements(makeRefs(), resolveActive, resolveOver);
    expect(
      announcements.onDragCancel!({
        active: makeActive({ terminal: { title: "Claude Agent" } }),
        over: null,
      })
    ).toBe("Drag cancelled. Claude Agent returned to its original position");
  });

  it("position string still resolves even when refs survive past the drop event", () => {
    // Regression: the monitor clears refs at the *next* onDragStart, not at
    // onDragEnd, because dnd-kit dispatches listeners in insertion order and
    // the monitor's useEffect runs before Accessibility's. If the monitor
    // cleared refs at end/cancel, Accessibility would read null and the
    // position-aware copy would never fire. This test pins the contract that
    // the factory reads non-null pinned values at onDragEnd time.
    const refs = makeRefs({ pinnedTotal: 4, isKeyboardDrag: true });
    const announcements = createDragAnnouncements(refs, resolveActive, resolveOver);
    expect(
      announcements.onDragEnd!({
        active: makeActive({ terminal: { title: "Claude Agent" } }),
        over: makeOver("term-2", { sortable: { index: 1 } }),
      })
    ).toBe("Dropped Claude Agent at position 2 of 4");
    expect(refs.pinnedTotalRef.current).toBe(4);
    expect(refs.isKeyboardDragRef.current).toBe(true);
  });
});

describe("makeSortableAnnouncements — nested DndContext factory", () => {
  // The dnd-kit `Active` / `Over` types include refs and rects we don't need
  // for announcement-string assertions. Construct the minimum shape and cast.
  const active = (id: string, data: unknown = {}) => ({ id, data: { current: data } }) as never;
  const over = (id: string, data: unknown = {}) => ({ id, data: { current: data } }) as never;

  describe("panel tab surface", () => {
    const labels = new Map<string, string>([
      ["panel-1", "Claude Agent"],
      ["panel-2", "Codex"],
    ]);
    const buildAnnouncements = () =>
      makeSortableAnnouncements((id) => labels.get(String(id)), "panel tab");

    it("onDragStart announces resolved label with keyboard instructions", () => {
      const announcements = buildAnnouncements();
      expect(
        announcements.onDragStart!({
          active: active("panel-1", { sortable: { items: ["panel-1", "panel-2"] } }),
        })
      ).toBe("Picked up Claude Agent. Press arrow keys to move, Space to drop, Escape to cancel.");
    });

    it("onDragStart falls back to noun + id when label is missing", () => {
      const announcements = buildAnnouncements();
      expect(announcements.onDragStart!({ active: active("panel-unknown") })).toBe(
        "Picked up panel tab panel-unknown. Press arrow keys to move, Space to drop, Escape to cancel."
      );
    });

    it("onDragOver with target announces both labels", () => {
      const announcements = buildAnnouncements();
      expect(announcements.onDragOver!({ active: active("panel-1"), over: over("panel-2") })).toBe(
        "Claude Agent is over Codex"
      );
    });

    it("onDragOver without target announces no droppable area", () => {
      const announcements = buildAnnouncements();
      expect(announcements.onDragOver!({ active: active("panel-1"), over: null })).toBe(
        "Claude Agent is no longer over a droppable area"
      );
    });

    it("onDragEnd announces destination position pinned from pickup items", () => {
      const announcements = buildAnnouncements();
      announcements.onDragStart!({
        active: active("panel-1", { sortable: { items: ["panel-1", "panel-2", "panel-3"] } }),
      });
      expect(
        announcements.onDragEnd!({
          active: active("panel-1"),
          over: over("panel-3", { sortable: { index: 2 } }),
        })
      ).toBe("Dropped Claude Agent at position 3 of 3");
    });

    it("onDragEnd falls back to plain copy when sortable metadata is missing", () => {
      const announcements = buildAnnouncements();
      // No onDragStart call → pinnedTotal stays null → no position info
      expect(announcements.onDragEnd!({ active: active("panel-1"), over: over("panel-2") })).toBe(
        "Dropped Claude Agent"
      );
    });

    it("onDragEnd clears the pinned total so a stale value can't leak into the next drag", () => {
      const announcements = buildAnnouncements();
      announcements.onDragStart!({
        active: active("panel-1", { sortable: { items: ["panel-1", "panel-2"] } }),
      });
      announcements.onDragEnd!({
        active: active("panel-1"),
        over: over("panel-2", { sortable: { index: 1 } }),
      });
      // Second drag — without a fresh onDragStart the pin is null again
      expect(
        announcements.onDragEnd!({
          active: active("panel-1"),
          over: over("panel-2", { sortable: { index: 1 } }),
        })
      ).toBe("Dropped Claude Agent");
    });

    it("onDragCancel clears the pinned total so a stale value can't leak into the next drag", () => {
      const announcements = buildAnnouncements();
      announcements.onDragStart!({
        active: active("panel-1", { sortable: { items: ["panel-1", "panel-2"] } }),
      });
      announcements.onDragCancel!({ active: active("panel-1"), over: null });
      expect(
        announcements.onDragEnd!({
          active: active("panel-1"),
          over: over("panel-2", { sortable: { index: 1 } }),
        })
      ).toBe("Dropped Claude Agent");
    });

    it("onDragEnd without target announces return to original position", () => {
      const announcements = buildAnnouncements();
      expect(announcements.onDragEnd!({ active: active("panel-1"), over: null })).toBe(
        "Claude Agent returned to its original position"
      );
    });

    it("onDragCancel announces cancellation with resolved label", () => {
      const announcements = buildAnnouncements();
      expect(announcements.onDragCancel!({ active: active("panel-1"), over: null })).toBe(
        "Drag cancelled. Claude Agent returned to its original position"
      );
    });

    it("treats empty-string labels as missing and falls back to noun + id", () => {
      const emptyLabels = makeSortableAnnouncements(() => "", "panel tab");
      expect(emptyLabels.onDragStart!({ active: active("panel-99") })).toBe(
        "Picked up panel tab panel-99. Press arrow keys to move, Space to drop, Escape to cancel."
      );
    });

    it("never includes 'undefined' in the announcement string", () => {
      const nullLabels = makeSortableAnnouncements(() => null, "panel tab");
      const result = nullLabels.onDragStart!({ active: active("panel-x") });
      expect(result).not.toContain("undefined");
      expect(result).toBe(
        "Picked up panel tab panel-x. Press arrow keys to move, Space to drop, Escape to cancel."
      );
    });

    it("treats whitespace-only labels as missing and falls back to noun + id", () => {
      const blankLabels = makeSortableAnnouncements(() => "   \n\t", "panel tab");
      expect(blankLabels.onDragStart!({ active: active("panel-blank") })).toBe(
        "Picked up panel tab panel-blank. Press arrow keys to move, Space to drop, Escape to cancel."
      );
    });

    it("applies fallback to over slot when over label is missing", () => {
      const announcements = buildAnnouncements();
      // Active resolves to "Claude Agent" (panel-1); over uses an unknown id.
      expect(
        announcements.onDragOver!({ active: active("panel-1"), over: over("panel-mystery") })
      ).toBe("Claude Agent is over panel tab panel-mystery");
    });

    it("uses fallbacks across all lifecycle methods when label is null", () => {
      const nullLabels = makeSortableAnnouncements(() => null, "panel tab");
      const a = active("panel-x");
      const o = over("panel-y");
      expect(nullLabels.onDragOver!({ active: a, over: o })).toBe(
        "panel tab panel-x is over panel tab panel-y"
      );
      expect(nullLabels.onDragOver!({ active: a, over: null })).toBe(
        "panel tab panel-x is no longer over a droppable area"
      );
      expect(nullLabels.onDragEnd!({ active: a, over: o })).toBe("Dropped panel tab panel-x");
      expect(nullLabels.onDragEnd!({ active: a, over: null })).toBe(
        "panel tab panel-x returned to its original position"
      );
      expect(nullLabels.onDragCancel!({ active: a, over: null })).toBe(
        "Drag cancelled. panel tab panel-x returned to its original position"
      );
    });
  });

  describe("toolbar button surface", () => {
    const labels = new Map<string, string>([
      ["btn-portal", "Portal"],
      ["btn-recipes", "Recipes"],
    ]);
    const buildAnnouncements = () =>
      makeSortableAnnouncements((id) => labels.get(String(id)), "toolbar button");

    it("uses the surface noun in the fallback", () => {
      const announcements = buildAnnouncements();
      expect(announcements.onDragStart!({ active: active("btn-mystery") })).toBe(
        "Picked up toolbar button btn-mystery. Press arrow keys to move, Space to drop, Escape to cancel."
      );
    });

    it("resolves known IDs to labels", () => {
      const announcements = buildAnnouncements();
      expect(announcements.onDragStart!({ active: active("btn-portal") })).toBe(
        "Picked up Portal. Press arrow keys to move, Space to drop, Escape to cancel."
      );
    });
  });

  describe("browser tab surface", () => {
    const labels = new Map<string, string>([["tab-a", "Daintree Docs"]]);
    const buildAnnouncements = () =>
      makeSortableAnnouncements((id) => labels.get(String(id)), "browser tab");

    it("uses the browser tab noun in the fallback", () => {
      const announcements = buildAnnouncements();
      expect(announcements.onDragStart!({ active: active("tab-z") })).toBe(
        "Picked up browser tab tab-z. Press arrow keys to move, Space to drop, Escape to cancel."
      );
    });
  });
});
