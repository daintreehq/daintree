// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type React from "react";
import { isEnterToSubmit } from "../enterToSubmit";

function keyEvent(
  target: EventTarget,
  init: Partial<{
    key: string;
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
  }> = {},
  native: Partial<{ isComposing: boolean; keyCode: number }> = {}
): React.KeyboardEvent {
  return {
    key: "Enter",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...init,
    target,
    nativeEvent: { isComposing: false, keyCode: 13, ...native },
  } as unknown as React.KeyboardEvent;
}

function input(type: string): HTMLInputElement {
  const el = document.createElement("input");
  el.type = type;
  return el;
}

describe("isEnterToSubmit", () => {
  it.each(["text", "search", "url", "email", "number", "password", "tel"])(
    "submits from a single-line %s field",
    (type) => {
      expect(isEnterToSubmit(keyEvent(input(type)))).toBe(true);
    }
  );

  it("leaves Enter alone where it means something else", () => {
    expect(isEnterToSubmit(keyEvent(document.createElement("textarea")))).toBe(false);
    expect(isEnterToSubmit(keyEvent(document.createElement("select")))).toBe(false);
    expect(isEnterToSubmit(keyEvent(input("checkbox")))).toBe(false);
    expect(isEnterToSubmit(keyEvent(document.createElement("button")))).toBe(false);
  });

  it("never submits a modified Enter or another key", () => {
    const field = input("text");
    for (const modifier of ["shiftKey", "metaKey", "ctrlKey", "altKey"] as const) {
      expect(isEnterToSubmit(keyEvent(field, { [modifier]: true }))).toBe(false);
    }
    expect(isEnterToSubmit(keyEvent(field, { key: "a" }))).toBe(false);
  });

  it("never submits the Enter that commits an IME composition", () => {
    const field = input("text");
    expect(isEnterToSubmit(keyEvent(field, {}, { isComposing: true }))).toBe(false);
    expect(isEnterToSubmit(keyEvent(field, {}, { keyCode: 229 }))).toBe(false);
  });
});
