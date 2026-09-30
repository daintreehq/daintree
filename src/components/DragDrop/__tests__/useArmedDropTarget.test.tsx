// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Active, DndMonitorListener, Over } from "@dnd-kit/core";

let listener: DndMonitorListener = {};
vi.mock("@dnd-kit/core", () => ({
  useDndMonitor: (l: DndMonitorListener) => {
    listener = l;
  },
}));

const { isOverContainer, panelDragOrigin, useArmedDropTarget } =
  await import("../useArmedDropTarget");

const over = (id: string, containerId?: string) =>
  ({ id, data: { current: containerId ? { sortable: { containerId } } : {} } }) as unknown as Over;
const active = (data: Record<string, unknown>) =>
  ({ id: "a", data: { current: data } }) as unknown as Active;

type Event = Parameters<NonNullable<DndMonitorListener["onDragOver"]>>[0];
const fire = (name: keyof DndMonitorListener, event: Partial<Event>) =>
  act(() => {
    (listener[name] as ((e: Event) => void) | undefined)?.(event as Event);
  });

beforeEach(() => {
  listener = {};
});

describe("isOverContainer", () => {
  it("counts the container and any item sorted inside it, nothing else", () => {
    expect(isOverContainer(over("dock-container"), "dock-container")).toBe(true);
    expect(isOverContainer(over("chip-1", "dock-container"), "dock-container")).toBe(true);
    expect(isOverContainer(over("panel-1", "grid-container"), "dock-container")).toBe(false);
    expect(isOverContainer(null, "dock-container")).toBe(false);
  });
});

describe("panelDragOrigin", () => {
  it("names the panel container a drag left, and nothing for a sidebar session", () => {
    expect(panelDragOrigin(active({ sourceLocation: "dock" }))).toBe("dock");
    expect(panelDragOrigin(active({ sourceLocation: "dock", origin: "accordion" }))).toBeNull();
    expect(panelDragOrigin(active({}))).toBeNull();
  });
});

describe("useArmedDropTarget", () => {
  const dock = (disabled = false) =>
    renderHook(() =>
      useArmedDropTarget({
        accepts: (o) => isOverContainer(o, "dock-container"),
        isOrigin: (a) => panelDragOrigin(a) === "dock",
        disabled,
      })
    );

  it("stays armed while a panel from elsewhere crosses the container's own items", () => {
    const { result } = dock();
    fire("onDragStart", { active: active({ sourceLocation: "grid" }) });
    fire("onDragOver", { over: over("dock-container") });
    expect(result.current).toBe(true);
    fire("onDragOver", { over: over("chip-1", "dock-container") });
    expect(result.current).toBe(true);
    fire("onDragOver", { over: over("panel-2", "grid-container") });
    expect(result.current).toBe(false);
  });

  it("never arms for a reorder inside the container", () => {
    const { result } = dock();
    fire("onDragStart", { active: active({ sourceLocation: "dock" }) });
    fire("onDragOver", { over: over("chip-1", "dock-container") });
    expect(result.current).toBe(false);
  });

  it("holds the origin read at pickup even if the item moves containers mid-drag", () => {
    let members = ["a"];
    const { result } = renderHook(() =>
      useArmedDropTarget({
        accepts: (o) => o.id === "right" || members.includes(String(o.id)),
        isOrigin: (a) => members.includes(String(a.id)),
      })
    );
    members = ["b"];
    fire("onDragStart", { active: active({}) });
    // The host relocates the dragged item into this column as it arrives.
    members = ["b", "a"];
    fire("onDragOver", { over: over("a") });
    expect(result.current).toBe(true);
  });

  it("disarms on drop and cancel, and while the drag is refused", () => {
    const { result } = dock();
    fire("onDragStart", { active: active({ sourceLocation: "grid" }) });
    fire("onDragOver", { over: over("dock-container") });
    fire("onDragEnd", {});
    expect(result.current).toBe(false);
    fire("onDragStart", { active: active({ sourceLocation: "grid" }) });
    fire("onDragOver", { over: over("dock-container") });
    fire("onDragCancel", {});
    expect(result.current).toBe(false);

    const refused = dock(true);
    fire("onDragStart", { active: active({ sourceLocation: "grid" }) });
    fire("onDragOver", { over: over("dock-container") });
    expect(refused.result.current).toBe(false);
  });
});
