// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DndContext, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { PanelTabList } from "../PanelTabList";
import { SortableTabButton } from "../SortableTabButton";
import { TAB_DRAG_MODIFIERS } from "../tabDragModifiers";
import type { TabInfo } from "../TabButton";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { MOUSE_SENSOR_OPTIONS, PrimaryMouseSensor } from "@/components/DragDrop/dragActivation";

// Each motion tag renders as its plain element, so the animated branch keeps
// its per-tab wrapper box — the thing that used to pin the drag.
vi.mock("framer-motion", async () => {
  const { createElement, forwardRef } = await import("react");
  const motionOnly = new Set(["layout", "layoutId", "transition", "initial", "animate", "exit"]);
  const cache = new Map<string, unknown>();
  const m = new Proxy(
    {},
    {
      get: (_target, tag: string) => {
        if (!cache.has(tag)) {
          cache.set(
            tag,
            forwardRef<HTMLElement, Record<string, unknown>>((props, ref) =>
              createElement(
                tag,
                {
                  ref,
                  ...Object.fromEntries(Object.entries(props).filter(([k]) => !motionOnly.has(k))),
                },
                props.children as React.ReactNode
              )
            )
          );
        }
        return cache.get(tag);
      },
    }
  );
  const Passthrough = ({ children }: { children?: React.ReactNode }) => children;
  return { m, LayoutGroup: Passthrough, AnimatePresence: Passthrough };
});

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

vi.mock("@/components/Terminal/TerminalContextMenu", () => ({
  TerminalContextMenu: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

// dnd-kit swallows clicks for 50ms after a drop.
const CLICK_GUARD_LAPSE_MS = 60;
const TAB_WIDTH = 100;
const TAB_IDS = ["tab-a", "tab-b", "tab-c"];
const STRIP_WIDTH = TAB_IDS.length * TAB_WIDTH;

const tabs: TabInfo[] = TAB_IDS.map((id, index) => ({
  id,
  title: `Tab ${index + 1}`,
  chrome: deriveTerminalChrome(),
  kind: "terminal",
  isActive: index === 0,
}));

function TabStrip({ onDragEnd }: { onDragEnd: (event: DragEndEvent) => void }) {
  const sensors = useSensors(useSensor(PrimaryMouseSensor, MOUSE_SENSOR_OPTIONS));
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={TAB_DRAG_MODIFIERS}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={TAB_IDS} strategy={horizontalListSortingStrategy}>
        <PanelTabList
          layoutGroupId="tabs"
          tabs={tabs}
          tabListRef={() => {}}
          onKeyDown={() => {}}
          addTabTooltipContent="Add"
          overflowTrigger={null}
          renderTab={(tab, parked) => (
            <SortableTabButton
              key={tab.id}
              id={tab.id}
              title={tab.title}
              chrome={tab.chrome}
              kind={tab.kind}
              isActive={tab.isActive}
              parked={parked}
              onClick={() => {}}
              onClose={() => {}}
            />
          )}
        />
      </SortableContext>
    </DndContext>
  );
}

// jsdom lays nothing out and loads no Tailwind: tabs sit side by side, every
// box around a single tab (its wrapper, sortable node and button) is the tab's
// own size, and the tablist is the strip's scroll container.
function stubLayout() {
  const style = document.createElement("style");
  style.textContent = ".overflow-x-auto { overflow-x: auto; }";
  document.head.appendChild(style);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement
  ) {
    const strip = DOMRect.fromRect({ x: 0, y: 0, width: STRIP_WIDTH, height: 30 });
    if (this.getAttribute("role") === "tablist") return strip;
    const tabEls = [...document.querySelectorAll<HTMLElement>("[data-tab-id]")];
    const inside = tabEls.filter((tab) => this.contains(tab));
    const tab = inside.length === 1 ? inside[0] : this.closest<HTMLElement>("[data-tab-id]");
    if (tab) {
      return DOMRect.fromRect({
        x: tabEls.indexOf(tab) * TAB_WIDTH,
        y: 0,
        width: TAB_WIDTH,
        height: 30,
      });
    }
    if (inside.length > 1) return strip;
    return DOMRect.fromRect({ x: 0, y: 0, width: 1200, height: 800 });
  });
  return () => style.remove();
}

function dragTranslateX(tabId: string): number {
  let node: HTMLElement | null = document.querySelector(`[data-tab-id="${tabId}"]`);
  while (node && !node.style.transform) node = node.parentElement;
  const match = node?.style.transform.match(/translate3d\((-?[\d.]+)px/);
  return match ? Number(match[1]) : 0;
}

describe("tab strip drag bounds (#14971)", () => {
  let removeStyle: (() => void) | undefined;

  afterEach(async () => {
    removeStyle?.();
    delete document.body.dataset.performanceMode;
    vi.restoreAllMocks();
    await act(() => new Promise((resolve) => setTimeout(resolve, CLICK_GUARD_LAPSE_MS)));
  });

  it.each([
    ["animations on", false],
    ["performance mode", true],
  ])("drags a tab past its neighbours and drops it there (%s)", (_label, performanceMode) => {
    if (performanceMode) document.body.dataset.performanceMode = "true";
    removeStyle = stubLayout();
    const onDragEnd = vi.fn();
    render(<TabStrip onDragEnd={onDragEnd} />);

    const first = screen.getByRole("tab", { name: /Tab 1/ });
    fireEvent.mouseDown(first, { button: 0, clientX: 50, clientY: 15 });
    fireEvent.mouseMove(document, { clientX: 60, clientY: 15 });
    act(() => {
      fireEvent.mouseMove(document, { clientX: 250, clientY: 15 });
    });
    expect(dragTranslateX("tab-a")).toBe(200);

    act(() => {
      fireEvent.mouseUp(document, { clientX: 250, clientY: 15 });
    });
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(onDragEnd.mock.calls[0]![0].over?.id).toBe("tab-c");
  });

  it("stops a tab at the strip's edge", () => {
    removeStyle = stubLayout();
    render(<TabStrip onDragEnd={vi.fn()} />);

    const first = screen.getByRole("tab", { name: /Tab 1/ });
    fireEvent.mouseDown(first, { button: 0, clientX: 50, clientY: 15 });
    fireEvent.mouseMove(document, { clientX: 60, clientY: 15 });
    act(() => {
      fireEvent.mouseMove(document, { clientX: 900, clientY: 15 });
    });
    expect(dragTranslateX("tab-a")).toBe(STRIP_WIDTH - TAB_WIDTH);

    act(() => {
      fireEvent.mouseUp(document, { clientX: 900, clientY: 15 });
    });
  });
});
