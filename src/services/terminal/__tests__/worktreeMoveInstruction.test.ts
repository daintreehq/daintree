import { describe, it, expect } from "vitest";
import {
  buildWorktreeMoveInstruction,
  composeDraftWithInstruction,
} from "../worktreeMoveInstruction";

const INSTRUCTION = buildWorktreeMoveInstruction("/repo/wt-b");

describe("buildWorktreeMoveInstruction", () => {
  it("names the directory exactly once, on one line", () => {
    // The invariant, not the literal: a copied string would only re-assert the
    // implementation. What matters is that the agent gets one unambiguous
    // instruction carrying the path verbatim.
    const path = "/repo/wt-b";
    const message = buildWorktreeMoveInstruction(path);

    expect(message.split(path)).toHaveLength(2);
    expect(message.includes("\n")).toBe(false);
    expect(message.trim()).toBe(message);
  });

  it("does not leak a different destination's path", () => {
    expect(buildWorktreeMoveInstruction("/repo/wt-c")).not.toContain("/repo/wt-b");
  });
});

describe("composeDraftWithInstruction", () => {
  it("sends the instruction alone when the draft is blank", () => {
    for (const blank of ["", "   ", "\n\n", " \t\n "]) {
      expect(composeDraftWithInstruction(blank, INSTRUCTION)).toBe(INSTRUCTION);
    }
  });

  it("reproduces a non-blank draft byte for byte", () => {
    // Trailing spaces can be a deliberate Markdown hard break, and the point of
    // #11867's bar path is that the user's draft goes along untouched.
    const draft = "look at @diff  ";
    const composed = composeDraftWithInstruction(draft, INSTRUCTION);

    expect(composed.startsWith(draft)).toBe(true);
    expect(composed.endsWith(INSTRUCTION)).toBe(true);
  });

  it("separates the draft from the instruction with a blank line", () => {
    const composed = composeDraftWithInstruction("fix the bug", INSTRUCTION);

    expect(composed.slice("fix the bug".length, -INSTRUCTION.length)).toBe("\n\n");
  });

  it("adds only newlines, and only the ones the draft is missing", () => {
    for (const draft of ["fix it", "fix it\n", "fix it\n\n", "fix it\n\n\n\n", "fix it  "]) {
      const composed = composeDraftWithInstruction(draft, INSTRUCTION);

      // Anchored first: without this the rows that already end in a blank line
      // would pass even if the instruction were dropped entirely.
      expect(composed.startsWith(draft)).toBe(true);
      expect(composed.endsWith(INSTRUCTION)).toBe(true);
      const separator = composed.slice(draft.length, composed.length - INSTRUCTION.length);

      // Nothing but newlines is ever inserted...
      expect(separator).toMatch(/^\n*$/);
      // ...enough of them to leave a blank line...
      expect(draft + separator).toMatch(/\n\n$/);
      // ...and never one more than that.
      if (separator.length > 0) {
        expect(`${draft}${separator.slice(0, -1)}`).not.toMatch(/\n\n$/);
      }
    }
  });

  it("appends once, so the instruction cannot be doubled", () => {
    const composed = composeDraftWithInstruction("already said it", INSTRUCTION);

    expect(composed.split(INSTRUCTION)).toHaveLength(2);
  });
});
