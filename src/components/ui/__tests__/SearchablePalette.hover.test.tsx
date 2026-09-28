// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/hooks", () => ({
  useEscapeStack: () => {},
  useOverlayState: () => {},
}));

vi.mock("@/store/paletteStore", () => ({
  usePaletteStore: { getState: () => ({ activePaletteId: null }) },
}));

import { SearchablePalette } from "../SearchablePalette";

interface Item {
  id: string;
}

const items: Item[] = [{ id: "a" }, { id: "b" }, { id: "c" }];

function renderPalette(onHoverIndex?: (index: number) => void) {
  return render(
    <SearchablePalette<Item>
      isOpen
      query=""
      results={items}
      selectedIndex={0}
      onQueryChange={() => {}}
      onSelectPrevious={() => {}}
      onSelectNext={() => {}}
      onConfirm={() => {}}
      onClose={() => {}}
      getItemId={(item) => item.id}
      onHoverIndex={onHoverIndex}
      renderItem={(item, index, isSelected, hoverIndex) => (
        <button
          key={item.id}
          data-testid={`row-${item.id}`}
          aria-selected={isSelected}
          onPointerMove={() => hoverIndex(index)}
        >
          {item.id}
        </button>
      )}
      label="Test"
      ariaLabel="Test palette"
      tier="command"
    />
  );
}

describe("SearchablePalette hover wiring", () => {
  it("calls onHoverIndex with the correct index when a row's pointer move fires", () => {
    const onHoverIndex = vi.fn();
    const { getByTestId } = renderPalette(onHoverIndex);

    fireEvent.pointerMove(getByTestId("row-c"));
    expect(onHoverIndex).toHaveBeenCalledWith(2);

    fireEvent.pointerMove(getByTestId("row-a"));
    expect(onHoverIndex).toHaveBeenCalledWith(0);

    expect(onHoverIndex).toHaveBeenCalledTimes(2);
  });

  it("supplies a stable noop hover callback when onHoverIndex is omitted", () => {
    const { getByTestId } = renderPalette();
    expect(() => fireEvent.pointerMove(getByTestId("row-b"))).not.toThrow();
  });

  it("moves the cursor with the pointer without scrolling it, but still reveals for the keys", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    function Harness() {
      const [selectedIndex, setSelectedIndex] = useState(0);
      return (
        <SearchablePalette<Item>
          isOpen
          query=""
          results={items}
          selectedIndex={selectedIndex}
          onQueryChange={() => {}}
          onSelectPrevious={() => setSelectedIndex((i) => Math.max(0, i - 1))}
          onSelectNext={() => setSelectedIndex((i) => Math.min(items.length - 1, i + 1))}
          onConfirm={() => {}}
          onClose={() => {}}
          getItemId={(item) => item.id}
          onHoverIndex={setSelectedIndex}
          renderItem={(item, index, isSelected, hoverIndex) => (
            <button
              key={item.id}
              data-testid={`row-${item.id}`}
              aria-selected={isSelected}
              onPointerMove={() => hoverIndex(index)}
            >
              {item.id}
            </button>
          )}
          label="Test"
          ariaLabel="Test palette"
          tier="command"
        />
      );
    }

    const { getByTestId, getByRole } = render(<Harness />);
    scrollIntoView.mockClear();

    // The row under the pointer takes the cursor, and stays where it is.
    fireEvent.pointerMove(getByTestId("row-c"));
    expect(getByTestId("row-c").getAttribute("aria-selected")).toBe("true");
    expect(scrollIntoView).not.toHaveBeenCalled();

    // The keys still bring the row they land on into view.
    fireEvent.keyDown(getByRole("combobox"), { key: "ArrowUp" });
    expect(getByTestId("row-b").getAttribute("aria-selected")).toBe("true");
    expect(scrollIntoView).toHaveBeenCalled();
  });
});
