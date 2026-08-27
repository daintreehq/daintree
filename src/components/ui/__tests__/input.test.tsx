// @vitest-environment jsdom
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { cn } from "@/lib/utils";
import { Input, inputVariants } from "../input";
import { Field, FieldDescription, FieldError, FieldLabel } from "../field";
import {
  expectNarrowTransition,
  expectNoUnfocusedAccent,
  expectSingleWinner,
  utilitiesInGroup,
} from "./variantAssertions";

describe("Input native surface", () => {
  it("forwards the ref to the input element", () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} aria-label="Name" />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it("passes through native props and change events", () => {
    const onChange = vi.fn();
    render(<Input aria-label="Port" type="number" defaultValue="8080" onChange={onChange} />);
    const input = screen.getByLabelText("Port") as HTMLInputElement;
    expect(input.type).toBe("number");
    expect(input.value).toBe("8080");

    fireEvent.change(input, { target: { value: "9090" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // The variant axis is `density` precisely so the native `size` attribute
  // survives; shadowing it would silently drop a real HTML feature.
  it("leaves the native size attribute usable", () => {
    render(<Input aria-label="Code" size={4} density="compact" />);
    const input = screen.getByLabelText("Code") as HTMLInputElement;
    expect(input.size).toBe(4);
    expect(input.getAttribute("data-density")).toBe("compact");
  });
});

describe("Input invalid state", () => {
  it("marks itself invalid from its own prop with no field around it", () => {
    render(<Input aria-label="Name" invalid />);
    expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
  });

  it("inherits the enclosing field's invalid state", () => {
    render(
      <Field>
        <FieldLabel>Name</FieldLabel>
        <Input />
        <FieldError>Required</FieldError>
      </Field>
    );
    expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
  });

  it("lets an explicit prop override the field", () => {
    render(
      <Field>
        <FieldLabel>Name</FieldLabel>
        <Input invalid={false} />
        <FieldError>Required</FieldError>
      </Field>
    );
    expect(screen.getByLabelText("Name").hasAttribute("aria-invalid")).toBe(false);
  });

  it("appends a caller's described-by instead of replacing the field's", () => {
    render(
      <>
        <span id="external-hint">See the docs</span>
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input aria-describedby="external-hint" />
          <FieldError>Required</FieldError>
        </Field>
      </>
    );
    const ids = screen.getByLabelText("Name").getAttribute("aria-describedby")!.split(" ");
    expect(ids).toContain("external-hint");
    expect(ids.length).toBe(2);
    expect(document.getElementById(ids.find((id) => id !== "external-hint")!)?.textContent).toBe(
      "Required"
    );
  });

  // The order is the contract: a screen reader reaches the problem, then the
  // field's own hint, then whatever the call site added.
  it("keeps the error first when the caller also supplies a description", () => {
    render(
      <>
        <span id="external-hint">See the docs</span>
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input aria-describedby="external-hint" />
          <FieldDescription>Shown on your profile</FieldDescription>
          <FieldError>Required</FieldError>
        </Field>
      </>
    );
    const texts = screen
      .getByLabelText("Name")
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent);
    expect(texts).toEqual(["Required", "Shown on your profile", "See the docs"]);
  });

  it("does not repeat an id the caller listed twice", () => {
    render(
      <>
        <span id="external-hint">See the docs</span>
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input aria-describedby="external-hint external-hint" />
          <FieldError>Required</FieldError>
        </Field>
      </>
    );
    // A repeated IDREF is announced twice.
    const ids = screen.getByLabelText("Name").getAttribute("aria-describedby")!.split(" ");
    expect(ids.filter((id) => id === "external-hint")).toHaveLength(1);
    expect(ids).toHaveLength(2);
  });
});

describe("inputVariants", () => {
  it("resolves each density to a single utility per property", () => {
    for (const density of ["compact", "default"] as const) {
      expectSingleWinner(inputVariants({ density }), ["paddingX", "paddingY", "fontSize"]);
    }
  });

  it("changes only the border colour between valid and invalid", () => {
    const valid = new Set(inputVariants({ invalid: false }).split(/\s+/));
    const invalid = new Set(inputVariants({ invalid: true }).split(/\s+/));
    const added = [...invalid].filter((token) => !valid.has(token));
    expect(added.every((token) => token.startsWith("border-"))).toBe(true);
  });

  it("never widens to a blanket transition", () => {
    expectNarrowTransition(inputVariants(), /^transition-(colors|\[[a-z,-]+\])$/);
  });

  it("keeps the densities genuinely distinct", () => {
    const compact = inputVariants({ density: "compact" });
    const normal = inputVariants({ density: "default" });
    // A table that resolved both densities to the same padding would still pass
    // the single-winner check above.
    expect(utilitiesInGroup(compact, "paddingX")).not.toEqual(utilitiesInGroup(normal, "paddingX"));
    expect(utilitiesInGroup(compact, "fontSize")).not.toEqual(utilitiesInGroup(normal, "fontSize"));
  });

  it("spends accent only on the focus ring", () => {
    expectNoUnfocusedAccent(inputVariants());
  });

  it("lets a consumer class win its property group outright", () => {
    const merged = cn(inputVariants(), "px-6 text-lg");
    expect(utilitiesInGroup(merged, "paddingX")).toEqual(["px-6"]);
    expect(utilitiesInGroup(merged, "fontSize")).toEqual(["text-lg"]);
  });
});
