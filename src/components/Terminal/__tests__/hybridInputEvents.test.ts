// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { agentAltChordKey, isEnterLikeLineBreakInputEvent } from "../hybridInputEvents";

describe("isEnterLikeLineBreakInputEvent", () => {
  it("matches insertLineBreak and insertParagraph", () => {
    expect(
      isEnterLikeLineBreakInputEvent({ inputType: "insertLineBreak" } as unknown as InputEvent)
    ).toBe(true);
    expect(
      isEnterLikeLineBreakInputEvent({ inputType: "insertParagraph" } as unknown as InputEvent)
    ).toBe(true);
  });

  it("matches insertText containing newlines", () => {
    expect(
      isEnterLikeLineBreakInputEvent({
        inputType: "insertText",
        data: "\n",
      } as unknown as InputEvent)
    ).toBe(true);
    expect(
      isEnterLikeLineBreakInputEvent({
        inputType: "insertText",
        data: "foo\rbar",
      } as unknown as InputEvent)
    ).toBe(true);
  });

  it("ignores other input types", () => {
    expect(
      isEnterLikeLineBreakInputEvent({
        inputType: "insertFromPaste",
        data: "\n",
      } as unknown as InputEvent)
    ).toBe(false);
  });
});

const CLAUDE_CHORDS = ["p", "t", "o"];

/** A keydown as Chromium delivers it: `key` is what the layout types, `keyCode`
 * the letter key the terminal encodes. */
function press(init: KeyboardEventInit & { keyCode?: number }) {
  return new KeyboardEvent("keydown", { cancelable: true, ...init });
}

describe("agentAltChordKey", () => {
  it("sends macOS Option+P, Option+T and Option+O as the agent's chords, whatever glyph they type", () => {
    expect(
      agentAltChordKey(press({ key: "π", code: "KeyP", keyCode: 80, altKey: true }), CLAUDE_CHORDS)
    ).toBe("alt+p");
    expect(
      agentAltChordKey(press({ key: "†", code: "KeyT", keyCode: 84, altKey: true }), CLAUDE_CHORDS)
    ).toBe("alt+t");
    expect(
      agentAltChordKey(press({ key: "ø", code: "KeyO", keyCode: 79, altKey: true }), CLAUDE_CHORDS)
    ).toBe("alt+o");
  });

  it("sends Alt+P on Windows and Linux, where the key is the letter itself", () => {
    expect(
      agentAltChordKey(press({ key: "p", code: "KeyP", keyCode: 80, altKey: true }), CLAUDE_CHORDS)
    ).toBe("alt+p");
  });

  it("reads the letter from the key code, as the terminal does, not the physical key", () => {
    // Dvorak's P sits on the physical R key; Option+P still means P there.
    expect(
      agentAltChordKey(press({ key: "π", code: "KeyR", keyCode: 80, altKey: true }), CLAUDE_CHORDS)
    ).toBe("alt+p");
    expect(
      agentAltChordKey(press({ key: "®", code: "KeyP", keyCode: 82, altKey: true }), CLAUDE_CHORDS)
    ).toBeNull();
  });

  it("falls back to the physical key for a dead key, which carries no letter code", () => {
    expect(
      agentAltChordKey(press({ key: "Dead", code: "KeyO", keyCode: 0, altKey: true }), CLAUDE_CHORDS)
    ).toBe("alt+o");
  });

  it("leaves Option chords the agent doesn't document to type", () => {
    // German Option+L is @, Option+5 is [; Alt+B/F/D edit the agent's own
    // prompt, which the composer stands in for.
    expect(
      agentAltChordKey(press({ key: "@", code: "KeyL", keyCode: 76, altKey: true }), CLAUDE_CHORDS)
    ).toBeNull();
    expect(
      agentAltChordKey(press({ key: "[", code: "Digit5", keyCode: 53, altKey: true }), CLAUDE_CHORDS)
    ).toBeNull();
    expect(
      agentAltChordKey(press({ key: "∫", code: "KeyB", keyCode: 66, altKey: true }), CLAUDE_CHORDS)
    ).toBeNull();
  });

  it("leaves Option+P to type for an agent, or a terminal, that declares no chords", () => {
    const optionP = press({ key: "π", code: "KeyP", keyCode: 80, altKey: true });
    expect(agentAltChordKey(optionP, undefined)).toBeNull();
    expect(agentAltChordKey(optionP, [])).toBeNull();
  });

  it("never takes AltGr typing on Windows, which holds Ctrl with Alt", () => {
    expect(
      agentAltChordKey(
        press({ key: "π", code: "KeyP", keyCode: 80, altKey: true, ctrlKey: true }),
        CLAUDE_CHORDS
      )
    ).toBeNull();
  });

  it("never takes AltGr typing reported as AltGraph", () => {
    expect(
      agentAltChordKey(
        press({ key: "þ", code: "KeyP", keyCode: 80, altKey: true, modifierAltGraph: true }),
        CLAUDE_CHORDS
      )
    ).toBeNull();
  });

  it("leaves the chord alone with another modifier held or no Alt at all", () => {
    const base = { key: "π", code: "KeyP", keyCode: 80 };
    expect(agentAltChordKey(press({ ...base, altKey: true, shiftKey: true }), CLAUDE_CHORDS)).toBeNull();
    expect(agentAltChordKey(press({ ...base, altKey: true, metaKey: true }), CLAUDE_CHORDS)).toBeNull();
    expect(agentAltChordKey(press({ ...base, key: "p" }), CLAUDE_CHORDS)).toBeNull();
  });

  it("sends a held chord on every repeat, as the terminal does", () => {
    expect(
      agentAltChordKey(
        press({ key: "π", code: "KeyP", keyCode: 80, altKey: true, repeat: true }),
        CLAUDE_CHORDS
      )
    ).toBe("alt+p");
  });

  it("finds no letter in a press that carries neither a letter code nor a dead letter key", () => {
    expect(
      agentAltChordKey(press({ key: "Process", code: "KeyP", keyCode: 229, altKey: true }), CLAUDE_CHORDS)
    ).toBeNull();
    expect(
      agentAltChordKey(press({ key: "Dead", code: "Digit6", keyCode: 0, altKey: true }), CLAUDE_CHORDS)
    ).toBeNull();
  });

  it("leaves a press inside an IME composition to the composition", () => {
    expect(
      agentAltChordKey(
        press({ key: "π", code: "KeyP", keyCode: 80, altKey: true, isComposing: true }),
        CLAUDE_CHORDS
      )
    ).toBeNull();
  });
});
