import { describe, expect, it } from "vitest";
import { stripHesitations } from "../voiceHesitations.js";
import { carrySpansThroughEdits, type VoiceTextEdit } from "../voiceUncertainWords.js";

describe("stripHesitations", () => {
  it.each([
    // OpenAI writes them capitalised, with punctuation of its own.
    ["Um, so the build failed", "So the build failed"],
    ["Uh, can you check", "Can you check"],
    ["Erm, maybe", "Maybe"],
    ["Umm... let me think", "Let me think"],
    ["Uhh, okay", "Okay"],
    ["Uhm. Right", "Right"],
    // Deepgram writes them as spoken.
    ["um so the build failed", "so the build failed"],
    ["uh can you check", "can you check"],
    ["uhmm, sure", "sure"],
    ["ermm okay", "okay"],
  ])("drops the hesitation opening %j", (input, expected) => {
    expect(stripHesitations(input)).toBe(expected);
  });

  it("capitalises the next word only when the hesitation was capitalised", () => {
    expect(stripHesitations("Um, we should")).toBe("We should");
    expect(stripHesitations("um, we should")).toBe("we should");
  });

  it("starts a new sentence with a capital after a full stop", () => {
    expect(stripHesitations("It broke. Um, we should revert")).toBe("It broke. We should revert");
    expect(stripHesitations("It broke. Uh. We should revert")).toBe("It broke. We should revert");
  });

  it("leaves a word whose capital would misspell it", () => {
    expect(stripHesitations("Um, iPhone support")).toBe("iPhone support");
  });

  it("closes the gap in the middle of a sentence", () => {
    expect(stripHesitations("I think um we should")).toBe("I think we should");
    expect(stripHesitations("I think, um, we should")).toBe("I think, we should");
    expect(stripHesitations("I think, um we should")).toBe("I think, we should");
    expect(stripHesitations("I think um, we should")).toBe("I think, we should");
    expect(stripHesitations("We went, uh, to the store")).toBe("We went, to the store");
  });

  it("keeps the sentence end a trailing hesitation sat in front of", () => {
    expect(stripHesitations("That is the plan, um.")).toBe("That is the plan.");
    expect(stripHesitations("Is that right um?")).toBe("Is that right?");
    expect(stripHesitations("That is the plan um")).toBe("That is the plan");
    expect(stripHesitations("That is it. Um.")).toBe("That is it.");
    expect(stripHesitations("It is, um. Next")).toBe("It is. Next");
  });

  it("drops a run of hesitations as one", () => {
    expect(stripHesitations("Uh, um, so the plan")).toBe("So the plan");
    expect(stripHesitations("I think, um, uh, we should")).toBe("I think, we should");
  });

  it("leaves nothing for an utterance that was only a hesitation", () => {
    expect(stripHesitations("Um.")).toBe("");
    expect(stripHesitations("uh")).toBe("");
    expect(stripHesitations("Uh, um...")).toBe("");
  });

  it("opens a sentence after a bracket or quote", () => {
    expect(stripHesitations('He said "Um, no"')).toBe('He said "No"');
  });

  it("does not cross a line break", () => {
    expect(stripHesitations("First line\nUm, second line")).toBe("First line\nSecond line");
    expect(stripHesitations("First line um\nsecond line")).toBe("First line\nsecond line");
  });

  it.each([
    "umbrella",
    "Humus",
    "number",
    "summer",
    "uhura",
    "ermine",
    "album",
    "um-hmm",
    "uh-huh",
    "uh-oh",
    "um.js",
    "@um",
    "src/um/index.ts",
    "um_helper",
    "um2",
    "get_uh_value",
    "`um`",
    "--um-flag",
    "https://example.com/um",
  ])("leaves %j alone", (input) => {
    expect(stripHesitations(`open ${input} now`)).toBe(`open ${input} now`);
  });

  it("leaves words that can carry meaning", () => {
    const text = "Well, like, you know, so hmm, mm, I mean";
    expect(stripHesitations(text)).toBe(text);
  });

  it("leaves a capitalised acronym alone", () => {
    expect(stripHesitations("The UM team and UH campus")).toBe("The UM team and UH campus");
  });

  it("drops the hesitation next to protected text without touching it", () => {
    expect(stripHesitations("Um, run `git status` please")).toBe("Run `git status` please");
    expect(stripHesitations("Uh, git status")).toBe("Git status");
    expect(stripHesitations("Uh, ./scripts/um/run.sh")).toBe("./scripts/um/run.sh");
  });

  it("reports each change in the coordinates of the text, in order", () => {
    const text = "Um, so I think, uh, we should";
    const edits: VoiceTextEdit[] = [];
    const result = stripHesitations(text, edits);
    expect(result).toBe("So I think, we should");
    let rebuilt = "";
    let at = 0;
    for (const edit of edits) {
      rebuilt += text.slice(at, edit.from) + edit.insert;
      at = edit.to;
    }
    expect(rebuilt + text.slice(at)).toBe(result);
  });

  it("returns the text itself when there is nothing to drop", () => {
    const edits: VoiceTextEdit[] = [];
    expect(stripHesitations("Nothing to see", edits)).toBe("Nothing to see");
    expect(edits).toEqual([]);
  });

  it("lets spans on the words around it move with the text", () => {
    const text = "Um, so check the build";
    const edits: VoiceTextEdit[] = [];
    const result = stripHesitations(text, edits);
    const from = text.indexOf("build");
    const [moved] = carrySpansThroughEdits([{ from, to: from + 5 }], edits);
    expect(result.slice(moved!.from, moved!.to)).toBe("build");
  });
});
