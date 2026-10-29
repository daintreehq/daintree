// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  DndContext,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { PanelTabList } from "../PanelTabList";
import { SortableTabButton } from "../SortableTabButton";
import { TAB_DRAG_MODIFIERS } from "../tabDragModifiers";
import type { TabInfo } from "../TabButton";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { MOUSE_SENSOR_OPTIONS, PrimaryMouseSensor } from "@/components/DragDrop/dragActivation";

// Each motion tag renders as its plain element, so the animated branch keeps
// its per-tab wrapper box, the thing that used to pin the drag.
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
            forwardRef<HTMLElement, { children?: React.ReactNode; [prop: string]: unknown }>(
              ({ children, ...props }, ref) =>
                createElement(
                  tag,
                  {
                    ref,
                    ...Object.fromEntries(
                      Object.entries(props).filter(([k]) => !motionOnly.has(k))
                    ),
                  },
                  children
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
const EVEN_WIDTHS = Object.fromEntries(TAB_IDS.map((id) => [id, TAB_WIDTH]));

function TabStrip({
  activeId = "tab-a",
  onDragEnd,
}: {
  activeId?: string;
  onDragEnd: (event: DragEndEvent) => void;
}) {
  const sensors = useSensors(
    useSensor(PrimaryMouseSensor, MOUSE_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const tabs: TabInfo[] = TAB_IDS.map((id, index) => ({
    id,
    title: `Tab ${index + 1}`,
    chrome: deriveTerminalChrome(),
    kind: "terminal",
    isActive: id === activeId,
  }));
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

// jsdom lays nothing out and loads no Tailwind: tabs sit side by side at the
// given widths, every box around a single tab (its wrapper, sortable node and
// button) is the tab's own size, the row holding them all is as wide as they
// are, and the tablist is the strip's scroll container, `stripWidth` wide.
function stubLayout(widths: Record<string, number>, stripWidth: number) {
  const style = document.createElement("style");
  style.textContent = ".overflow-x-auto { overflow-x: auto; }";
  document.head.appendChild(style);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.getAttribute("role") === "tablist") {
      return DOMRect.fromRect({ x: 0, y: 0, width: stripWidth, height: 30 });
    }
    const tabEls = [...document.querySelectorAll<HTMLElement>("[data-tab-id]")];
    const widthOf = (tab: HTMLElement) => widths[tab.dataset.tabId ?? ""] ?? 0;
    const inside = tabEls.filter((tab) => this.contains(tab));
    const tab = inside.length === 1 ? inside[0] : this.closest<HTMLElement>("[data-tab-id]");
    if (tab) {
      const x = tabEls.slice(0, tabEls.indexOf(tab)).reduce((sum, t) => sum + widthOf(t), 0);
      return DOMRect.fromRect({ x, y: 0, width: widthOf(tab), height: 30 });
    }
    if (inside.length > 1) {
      const width = inside.reduce((sum, t) => sum + widthOf(t), 0);
      return DOMRect.fromRect({ x: 0, y: 0, width, height: 30 });
    }
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
    // A failed assertion mid-drag skips the drop, and the sensors' document
    // listeners stay attached until a drag ends.
    act(() => {
      fireEvent.mouseUp(document);
      fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    });
    removeStyle?.();
    delete document.body.dataset.performanceMode;
    vi.restoreAllMocks();
    await act(() => new Promise((resolve) => setTimeout(resolve, CLICK_GUARD_LAPSE_MS)));
  });

  const modes = [
    ["animations on", false],
    ["performance mode", true],
  ] as const;

  it.each(modes)(
    "drags a tab past its neighbours and drops it there (%s)",
    (_label, performanceMode) => {
      if (performanceMode) document.body.dataset.performanceMode = "true";
      removeStyle = stubLayout(EVEN_WIDTHS, STRIP_WIDTH);
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
    }
  );

  it.each(modes)("stops a tab at the strip's edges (%s)", (_label, performanceMode) => {
    if (performanceMode) document.body.dataset.performanceMode = "true";
    removeStyle = stubLayout(EVEN_WIDTHS, STRIP_WIDTH);
    render(<TabStrip onDragEnd={vi.fn()} />);

    const drag = (tabName: RegExp, fromX: number, toX: number) => {
      fireEvent.mouseDown(screen.getByRole("tab", { name: tabName }), {
        button: 0,
        clientX: fromX,
        clientY: 15,
      });
      fireEvent.mouseMove(document, { clientX: fromX + Math.sign(toX - fromX) * 10, clientY: 15 });
      act(() => {
        fireEvent.mouseMove(document, { clientX: toX, clientY: 15 });
      });
    };
    const drop = () => {
      act(() => {
        fireEvent.mouseUp(document);
      });
    };

    drag(/Tab 1/, 50, 900);
    expect(dragTranslateX("tab-a")).toBe(STRIP_WIDTH - TAB_WIDTH);
    drop();

    drag(/Tab 3/, 250, -600);
    expect(dragTranslateX("tab-c")).toBe(-(STRIP_WIDTH - TAB_WIDTH));
    drop();
  });

  it.each(modes)(
    "moves a tab by keyboard onto a neighbour the strip only partly shows (%s)",
    async (_label, performanceMode) => {
      if (performanceMode) document.body.dataset.performanceMode = "true";
      // A wide active tab, then a neighbour reaching 30px past the strip's
      // edge. The keyboard lines the tab's right edge up with the neighbour's
      // and the sensor only scrolls once the tab's left edge passes the
      // strip's midpoint, so a viewport clamp would leave it short and stuck.
      removeStyle = stubLayout({ "tab-a": 50, "tab-b": 200, "tab-c": 80 }, 300);
      const onDragEnd = vi.fn();
      render(<TabStrip activeId="tab-b" onDragEnd={onDragEnd} />);

      const active = screen.getByRole("tab", { name: /Tab 2/ });
      act(() => active.focus());
      fireEvent.keyDown(active, { key: " ", code: "Space" });
      // The sensor starts listening for moves on the next task.
      await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
      act(() => {
        fireEvent.keyDown(active, { key: "ArrowRight", code: "ArrowRight" });
      });
      expect(dragTranslateX("tab-b")).toBe(80);

      act(() => {
        fireEvent.keyDown(active, { key: " ", code: "Space" });
      });
      expect(onDragEnd).toHaveBeenCalledTimes(1);
      expect(onDragEnd.mock.calls[0]![0].over?.id).toBe("tab-c");
    }
  );
});
