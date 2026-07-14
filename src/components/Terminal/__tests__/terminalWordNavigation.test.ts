import { describe, expect, it } from "vitest";
import { getOptionWordJumpSequence, type WordJumpKeyEvent } from "../terminalWordNavigation";

function makeKeyEvent(overrides: Partial<WordJumpKeyEvent>): WordJumpKeyEvent {
  return {
    key: "ArrowLeft",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  };
}

describe("getOptionWordJumpSequence", () => {
  it("maps Option+Left to the readline backward-word sequence", () => {
    expect(getOptionWordJumpSequence(makeKeyEvent({ key: "ArrowLeft", altKey: true }))).toBe(
      "\x1bb"
    );
  });

  it("maps Option+Right to the readline forward-word sequence", () => {
    expect(getOptionWordJumpSequence(makeKeyEvent({ key: "ArrowRight", altKey: true }))).toBe(
      "\x1bf"
    );
  });

  it("ignores arrows pressed without Option", () => {
    expect(getOptionWordJumpSequence(makeKeyEvent({ key: "ArrowLeft" }))).toBeNull();
    expect(getOptionWordJumpSequence(makeKeyEvent({ key: "ArrowRight" }))).toBeNull();
  });

  it("leaves Cmd+Option+Arrow to the terminal.focus* pane bindings", () => {
    expect(
      getOptionWordJumpSequence(makeKeyEvent({ key: "ArrowLeft", altKey: true, metaKey: true }))
    ).toBeNull();
    expect(
      getOptionWordJumpSequence(makeKeyEvent({ key: "ArrowRight", altKey: true, metaKey: true }))
    ).toBeNull();
  });

  it("leaves Shift+Option+Arrow to the selection-extend convention", () => {
    expect(
      getOptionWordJumpSequence(makeKeyEvent({ key: "ArrowLeft", altKey: true, shiftKey: true }))
    ).toBeNull();
  });

  it("ignores Ctrl+Option+Arrow", () => {
    expect(
      getOptionWordJumpSequence(makeKeyEvent({ key: "ArrowLeft", altKey: true, ctrlKey: true }))
    ).toBeNull();
  });

  it("ignores vertical arrows and non-arrow keys", () => {
    expect(getOptionWordJumpSequence(makeKeyEvent({ key: "ArrowUp", altKey: true }))).toBeNull();
    expect(getOptionWordJumpSequence(makeKeyEvent({ key: "ArrowDown", altKey: true }))).toBeNull();
    // Option+B/F already reach the shell as meta sequences via `macOptionIsMeta`.
    expect(getOptionWordJumpSequence(makeKeyEvent({ key: "b", altKey: true }))).toBeNull();
  });

  it("ignores a key the browser could not identify", () => {
    expect(
      getOptionWordJumpSequence(makeKeyEvent({ key: "Unidentified", altKey: true }))
    ).toBeNull();
  });
});
