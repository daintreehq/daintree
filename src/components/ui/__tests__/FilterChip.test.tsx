// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FilterChip } from "../FilterChip";

const chip = (ui: React.ReactElement) => render(ui).container.querySelector("button")!;

describe("FilterChip", () => {
  it("reads its count as a separate word", () => {
    expect(
      chip(
        <FilterChip selected={false} count={3}>
          Dirty
        </FilterChip>
      ).textContent
    ).toBe("Dirty (3)");
  });

  it("groups the digits of a large count", () => {
    expect(
      chip(
        <FilterChip selected count={2172}>
          Active
        </FilterChip>
      ).textContent
    ).toBe("Active (2,172)");
  });

  it("tells unavailable from available only when a zero count is unselected", () => {
    const classes = (selected: boolean, count?: number) =>
      chip(
        <FilterChip selected={selected} count={count}>
          Value
        </FilterChip>
      ).className;
    const available = classes(false, 2);
    expect(classes(false, 0)).not.toBe(available);
    expect(classes(false)).toBe(available);
    expect(classes(true, 0)).toBe(classes(true, 2));
    // Still a control: its edge stays on the theme's 3:1 control-edge ink.
    expect(classes(false, 0).split(" ")).toContain("border-selection-outline");
  });

  it("gives way only at its label when the row runs out of room", () => {
    const labelRef = { current: null as HTMLSpanElement | null };
    const button = chip(
      <FilterChip selected={false} count={2172} labelRef={labelRef}>
        <span className="h-1.5 w-1.5 rounded-full" />
        Company: Contoso Pharmaceuticals International
      </FilterChip>
    );
    const classes = (element: Element) => element.className.split(" ");
    // The chip can shrink, but never past its container...
    expect(classes(button)).toEqual(expect.arrayContaining(["min-w-0", "max-w-full"]));
    // ...and the room comes out of the label, which ellipsises...
    const label = button.querySelector("[data-filter-chip-label]")!;
    expect(label.textContent).toBe("Company: Contoso Pharmaceuticals International");
    expect(classes(label)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
    expect(labelRef.current).toBe(label);
    // ...never out of the count or a leading mark.
    const count = [...button.querySelectorAll("span")].find(
      (span) => span.textContent === "(2,172)"
    )!;
    expect(classes(count)).toContain("shrink-0");
    expect(classes(button)).toContain("[&>:empty]:shrink-0");
    expect(button.firstElementChild?.matches(":empty")).toBe(true);
    // The accessible name is the same words as before.
    expect(button.textContent).toBe("Company: Contoso Pharmaceuticals International (2,172)");
  });

  it("stays clickable at a zero count", () => {
    const button = chip(
      <FilterChip selected={false} count={0}>
        Stale
      </FilterChip>
    );
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });
});
