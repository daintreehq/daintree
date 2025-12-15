import { describe, expect, it } from "vitest";
import { isEnterLikeLineBreakInputEvent } from "../hybridInputEvents";

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
