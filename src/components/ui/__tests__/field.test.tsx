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
