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
