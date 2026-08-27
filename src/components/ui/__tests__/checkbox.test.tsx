// @vitest-environment jsdom
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Checkbox, checkboxVariants } from "../checkbox";
import { Field, FieldError, FieldLabel } from "../field";
import {
  expectNarrowTransition,
  expectNoUnfocusedAccent,
  expectSingleWinner,
  utilitiesInGroup,
} from "./variantAssertions";

describe("Checkbox behaviour", () => {
  it("reports the next state on each toggle", () => {
    const onCheckedChange = vi.fn();
    const { rerender } = render(
      <Checkbox aria-label="Enable" checked={false} onCheckedChange={onCheckedChange} />
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);

    rerender(<Checkbox aria-label="Enable" checked onCheckedChange={onCheckedChange} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
  });

  it("stays silent while disabled", () => {
    const onCheckedChange = vi.fn();
    render(
      <Checkbox aria-label="Enable" checked={false} onCheckedChange={onCheckedChange} disabled />
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("announces the indeterminate state as mixed and swaps to the minus glyph", () => {
    render(<Checkbox aria-label="Enable" checked="indeterminate" onCheckedChange={vi.fn()} />);
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox.getAttribute("aria-checked")).toBe("mixed");
    expect(checkbox.getAttribute("data-state")).toBe("indeterminate");

    // Cross-node contract, not a class restatement: the glyphs switch via
    // `group-data-[state=indeterminate]` on the ROOT, so losing the `group`
    // class makes both variants inert and leaves a checkmark on a mixed box —
    // a CSS-only failure nothing else here would catch.
    expect(checkbox.classList.contains("group")).toBe(true);
    const [check, minus] = [...checkbox.querySelectorAll("svg")];
    expect(check!.getAttribute("class")).toContain("group-data-[state=indeterminate]:hidden");
    expect(minus!.getAttribute("class")).toContain("hidden");
    expect(minus!.getAttribute("class")).toContain("group-data-[state=indeterminate]:block");
  });

  it("renders no indicator at all while unchecked", () => {
    render(<Checkbox aria-label="Enable" checked={false} onCheckedChange={vi.fn()} />);
    expect(screen.getByRole("checkbox").querySelector("svg")).toBeNull();
  });

  it("forwards the ref to the rendered control", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Checkbox ref={ref} aria-label="Enable" checked={false} onCheckedChange={vi.fn()} />);
    expect(ref.current).toBe(screen.getByRole("checkbox"));
  });

  it("inherits the enclosing field's id and invalid state", () => {
    render(
      <Field orientation="horizontal">
        <Checkbox checked={false} onCheckedChange={vi.fn()} />
        <FieldLabel>Enable</FieldLabel>
        <FieldError>Pick one</FieldError>
      </Field>
    );
    const checkbox = screen.getByRole("checkbox", { name: "Enable" });
    expect(checkbox.getAttribute("aria-invalid")).toBe("true");
    const ids = checkbox.getAttribute("aria-describedby")!.split(" ");
    expect(document.getElementById(ids[0]!)?.textContent).toBe("Pick one");
  });
});

describe("checkboxVariants", () => {
  it("scales the box and its glyph together", () => {
    for (const size of ["sm", "md"] as const) {
      const classes = checkboxVariants({ size });
      const box = utilitiesInGroup(classes, "width");
      const glyph = classes.match(/\[&_svg\]:w-([\d.]+)/)?.[1];
      expect(box).toHaveLength(1);
      expect(glyph, `${size} needs a glyph width`).toBeDefined();
      // The glyph has to stay inside the box it sits in.
      expect(Number(glyph)).toBeLessThan(Number(box[0]!.replace("w-", "")));
    }
  });

  it("resolves each size to a single radius", () => {
    for (const size of ["sm", "md"] as const) {
      expectSingleWinner(checkboxVariants({ size }), ["radius", "width", "height"]);
    }
  });

  // A 16px box at the repo's 10px base radius reads as a radio button.
  it("never uses the dialog-scale radius on a control this small", () => {
    for (const size of ["sm", "md"] as const) {
      const radius = utilitiesInGroup(checkboxVariants({ size }), "radius");
      expect(radius).not.toContain("rounded");
      expect(radius).not.toContain("rounded-lg");
    }
  });

  it("paints the checked state with exactly one fill, and never the accent", () => {
    expectNoUnfocusedAccent(checkboxVariants());
    const checked = checkboxVariants()
      .split(/\s+/)
      .filter((token) => token.startsWith("data-[state=checked]:"));
    const fills = checked.filter((token) => token.includes(":bg-"));
    const borders = checked.filter((token) => token.includes(":border-"));
    expect(fills).toHaveLength(1);
    expect(borders).toHaveLength(1);
    // The border has to agree with the fill or the box reads as a half-state.
    expect(borders[0]!.replace(":border-", ":bg-")).toBe(fills[0]);
    expect(fills[0]).not.toContain("accent");
  });

  it("keeps the two sizes genuinely distinct", () => {
    const sm = checkboxVariants({ size: "sm" });
    const md = checkboxVariants({ size: "md" });
    expect(utilitiesInGroup(sm, "width")).not.toEqual(utilitiesInGroup(md, "width"));
    expect(utilitiesInGroup(sm, "height")).not.toEqual(utilitiesInGroup(md, "height"));
  });

  it("adds only border colour when invalid", () => {
    const valid = new Set(checkboxVariants({ invalid: false }).split(/\s+/));
    const added = checkboxVariants({ invalid: true })
      .split(/\s+/)
      .filter((token) => token.length > 0 && !valid.has(token));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((token) => token.replace(/^.*:/, "").startsWith("border-"))).toBe(true);
  });

  it("never widens to a blanket transition", () => {
    expectNarrowTransition(checkboxVariants(), /^transition-(colors|\[[a-z,-]+\])$/);
  });
});
