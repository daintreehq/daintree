import { describe, expect, it } from "vitest";
import { planVoiceBreak, planVoiceWords } from "../voiceInsertion";

const point = (at: number) => ({ from: at, to: at, edited: false });
const written = (plan: ReturnType<typeof planVoiceWords>) => ({
  next: plan.next,
  words: plan.next.slice(plan.words.from, plan.words.to),
  insertion: plan.next.slice(plan.insertion.from, plan.insertion.to),
  anchor: plan.anchor,
});

describe("planVoiceWords", () => {
  it("appends with a separator when there is no anchor", () => {
    const plan = planVoiceWords("Fix it.", null, "Then test.");
    expect(written(plan)).toMatchObject({
      next: "Fix it. Then test.",
      words: "Then test.",
      insertion: " Then test.",
      anchor: { from: 18, to: 18 },
    });
  });

  it("spaces words dropped between two others on both sides", () => {
    const plan = planVoiceWords("hello world", point(5), "big");
    expect(plan.next).toBe("hello big world");
    expect(written(plan)).toMatchObject({ words: "big", insertion: " big" });
    // The space after the words is the draft's, so the next words follow on.
    expect(plan.anchor).toEqual({ from: 9, to: 9 });
  });

  it("adds no space before punctuation or after an opening bracket", () => {
    expect(planVoiceWords("Ship it.", point(7), "today").next).toBe("Ship it today.");
    expect(planVoiceWords("call ()", point(6), "args").next).toBe("call (args)");
  });

  it("adds no space where the draft already has one", () => {
    expect(planVoiceWords("hello world", point(6), "big").next).toBe("hello big world");
  });

  it("replaces the selection the anchor still holds", () => {
    const plan = planVoiceWords(
      "open the zoo stand store",
      { from: 9, to: 18, edited: false },
      "Zustand"
    );
    expect(plan.next).toBe("open the Zustand store");
    expect(plan.at).toEqual({ from: 9, to: 18 });
    expect(plan.anchor).toEqual({ from: 16, to: 16 });
    expect(plan.replaced).toBe("zoo stand");
  });

  it("reports nothing replaced where the words only went in", () => {
    expect(planVoiceWords("open the store", point(8), "big").replaced).toBeUndefined();
    expect(planVoiceWords("open the store", null, "big").replaced).toBeUndefined();
  });

  it("leaves a selection the user changed and writes after it", () => {
    const plan = planVoiceWords("open the zoo store", { from: 9, to: 12, edited: true }, "now");
    expect(plan.next).toBe("open the zoo now store");
    expect(plan.at).toEqual({ from: 12, to: 12 });
    expect(plan.replaced).toBeUndefined();
  });

  it("clamps an anchor past the end of the draft", () => {
    const plan = planVoiceWords("hi", point(10), "there");
    expect(plan.next).toBe("hi there");
    expect(plan.at).toEqual({ from: 2, to: 2 });
    expect(plan.words).toEqual({ from: 3, to: 8 });
    expect(plan.anchor).toEqual({ from: 8, to: 8 });
  });

  it("separates words dropped into the middle of one, keeping the space after outside", () => {
    const plan = planVoiceWords("helloworld", point(5), "big");
    expect(plan.next).toBe("hello big world");
    expect(plan.change).toEqual({ from: 5, to: 5, insert: " big " });
    expect(plan.anchor).toEqual({ from: 9, to: 9 });
    expect(plan.separatorAfter).toEqual({ from: 9, to: 10 });
  });

  it("reports no separator after the words when the draft already had one", () => {
    expect(planVoiceWords("hello world", point(5), "big").separatorAfter).toBeUndefined();
    expect(planVoiceWords("hello", null, "big").separatorAfter).toBeUndefined();
  });

  it("puts no space before dictated punctuation", () => {
    const plan = planVoiceWords("Hello, world", { from: 5, to: 6, edited: false }, ",");
    expect(plan.next).toBe("Hello, world");
    expect(plan.words).toEqual({ from: 5, to: 6 });
  });
});

describe("planVoiceBreak", () => {
  it("breaks the line at the anchor and moves the anchor past it", () => {
    const plan = planVoiceBreak("one two", point(3));
    expect(plan.next).toBe("one\n two");
    expect(plan.insertion).toEqual({ from: 3, to: 4 });
    expect(plan.anchor).toEqual({ from: 4, to: 4 });
  });

  it("keeps a pending selection for the words that follow", () => {
    const plan = planVoiceBreak("keep this", { from: 5, to: 9, edited: false });
    expect(plan.next).toBe("keep \nthis");
    expect(plan.anchor).toEqual({ from: 6, to: 10 });
  });
});
