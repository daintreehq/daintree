// @vitest-environment jsdom
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { cn } from "@/lib/utils";
import { Textarea, textareaVariants } from "../textarea";
import { Field, FieldDescription, FieldLabel } from "../field";
import { expectNoUnfocusedAccent, expectSingleWinner, utilitiesInGroup } from "./variantAssertions";

describe("Textarea native surface", () => {
  it("forwards the ref to the textarea element", () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea ref={ref} aria-label="Prompt" />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
  });

  it("passes through native props and change events", () => {
    const onChange = vi.fn();
    render(<Textarea aria-label="Prompt" rows={6} defaultValue="hello" onChange={onChange} />);
    const textarea = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    expect(textarea.rows).toBe(6);
    expect(textarea.value).toBe("hello");

    fireEvent.change(textarea, { target: { value: "goodbye" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("joins the enclosing field the same way an input does", () => {
    render(
      <Field>
        <FieldLabel>Prompt</FieldLabel>
        <Textarea />
        <FieldDescription>Sent verbatim to the agent</FieldDescription>
      </Field>
    );
    const textarea = screen.getByLabelText("Prompt");
    const ids = textarea.getAttribute("aria-describedby")!.split(" ");
    expect(document.getElementById(ids[0]!)?.textContent).toBe("Sent verbatim to the agent");
  });
});

describe("textareaVariants", () => {
  it("resolves every combination to a single utility per property", () => {
    for (const density of ["compact", "default"] as const) {
      for (const variant of ["default", "code"] as const) {
        for (const resize of ["vertical", "none"] as const) {
          expectSingleWinner(textareaVariants({ density, variant, resize }), [
            "paddingX",
            "paddingY",
            "fontSize",
            "resize",
          ]);
        }
      }
    }
  });

  it("keeps typography and spacing on independent axes", () => {
    const compactDefault = textareaVariants({ density: "compact", variant: "default" });
    const compactCode = textareaVariants({ density: "compact", variant: "code" });
    expect(utilitiesInGroup(compactDefault, "paddingX")).toEqual(
      utilitiesInGroup(compactCode, "paddingX")
    );
    expect(compactCode).toContain("font-mono");
    expect(compactDefault).not.toContain("font-mono");
  });

  it("never widens to a blanket transition", () => {
    const classes = textareaVariants();
    expect(classes).not.toContain("transition-all");
    expect(utilitiesInGroup(classes, "transition")).toEqual(["transition-colors"]);
  });

  it("spends accent only on the focus ring", () => {
    expectNoUnfocusedAccent(textareaVariants());
  });

  it("lets a consumer class win its property group outright", () => {
    const merged = cn(textareaVariants({ variant: "code" }), "resize-none text-sm");
    expect(utilitiesInGroup(merged, "resize")).toEqual(["resize-none"]);
    expect(utilitiesInGroup(merged, "fontSize")).toEqual(["text-sm"]);
  });
});
