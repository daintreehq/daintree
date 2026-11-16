import { beforeEach, describe, expect, it } from "vitest";
import { reviewKey, useDecisionsImageReviewStore } from "../decisionsImageReviewStore";

const store = () => useDecisionsImageReviewStore.getState();

beforeEach(() => store().clear());

describe("decisionsImageReviewStore", () => {
  it("records each image seen per pane and question, with the digest it was shown under", () => {
    store().markShown("t1", "qa", "attach_0001", "a".repeat(64));
    store().markShown("t1", "qa", "attach_0002", "b".repeat(64));
    store().markShown("t2", "qa", "attach_0001", "c".repeat(64));

    expect(store().byQuestion[reviewKey("t1", "qa")]).toEqual({
      attach_0001: "a".repeat(64),
      attach_0002: "b".repeat(64),
    });
    expect(store().byQuestion[reviewKey("t2", "qa")]).toEqual({ attach_0001: "c".repeat(64) });
  });

  it("changes nothing when the same image is seen again", () => {
    store().markShown("t1", "qa", "attach_0001", "a".repeat(64));
    const before = store().byQuestion;

    store().markShown("t1", "qa", "attach_0001", "a".repeat(64));

    expect(store().byQuestion).toBe(before);
  });

  it("keeps the most recently seen questions, dropping the oldest past its bound", () => {
    for (let i = 0; i < 64; i += 1) store().markShown("t1", `q${i}`, "attach_0001", "a".repeat(64));
    // Seeing the oldest question again makes it the newest.
    store().markShown("t1", "q0", "attach_0002", "b".repeat(64));
    store().markShown("t1", "q64", "attach_0001", "a".repeat(64));

    const keys = Object.keys(store().byQuestion);
    expect(keys).toHaveLength(64);
    expect(keys).toContain(reviewKey("t1", "q0"));
    expect(keys).toContain(reviewKey("t1", "q64"));
    expect(keys).not.toContain(reviewKey("t1", "q1"));
  });

  it("forgets everything on clear", () => {
    store().markShown("t1", "qa", "attach_0001", "a".repeat(64));
    store().clear();
    expect(store().byQuestion).toEqual({});
  });
});
