// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Field, FieldDescription, FieldError, FieldLabel } from "../field";
import { Input } from "../input";
import { Checkbox } from "../checkbox";

function describedTexts(control: Element): string[] {
  const ids = control.getAttribute("aria-describedby");
  if (ids === null) return [];
  return ids.split(" ").map((id) => document.getElementById(id)?.textContent ?? "<missing>");
}

describe("Field ARIA wiring", () => {
  it("associates the generated control id with the label", () => {
    render(
      <Field>
        <FieldLabel>Endpoint</FieldLabel>
        <Input />
      </Field>
    );
    const input = screen.getByLabelText("Endpoint");
    expect(input.tagName).toBe("INPUT");
  });

  it("adopts a caller-supplied control id instead of generating one", () => {
    render(
      <Field controlId="explicit-id">
        <FieldLabel>Endpoint</FieldLabel>
        <Input />
      </Field>
    );
    expect(screen.getByLabelText("Endpoint").id).toBe("explicit-id");
  });

  it("describes the control with the error before the description", () => {
    render(
      <Field>
        <FieldLabel>Endpoint</FieldLabel>
        <Input />
        <FieldDescription>Where requests are sent</FieldDescription>
        <FieldError>Must be a URL</FieldError>
      </Field>
    );
    expect(describedTexts(screen.getByLabelText("Endpoint"))).toEqual([
      "Must be a URL",
      "Where requests are sent",
    ]);
  });

  it("leaves no dangling id when only a description is rendered", () => {
    render(
      <Field>
        <FieldLabel>Endpoint</FieldLabel>
        <Input />
        <FieldDescription>Where requests are sent</FieldDescription>
      </Field>
    );
    expect(describedTexts(screen.getByLabelText("Endpoint"))).toEqual(["Where requests are sent"]);
  });

  it("omits aria-describedby entirely when neither slot is rendered", () => {
    render(
      <Field>
        <FieldLabel>Endpoint</FieldLabel>
        <Input />
      </Field>
    );
    expect(screen.getByLabelText("Endpoint").hasAttribute("aria-describedby")).toBe(false);
  });

  it("finds slots rendered inside a fragment", () => {
    render(
      <Field>
        <FieldLabel>Endpoint</FieldLabel>
        <Input />
        <>
          <FieldDescription>Where requests are sent</FieldDescription>
          <FieldError>Must be a URL</FieldError>
        </>
      </Field>
    );
    expect(describedTexts(screen.getByLabelText("Endpoint"))).toEqual([
      "Must be a URL",
      "Where requests are sent",
    ]);
  });

  it("marks the control invalid when an error is rendered and clean when it is not", () => {
    const { rerender } = render(
      <Field>
        <FieldLabel>Endpoint</FieldLabel>
        <Input />
        <FieldError>Must be a URL</FieldError>
      </Field>
    );
    expect(screen.getByLabelText("Endpoint").getAttribute("aria-invalid")).toBe("true");

    rerender(
      <Field>
        <FieldLabel>Endpoint</FieldLabel>
        <Input />
      </Field>
    );
    expect(screen.getByLabelText("Endpoint").hasAttribute("aria-invalid")).toBe(false);
  });

  it("gives sibling fields distinct ids", () => {
    const { container } = render(
      <>
        <Field>
          <FieldLabel>First</FieldLabel>
          <Input />
          <FieldDescription>One</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Second</FieldLabel>
          <Input />
          <FieldDescription>Two</FieldDescription>
        </Field>
      </>
    );
    const ids = [...container.querySelectorAll("input")].map((el) => el.id);
    expect(new Set(ids).size).toBe(2);
    expect(describedTexts(screen.getByLabelText("First"))).toEqual(["One"]);
    expect(describedTexts(screen.getByLabelText("Second"))).toEqual(["Two"]);
  });
});

