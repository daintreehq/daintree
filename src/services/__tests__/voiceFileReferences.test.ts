import { describe, expect, it } from "vitest";
import type { DictationRecord, DictationUtterance } from "@/store/dictationRangeStore";
import { collectHeardAsRules, createHeardAsRewriter } from "@shared/utils/voiceHeardAs";
import { planFileReferenceEdits, planHeardSwaps } from "../voiceFileReferences";

function utterance(
  draft: string,
  words: string,
  options: { transcriptId?: string; edited?: boolean; after?: number; heard?: string } = {}
): DictationUtterance {
  const from = draft.indexOf(words, options.after ?? 0);
  if (from < 0) throw new Error(`"${words}" not in draft`);
  const to = from + words.length;
  return {
    id: `u-${from}`,
    range: { from, to, edited: options.edited ?? false },
    insertion: { from, to, edited: false },
    ...(options.transcriptId ? { transcriptId: options.transcriptId } : {}),
    ...(options.heard !== undefined ? { heard: options.heard } : {}),
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
    breaks: [],
  };
}

function swap(
  draft: string,
  rec: DictationRecord,
  utteranceId: string,
  references: Array<{ description: string; path: string | null }>
): string {
  return planFileReferenceEdits(rec, utteranceId, references, draft).reduceRight(
    (next, edit) => next.slice(0, edit.from) + edit.text + next.slice(edit.to),
    draft
  );
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

describe("planHeardSwaps", () => {
  const rules = (...pairs: Array<[term: string, heard: string]>) =>
    createHeardAsRewriter(
      collectHeardAsRules(
        pairs.map(([term, heard]) => ({
          term,
          heardAs: [heard],
          source: "manual" as const,
          addedAt: 0,
        }))
      )
    );
  // An utterance the way it lands: the rules' text in the draft, the words as
  // heard kept beside it.
  const heardAs = (rewrite: ReturnType<typeof rules>, heard: string, prefix = "") => {
    const draft = prefix + rewrite(heard);
    return {
      draft,
      rec: record([utterance(draft, rewrite(heard), { transcriptId: "t1", heard })]),
    };
  };
  const plan = (
    rec: DictationRecord,
    draft: string,
    references: Array<{ description: string; path: string | null }>,
    rewrite: ReturnType<typeof rules> | null
  ) => planHeardSwaps(rec, planFileReferenceEdits(rec, "t1", references, draft), draft, rewrite);
  const router = [{ description: "router", path: "src/router.ts" }];

  it("makes the swap in the words as heard, past the words a rule rewrote", () => {
    const rewrite = rules(["Zustand", "zoo stand"]);
    const { draft, rec } = heardAs(rewrite, "zoo stand needs link to the router now");

    expect(plan(rec, draft, router, rewrite)).toEqual(
      new Map([[rec.utterances[0]!.id, [{ from: 16, to: 34, text: "@src/router.ts" }]]])
    );
  });

  it("places the swap on the command it replaced, not on one that reads alike", () => {
    // "router" is written "route handler", and "rooter" is written "router".
    const rewrite = rules(["route handler", "router"], ["router", "rooter"]);
    const { draft, rec } = heardAs(rewrite, "link to router and link to rooter");
    const references = [
      { description: "route handler", path: null },
      { description: "router", path: "src/router.ts" },
    ];

    expect(draft).toBe("link to route handler and link to router");
    expect(plan(rec, draft, references, rewrite)).toEqual(
      new Map([[rec.utterances[0]!.id, [{ from: 19, to: 33, text: "@src/router.ts" }]]])
    );
  });

  it("covers every word a rule wrote into the command as heard", () => {
    const rewrite = rules(["React Native", "react"]);
    const { draft, rec } = heardAs(rewrite, "fix react and link to react");
    const references = [{ description: "React Native", path: "src/native.ts" }];

    expect(plan(rec, draft, references, rewrite)).toEqual(
      new Map([[rec.utterances[0]!.id, [{ from: 14, to: 27, text: "@src/native.ts" }]]])
    );
  });

  it("makes no swap once the rules no longer give the words that landed", () => {
    const rewrite = rules(["Zustand", "zoo stand"]);
    const { draft, rec } = heardAs(rewrite, "zoo stand needs link to the router now");

    expect(plan(rec, draft, router, rules(["Zustand", "zoo"]))).toEqual(new Map());
    expect(plan(rec, draft, router, null)).toEqual(new Map());
  });

  it("makes no swap where a rewrite cuts through the command", () => {
    // The command ends inside "router tests", which a rule wrote for "rooter".
    const rewrite = rules(["router tests", "rooter"]);
    const { draft, rec } = heardAs(rewrite, "link to the rooter");

    expect(planFileReferenceEdits(rec, "t1", router, draft)).toHaveLength(1);
    expect(plan(rec, draft, router, rewrite)).toEqual(new Map());
  });

  it("skips utterances with no heard words or no swap", () => {
    const rewrite = rules(["Zustand", "zoo stand"]);
    const draft = "link to the router. Zustand time";
    const rec = record([
      utterance(draft, "link to the router.", { transcriptId: "t1" }),
      utterance(draft, "Zustand time", { transcriptId: "t1", heard: "zoo stand time" }),
    ]);

    expect(plan(rec, draft, router, rewrite)).toEqual(new Map());
  });
});
