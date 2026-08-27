// @vitest-environment jsdom
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Checkbox, checkboxVariants } from "../checkbox";
import { Field, FieldError, FieldLabel } from "../field";
import { expectNoUnfocusedAccent, expectSingleWinner, utilitiesInGroup } from "./variantAssertions";

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

  it("announces the indeterminate state as mixed and shows the minus glyph", () => {
    render(<Checkbox aria-label="Enable" checked="indeterminate" onCheckedChange={vi.fn()} />);
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox.getAttribute("aria-checked")).toBe("mixed");
    // Both glyphs are present; data-state on the root decides which one paints.
    expect(checkbox.querySelectorAll("svg")).toHaveLength(2);
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

  it("paints the checked state without spending the accent", () => {
    expectNoUnfocusedAccent(checkboxVariants());
    expect(checkboxVariants()).toContain("data-[state=checked]:bg-text-primary");
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
    expect(checkboxVariants()).not.toContain("transition-all");
    expect(utilitiesInGroup(checkboxVariants(), "transition")).toEqual(["transition-colors"]);
  });
});