describe("Field horizontal orientation", () => {
  it("keeps the description out of the control's accessible name", () => {
    render(
      <Field orientation="horizontal">
        <Checkbox checked={false} onCheckedChange={vi.fn()} />
        <FieldLabel>Send crash reports</FieldLabel>
        <FieldDescription>Includes stack traces and the app version</FieldDescription>
      </Field>
    );
    expect(screen.getByRole("checkbox", { name: "Send crash reports" })).toBeTruthy();
  });

  it("makes the whole row a click target for the control", () => {
    const onCheckedChange = vi.fn();
    render(
      <Field orientation="horizontal">
        <Checkbox checked={false} onCheckedChange={onCheckedChange} />
        <FieldLabel>Send crash reports</FieldLabel>
        <FieldDescription>Includes stack traces</FieldDescription>
      </Field>
    );
    fireEvent.click(screen.getByText("Send crash reports"));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  // jsdom computes no layout, so the two-column row can only be pinned
  // structurally. These classes are load-bearing selectors, not styling: the
  // control lands in column one purely because it is the FIRST child and every
  // text slot is explicitly pushed to column two.
  it("places the control first and every text slot in the second column", () => {
    const { container } = render(
      <Field orientation="horizontal">
        <Checkbox checked={false} onCheckedChange={vi.fn()} />
        <FieldLabel>Send crash reports</FieldLabel>
        <FieldDescription>Includes stack traces</FieldDescription>
        <FieldError>Pick one</FieldError>
      </Field>
    );
    const row = container.firstElementChild!;
    expect(row.className).toContain("grid-cols-[auto_minmax(0,1fr)]");

    const children = [...row.children];
    expect(children[0]!.getAttribute("data-field-control")).toBe("");
    expect(children.slice(1).map((el) => el.getAttribute("data-slot"))).toEqual([
      "field-label",
      "field-description",
      "field-error",
    ]);

    for (const slot of ["field-label", "field-description", "field-error"]) {
      expect(row.className, slot).toContain(`[&>[data-slot=${slot}]]:col-start-2`);
    }
  });

  // With no FieldLabel there is no id for aria-labelledby to scope the name to,
  // so a <label> root would hand the control the description and the error as
  // one run-on string. The row gives up its click target instead.
  it("drops the label root when the row has no label", () => {
    render(
      <Field orientation="horizontal">
        <Checkbox checked={false} onCheckedChange={vi.fn()} />
        <FieldDescription>Includes stack traces and the app version</FieldDescription>
        <FieldError>Pick one</FieldError>
      </Field>
    );
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox.closest("label")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Includes stack traces/ })).toBeNull();
    expect(checkbox.hasAttribute("aria-labelledby")).toBe(false);
  });

  it("does not nest a label inside the row label", () => {
    const { container } = render(
      <Field orientation="horizontal">
        <Checkbox checked={false} onCheckedChange={vi.fn()} />
        <FieldLabel>Send crash reports</FieldLabel>
        <FieldDescription>Includes stack traces</FieldDescription>
      </Field>
    );
    expect(container.querySelectorAll("label")).toHaveLength(1);
  });
});

describe("Field slot guards", () => {
  // The whole point of the primitive is that a description cannot end up
  // unassociated. A slot hidden behind a wrapper is invisible to the render-time
  // scan, so it must fail loudly rather than render with no id.
  it("refuses to associate a slot nested behind a wrapper component", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const Wrapped = () => <FieldDescription>Buried</FieldDescription>;
    try {
      expect(() =>
        render(
          <Field>
            <FieldLabel>Endpoint</FieldLabel>
            <Input />
            <Wrapped />
          </Field>
        )
      ).toThrow(/direct child of <Field>/);
    } finally {
      consoleError.mockRestore();
    }
  });

  // Both would render the same generated id, leaving the control described by
  // whichever the document reached first.
  it("refuses to allocate one id to two slots of the same kind", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        render(
          <Field>
            <FieldLabel>Endpoint</FieldLabel>
            <Input />
            <FieldDescription>First</FieldDescription>
            <FieldDescription>Second</FieldDescription>
          </Field>
        )
      ).toThrow(/at most one FieldDescription/);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("refuses to render its parts outside a Field", () => {
    // React logs the thrown error before it propagates; silence the noise.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(<FieldLabel>Orphan</FieldLabel>)).toThrow(/inside a <Field>/);
      expect(() => render(<FieldDescription>Orphan</FieldDescription>)).toThrow(/inside a <Field>/);
      expect(() => render(<FieldError>Orphan</FieldError>)).toThrow(/inside a <Field>/);
    } finally {
      consoleError.mockRestore();
    }
  });
});
