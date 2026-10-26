import { describe, expect, it } from "vitest";
import type { DictationRecord, DictationUtterance } from "@/store/dictationRangeStore";
import { applyDraftEdits, planFileReferenceEdits } from "../voiceFileReferences";

function utterance(
  draft: string,
  words: string,
  options: { transcriptId?: string; edited?: boolean; after?: number } = {}
): DictationUtterance {
  const from = draft.indexOf(words, options.after ?? 0);
  if (from < 0) throw new Error(`"${words}" not in draft`);
  const to = from + words.length;
  return {
    id: `u-${from}`,
    range: { from, to, edited: options.edited ?? false },
    insertion: { from, to, edited: false },
    ...(options.transcriptId ? { transcriptId: options.transcriptId } : {}),
  };
}

function record(utterances: DictationUtterance[]): DictationRecord {
  const from = Math.min(...utterances.map((u) => u.range.from));
  const to = Math.max(...utterances.map((u) => u.range.to));
  return {
    id: "record-1",
    sessionId: "session-1",
    panelId: "panel-1",
    range: { from, to, edited: false },
    utterances,
  };
}

function swap(
  draft: string,
  rec: DictationRecord,
  utteranceId: string,
  references: Array<{ description: string; path: string | null }>
): string {
  return applyDraftEdits(draft, planFileReferenceEdits(rec, utteranceId, references, draft));
}

