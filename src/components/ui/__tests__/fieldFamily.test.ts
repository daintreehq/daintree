import { describe, expect, it } from "vitest";
import { inputVariants } from "../input";
import { textareaVariants } from "../textarea";
import { selectTriggerVariants } from "../select";
import { FIELD_FOCUS, FIELD_SURFACE } from "@/components/Worktree/views/WorktreeFormLayout";

/**
 * The tokens that make a field read as a field: its fill, its edge, its corner
 * and its focus ring. Every field-like control has to agree on all of them, so
 * a select beside an input — or a dialog field beside a settings field — is the
 * same control rather than a near miss.
 */
function chrome(classes: string): string[] {
  return classes
    .split(/\s+/)
    .filter((t) =>
      /^(bg-surface-|border-border-|rounded-|focus-visible:outline|focus:|focus-within:)/.test(t)
    )
    .sort();
}

const INPUT = chrome(inputVariants());

describe("form field family", () => {
  it("draws the select trigger with the input's chrome at every density", () => {
    expect(chrome(selectTriggerVariants())).toEqual(INPUT);
    expect(chrome(selectTriggerVariants({ density: "compact" }))).toEqual(INPUT);
  });

  it("draws the textarea with the input's chrome", () => {
    expect(chrome(textareaVariants())).toEqual(INPUT);
  });

  it("gives dialog form fields the same chrome as settings fields", () => {
    expect(chrome(`${FIELD_SURFACE} ${FIELD_FOCUS}`)).toEqual(INPUT);
  });

  it("keys every field's focus indicator off focus-visible, not focus", () => {
    for (const classes of [
      inputVariants(),
      textareaVariants(),
      selectTriggerVariants(),
      `${FIELD_SURFACE} ${FIELD_FOCUS}`,
    ]) {
      expect(classes.split(/\s+/).filter((t) => t.startsWith("focus:"))).toEqual([]);
      expect(classes).toMatch(/focus-visible:outline-offset-/);
    }
  });
});
