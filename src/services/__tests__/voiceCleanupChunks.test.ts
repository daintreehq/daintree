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
    "I meant the staging database.",
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

  it("holds between a full-stop intro and a first item", () => {
    expect(mayCutChunk(`${before} Here is the plan.`, "First, clear the cache.", false)).toBe(
      false
    );
    expect(mayCutChunk(`${before} Here is the plan.`, "Firstly, clear the cache.", false)).toBe(
      false
    );
  });

  it.each([
    "We need three things.",
    "There are two problems with this.",
    "I have 4 questions about the rollout.",
    "Three reasons the deploy is slow.",
    "We need to fix three small things.",
    "We have three very important requirements.",
    "I have 12 questions.",
    "There are a couple of things to check.",
  ])("holds after an intro that announces a count: %s", (intro) => {
    expect(mayCutChunk(`${before} ${intro}`, "Better tests and docs.", false)).toBe(false);
    expect(mayCutChunk(`${before} ${intro}`, "Better tests and docs.", true)).toBe(false);
  });

  it("still cuts at a break that has nothing to do with a list", () => {
    expect(mayCutChunk(`${before} It took ten seconds.`, "The login page is next.", false)).toBe(
      true
    );
    expect(mayCutChunk(`${before} It cost 5 dollars.`, "The login page is next.", false)).toBe(
      true
    );
    expect(mayCutChunk(`${before} That was the first problem.`, "The login page.", false)).toBe(
      true
    );
  });

  it("only reads the last sentence for an announced count", () => {
    expect(mayCutChunk(`We need three things. ${before}`, "The login page is next.", false)).toBe(
      true
    );
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
