import { describe, expect, it } from "vitest";
import type { DictationRecord } from "@/store/dictationRangeStore";
import { planVoiceDraftSend } from "../voiceDraftSend";

const TARGET = { panelId: "panel-1", projectId: "project-1" };
const SENT_BY = new Set(["stopped"]);

/** A one-utterance dictation over `inserted` (separator included) where it sits in `draft`. */
function dictation(
  draft: string,
  sessionId: string,
  inserted: string,
  learning?: { from: number; to: number }
): DictationRecord {
  const from = draft.indexOf(inserted);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = from + inserted.length;
  const wordsFrom = from + (inserted.length - inserted.trimStart().length);
  const words = { from: wordsFrom, to, edited: false };
  return {
    id: `dictation-${sessionId}`,
    sessionId,
    panelId: TARGET.panelId,
    projectId: TARGET.projectId,
    range: { from, to, edited: false },
    utterances: [
      { id: `utterance-${sessionId}`, range: words, insertion: { from, to, edited: false } },
    ],
    breaks: [],
    learningSpan: learning ?? { from: wordsFrom, to },
  };
}

/** Applies the plan's deletions, last first, the way the draft write does. */
function applyChanges(draft: string, plan: ReturnType<typeof planVoiceDraftSend>): string {
  return [...plan.changes]
    .sort((a, b) => b.from - a.from)
    .reduce((text, { from, to, insert }) => text.slice(0, from) + insert + text.slice(to), draft);
}

describe("planVoiceDraftSend (#14804)", () => {
  it("sends the whole draft when no newer session wrote in it", () => {
    const draft = "Hello world. More of it.";
    const plan = planVoiceDraftSend(
      TARGET,
      draft,
      [dictation(draft, "stopped", "Hello world."), dictation(draft, "stopped", " More of it.")],
      SENT_BY
    );

    expect(plan).toMatchObject({ text: draft, kept: "", changes: [], leadingSpace: null });
  });

  it("holds back a newer session's words, the space it was written with going with the send", () => {
    const draft = "Hello world. these are the next prompt";
    const newer = dictation(draft, "newer", " these are the next prompt");
    const plan = planVoiceDraftSend(
      TARGET,
      draft,
      [dictation(draft, "stopped", "Hello world."), newer],
      SENT_BY
    );

    expect(plan.text).toBe("Hello world.");
    expect(plan.kept).toBe("these are the next prompt");
    expect(applyChanges(draft, plan)).toBe(plan.kept);
    expect(plan.leadingSpace).toEqual({ dictationId: newer.id, span: { from: 12, to: 13 } });
  });

  it("joins the text either side of newer words in the middle of the draft", () => {
    const draft = "Fix the bug next words and add a test";
    const plan = planVoiceDraftSend(
      TARGET,
      draft,
      [dictation(draft, "newer", " next words")],
      SENT_BY
    );

    expect(plan.text).toBe("Fix the bug and add a test");
    expect(plan.kept).toBe("next words");
    expect(applyChanges(draft, plan)).toBe("next words");
  });

  it("keeps two newer sessions' words apart, and only the first gives up its space", () => {
    const draft = "One. two three. four";
    const second = dictation(draft, "second", " four");
    const plan = planVoiceDraftSend(
      TARGET,
      draft,
      [second, dictation(draft, "first", " two")],
      SENT_BY
    );

    expect(plan.text).toBe("One. three.");
    expect(plan.kept).toBe("two four");
    expect(applyChanges(draft, plan)).toBe("two four");
    expect(plan.leadingSpace?.dictationId).toBe("dictation-first");
  });

  it("holds back words a cleanup rewrote, which only the learning span still covers", () => {
    const draft = "Hello world. The next prompt.";
    const from = draft.indexOf(" The");
    // The cleanup replaced every word, so the envelope kept only the space.
    const cleaned: DictationRecord = {
      ...dictation(draft, "newer", " The next prompt.", { from: from + 1, to: draft.length }),
      range: { from, to: from + 1, edited: true },
    };
    const plan = planVoiceDraftSend(TARGET, draft, [cleaned], SENT_BY);

    expect(plan.text).toBe("Hello world.");
    expect(plan.kept).toBe("The next prompt.");
    expect(applyChanges(draft, plan)).toBe(plan.kept);
  });

  it("leaves a paragraph break the newer words open with in what's kept", () => {
    const draft = "Hello world.\nnext words";
    const plan = planVoiceDraftSend(
      TARGET,
      draft,
      [dictation(draft, "newer", "\nnext words")],
      SENT_BY
    );

    expect(plan.text).toBe("Hello world.");
    expect(plan.kept).toBe("\nnext words");
    expect(applyChanges(draft, plan)).toBe(plan.kept);
    expect(plan.leadingSpace).toBeNull();
  });
});