describe("planFileReferenceEdits", () => {
  it("swaps the command for its token inside its own transcript, not a later copy", () => {
    const draft = "Link to the input bar. Then link to the input bar, I typed.";
    const rec = record([utterance(draft, "Link to the input bar.", { transcriptId: "t1" })]);

    expect(swap(draft, rec, "t1", [{ description: "input bar", path: "src/InputBar.tsx" }])).toBe(
      "@src/InputBar.tsx. Then link to the input bar, I typed."
    );
  });

  it("swaps the spoken command, not the same description said before it", () => {
    const draft = "The input bar component needs work; link to the input bar component.";
    const rec = record([utterance(draft, draft, { transcriptId: "t1" })]);

    expect(
      swap(draft, rec, "t1", [{ description: "the input bar component", path: "src/InputBar.tsx" }])
    ).toBe("The input bar component needs work; @src/InputBar.tsx.");
  });

  it("leaves a description that no command introduces", () => {
    const draft = "At the top of the input bar file, link to the router.";
    const rec = record([utterance(draft, draft, { transcriptId: "t1" })]);

    expect(
      planFileReferenceEdits(
        rec,
        "t1",
        [{ description: "input bar file", path: "src/InputBar.tsx" }],
        draft
      )
    ).toEqual([]);
  });

  it("matches each command form case-insensitively and across spacing differences", () => {
    const draft = "Check At-File the Input  Bar, then insert file router and add file  store";
    const rec = record([utterance(draft, draft, { transcriptId: "t1" })]);

    expect(
      swap(draft, rec, "t1", [
        { description: "input bar", path: "src/InputBar.tsx" },
        { description: "router", path: "router.ts" },
        { description: "store", path: "store.ts" },
      ])
    ).toBe("Check @src/InputBar.tsx, then @router.ts and @store.ts");
  });

  it("never matches a description that is only the start of a longer word", () => {
    const draft = "link to the barista";
    const rec = record([utterance(draft, draft, { transcriptId: "t1" })]);

    expect(
      planFileReferenceEdits(rec, "t1", [{ description: "bar", path: "bar.ts" }], draft)
    ).toEqual([]);
  });

  it("never matches a command that ends a longer word", () => {
    const draft = "unlink to the router";
    const rec = record([utterance(draft, draft, { transcriptId: "t1" })]);

    expect(
      planFileReferenceEdits(rec, "t1", [{ description: "router", path: "router.ts" }], draft)
    ).toEqual([]);
  });

  it("keeps a missed reference's words from a shorter hit that prefixes it", () => {
    const draft = "Link to the router tests, then link to the router.";
    const rec = record([utterance(draft, draft, { transcriptId: "t1" })]);

    expect(
      swap(draft, rec, "t1", [
        { description: "router tests", path: null },
        { description: "router", path: "src/router.ts" },
      ])
    ).toBe("Link to the router tests, then @src/router.ts.");
  });

  it("places references the detector listed out of spoken order", () => {
    const draft = "link to router and link to store";
    const rec = record([utterance(draft, draft, { transcriptId: "t1" })]);

    expect(
      swap(draft, rec, "t1", [
        { description: "store", path: "store.ts" },
        { description: "router", path: "router.ts" },
      ])
    ).toBe("@router.ts and @store.ts");
  });

  it("lets a longer description claim its command before a shorter one listed first", () => {
    const draft = "link to the router tests and link to the router";
    const rec = record([utterance(draft, draft, { transcriptId: "t1" })]);

    expect(
      swap(draft, rec, "t1", [
        { description: "router", path: "router.ts" },
        { description: "router tests", path: "router.test.ts" },
      ])
    ).toBe("@router.test.ts and @router.ts");
  });

  it("ranks descriptions by the words naming the file, not a leading article", () => {
    const draft = "Link to the router UI, then link to the router.";
    const rec = record([utterance(draft, draft, { transcriptId: "t1" })]);

    expect(
      swap(draft, rec, "t1", [
        { description: "the router", path: "router.ts" },
        { description: "router UI", path: "RouterUI.tsx" },
      ])
    ).toBe("@RouterUI.tsx, then @router.ts.");
  });

  it("places repeated references in spoken order, each after the last", () => {
    const draft = "link to auth then link to auth";
    const rec = record([utterance(draft, draft, { transcriptId: "t1" })]);

    expect(
      swap(draft, rec, "t1", [
        { description: "auth", path: "auth.ts" },
        { description: "auth", path: "auth/index.ts" },
      ])
    ).toBe("@auth.ts then @auth/index.ts");
  });

  it("searches every utterance a split transcript produced", () => {
    const draft = "First line\nlink to the router";
    const rec = record([
      utterance(draft, "First line", { transcriptId: "t1" }),
      utterance(draft, "link to the router", { transcriptId: "t1" }),
    ]);

    expect(swap(draft, rec, "t1", [{ description: "router", path: "router.ts" }])).toBe(
      "First line\n@router.ts"
    );
  });

  it("leaves another transcript's words alone", () => {
    const draft = "link to the router. link to the router.";
    const rec = record([
      utterance(draft, "link to the router.", { transcriptId: "t1" }),
      utterance(draft, "link to the router.", { transcriptId: "t2", after: 10 }),
    ]);

    expect(swap(draft, rec, "t2", [{ description: "router", path: "router.ts" }])).toBe(
      "link to the router. @router.ts."
    );
  });

  it("leaves words the user has edited since", () => {
    const draft = "link to the router";
    const rec = record([utterance(draft, draft, { transcriptId: "t1", edited: true })]);

    expect(
      planFileReferenceEdits(rec, "t1", [{ description: "router", path: "router.ts" }], draft)
    ).toEqual([]);
  });

  it("skips a description it can't find but still places the rest", () => {
    const draft = "link to the router and link to the store";
    const rec = record([utterance(draft, draft, { transcriptId: "t1" })]);

    expect(
      swap(draft, rec, "t1", [
        { description: "the old API", path: "api.ts" },
        { description: "the store", path: "store.ts" },
      ])
    ).toBe("link to the router and @store.ts");
  });

  it("treats regex metacharacters in a description literally", () => {
    const draft = "link to config (dev) and link to config dev";
    const rec = record([utterance(draft, draft, { transcriptId: "t1" })]);

    expect(swap(draft, rec, "t1", [{ description: "config (dev)", path: "config.dev.ts" }])).toBe(
      "@config.dev.ts and link to config dev"
    );
  });

  it("quotes a path the token grammar needs quoted", () => {
    const draft = "link to the notes";
    const rec = record([utterance(draft, draft, { transcriptId: "t1" })]);

    expect(swap(draft, rec, "t1", [{ description: "notes", path: "docs/my notes.md" }])).toBe(
      '@"docs/my notes.md"'
    );
  });
});
