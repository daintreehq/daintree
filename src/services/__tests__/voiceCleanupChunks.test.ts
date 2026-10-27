import { describe, expect, it } from "vitest";
import { chunkFollowUpDecides, mayCutChunk } from "../voiceCleanupChunks";

describe("mayCutChunk", () => {
  const before = "The cache is stale after every deploy, so the dashboard shows old numbers.";

  it("cuts after a finished sentence when what follows starts something new", () => {
    expect(mayCutChunk(before, "The other problem is the login page.", false)).toBe(true);
  });

  it("holds a pause that doesn't come after a finished sentence", () => {
    expect(mayCutChunk("The cache is stale after every", "deploy so it shows", false)).toBe(false);
  });

  it("cuts at a spoken paragraph break even without a full stop", () => {
    expect(mayCutChunk("Here is the summary of the change", "Next up is testing", true)).toBe(
      false
    );
    expect(mayCutChunk("Here is the summary of the change", "Testing comes later", true)).toBe(
      true
    );
  });

  it.each([
    "No wait, it's the staging one.",
    "Actually, make that the other dashboard.",
    "Sorry, I meant the login page.",
    "I mean the API, not the page.",
    "Scratch that, it's fine.",
    "Or rather the cache layer.",
  ])("holds when the speaker takes it back: %s", (after) => {
    expect(mayCutChunk(before, after, false)).toBe(false);
  });

  it.each(["Second, update the tests.", "Then deploy it.", "And the docs too.", "Two: rerun it."])(
    "holds when a list or thought carries on: %s",
    (after) => {
      expect(mayCutChunk(before, after, false)).toBe(false);
    }
  );

  it("holds while the last sentence counts out an item", () => {
    expect(
      mayCutChunk("Here's the plan. First, clear the cache.", "We can talk about it.", false)
    ).toBe(false);
    expect(
      mayCutChunk("Here's the plan. Finally, clear the cache.", "We can talk about it.", false)
    ).toBe(true);
  });

  it("holds after a sentence that introduces a list", () => {
    expect(mayCutChunk("We need three things:", "Better tests and docs.", true)).toBe(false);
  });
});

describe("chunkFollowUpDecides", () => {
  it("waits for a few words or a whole sentence", () => {
    expect(chunkFollowUpDecides("I")).toBe(false);
    expect(chunkFollowUpDecides("I mean")).toBe(false);
    expect(chunkFollowUpDecides("I mean the")).toBe(true);
    expect(chunkFollowUpDecides("Yes.")).toBe(true);
  });
});
