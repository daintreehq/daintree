// @vitest-environment jsdom
import { createRef } from "react";
import { fireEvent, render } from "@testing-library/react";
import { Slot } from "@radix-ui/react-slot";
import { describe, expect, it, vi } from "vitest";
import { PopoverAnchor } from "../popover";

// The Radix chunk has not landed yet: every wrapper renders its pre-load path.
vi.mock("../radix-loader", () => ({
  useRadixPrimitives: () => null,
  primeOnEvent: vi.fn(),
}));

describe("PopoverAnchor before the Radix chunk loads", () => {
  it("keeps the handlers an outer trigger slots onto the shared element", () => {
    // The panel header's overflow button is a menu trigger and a popover
    // anchor at once; the anchor must not strip what the trigger put there.
    const onClick = vi.fn();
    const { getByRole } = render(
      <Slot onClick={onClick} data-outer="trigger">
        <PopoverAnchor asChild>
          <button type="button">More</button>
        </PopoverAnchor>
      </Slot>
    );

    const button = getByRole("button", { name: "More" });
    fireEvent.click(button);

    expect(button.getAttribute("data-outer")).toBe("trigger");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("forwards its ref to the child", () => {
    const ref = createRef<HTMLDivElement>();
    const { getByRole } = render(
      <PopoverAnchor asChild ref={ref}>
        <button type="button">More</button>
      </PopoverAnchor>
    );

    expect(ref.current).toBe(getByRole("button", { name: "More" }));
  });

  it("renders nothing without asChild", () => {
    const { container } = render(<PopoverAnchor />);

    expect(container.childElementCount).toBe(0);
  });
});
