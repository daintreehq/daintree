import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictationRecord } from "@/store/dictationRangeStore";
import {
  claimWaitingSend,
  hasWaitingStopAndSend,
  isHeldBackSession,
  planVoiceDraftSend,
  sendWaitingStopAndSends,
} from "../voiceDraftSend";

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

describe("waiting sends the stop-and-send key started (#15705)", () => {
  const releases: Array<() => void> = [];
  afterEach(() => releases.splice(0).forEach((release) => release()));
  const claim = (panelId: string, sendNow?: () => void, sessions = new Set(["s1"])) => {
    const release = claimWaitingSend(panelId, sessions, sendNow);
    releases.push(release);
    return release;
  };

  it("counts only a send the key started, and only until it is released", () => {
    claim("enter-panel");
    expect(hasWaitingStopAndSend()).toBe(false);
    expect(sendWaitingStopAndSends()).toBe(false);

    const sendNow = vi.fn();
    const release = claim("key-panel", sendNow);
    expect(hasWaitingStopAndSend()).toBe(true);

    release();
    expect(hasWaitingStopAndSend()).toBe(false);
    expect(sendWaitingStopAndSends()).toBe(false);
    expect(sendNow).not.toHaveBeenCalled();
  });

  it("sends every waiting send the key started, and leaves one Enter started alone", () => {
    const first = vi.fn();
    const second = vi.fn();
    claim("panel-a", first);
    claim("panel-b", second);
    claim("enter-panel");

    expect(sendWaitingStopAndSends()).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer send for the same panel when an older one's release comes late", () => {
    const sessions = new Set(["s1"]);
    const stale = claim("panel-a", vi.fn(), sessions);
    const newer = vi.fn();
    claim("panel-a", newer, sessions);

    stale();

    expect(hasWaitingStopAndSend()).toBe(true);
    expect(isHeldBackSession("panel-a", "a-later-session")).toBe(true);
    sendWaitingStopAndSends();
    expect(newer).toHaveBeenCalledTimes(1);
  });
});
