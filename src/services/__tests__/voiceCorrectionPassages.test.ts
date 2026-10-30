import { describe, expect, it } from "vitest";
import { VoiceCorrectionPassagesSchema } from "@shared/types/voiceSessionSummary";
import type { DictationRecord } from "@/store/dictationRangeStore";
import { correctionRequest } from "../voiceCorrectionRequest";
import {
  collectCorrectionPassages,
  countPassageFates,
  settlePassageReplies,
  type PassageFate,
} from "../voiceCorrectionPassages";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Reply = { text: string; timing: unknown; prefetch?: string };

describe("settlePassageReplies", () => {
  it("keeps the passages in order and the last reply back", async () => {
    const first = deferred<Reply>();
    const second = deferred<Reply>();
    const settled = settlePassageReplies([first.promise, second.promise]);

    const lastBack = {
      text: "A",
      timing: { prepMs: 8, requestMs: 1_400 },
      prefetch: "not_matched",
    };
    second.resolve({ text: "B", timing: { prepMs: 5, requestMs: 900 }, prefetch: "adopted" });
    await Promise.resolve();
    first.resolve(lastBack);

    const { results, last } = await settled;
    expect(results.map((result) => result.text)).toEqual(["A", "B"]);
    // Its timing and its prefetch come together, from the same reply.
    expect(last).toBe(lastBack);
    expect(last).toStrictEqual({
      text: "A",
      timing: { prepMs: 8, requestMs: 1_400 },
      prefetch: "not_matched",
    });
  });

  it("takes a last reply that carries nothing over an earlier one that did", async () => {
    const first = deferred<Reply>();
    const second = deferred<Reply>();
    const settled = settlePassageReplies([first.promise, second.promise]);

    const lastBack = { text: "B", timing: null };
    first.resolve({ text: "A", timing: { prepMs: 8, requestMs: 1_400 }, prefetch: "adopted" });
    await Promise.resolve();
    second.resolve(lastBack);

    // Nothing of the earlier reply's carries over to stand in for it.
    const { last } = await settled;
    expect(last).toBe(lastBack);
    expect(last).toStrictEqual({ text: "B", timing: null });
  });

  it("has no last reply for no passages", async () => {
    expect((await settlePassageReplies<Reply>([])).last).toBeNull();
  });
});

describe("countPassageFates", () => {
  const fates: PassageFate[] = [
    "applied",
    "unchanged",
    "skipped",
    "failed",
    "timed_out",
    "dropped",
    "unlanded",
  ];

  it("counts every fate under a field of its own, once", () => {
    const counts = countPassageFates(fates);
    const { sent, ...byFate } = counts;
    expect(sent).toBe(fates.length);
    expect(Object.values(byFate)).toEqual(fates.map(() => 1));
    expect(VoiceCorrectionPassagesSchema.safeParse(counts).success).toBe(true);
  });

  it("adds repeats up and counts none for no passages", () => {
    expect(countPassageFates(["applied", "applied", "failed"])).toMatchObject({
      sent: 3,
      applied: 2,
      failed: 1,
    });
    expect(countPassageFates([]).sent).toBe(0);
  });
});

describe("the command the draft opens with", () => {
  // Each phrase dictated where it sits in `draft`, typed text around them.
  function dictated(draft: string, phrases: string[]): DictationRecord {
    const spans = phrases.map((phrase) => {
      const from = draft.indexOf(phrase);
      return { from, to: from + phrase.length, edited: false };
    });
    return {
      id: "record",
      sessionId: "session",
      panelId: "panel",
      range: { from: spans[0]!.from, to: spans[spans.length - 1]!.to, edited: true },
      utterances: spans.map((span, index) => ({
        id: `u${index}`,
        range: span,
        insertion: span,
      })),
      breaks: [],
    };
  }

  it("goes with every passage of the prompt, however far past the context it is", () => {
    const typed = "x".repeat(600);
    const draft = `/review-pr 42 check the retry loop ${typed} and the cache keys`;
    const passages = collectCorrectionPassages(
      dictated(draft, ["check the retry loop", "and the cache keys"]),
      draft
    );

    expect(passages.map((passage) => passage.text)).toEqual([
      "check the retry loop",
      "and the cache keys",
    ]);
    expect(passages[1]!.context).not.toContain("/review-pr");
    expect(passages.map((passage) => passage.openingCommand)).toEqual(["/review-pr", "/review-pr"]);
    expect(correctionRequest(passages[1]!, {}, null).openingCommandToken).toBe("/review-pr");
  });

  it.each([
    ["please /review the retry loop", "the retry loop"],
    ["/review. the retry loop", "the retry loop"],
    ["/etc/hosts has the retry loop", "the retry loop"],
    ["$PATH is missing the retry loop", "the retry loop"],
  ])("goes with none when %j doesn't open with one", (draft, phrase) => {
    const [passage] = collectCorrectionPassages(dictated(draft, [phrase]), draft);
    expect(passage!.openingCommand).toBeUndefined();
    expect(correctionRequest(passage!, {}, null)).not.toHaveProperty("openingCommandToken");
  });
});
