import { describe, it, expect } from "vitest";
import {
  appendFileReference,
  matchesInsertFileReferenceCombo,
  INSERT_FILE_REFERENCE_COMBO,
} from "../fileReference";
import { getAllAtFileTokens } from "@/components/Terminal/hybridInputParsing";

describe("appendFileReference", () => {
  it("produces a token the hybrid input's own parser recognizes", () => {
    // The whole point of reusing formatAtFileToken is that the draft the file
    // browser writes chips exactly like a drag/drop would.
    const draft = appendFileReference("", "/repo/src/index.ts");
    const tokens = getAllAtFileTokens(draft);
    expect(tokens).toHaveLength(1);
    expect(draft.slice(tokens[0]!.start, tokens[0]!.end)).toBe("@/repo/src/index.ts");
  });

  it("round-trips a path containing spaces through the parser", () => {
    const draft = appendFileReference("", "/repo/my notes/todo.md");
    const tokens = getAllAtFileTokens(draft);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.path).toBe("/repo/my notes/todo.md");
  });

  it("separates the token from a draft that ends mid-word", () => {
    const draft = appendFileReference("review", "/repo/a.ts");
    expect(draft).toBe("review @/repo/a.ts ");
  });

  it("leaves the user's own trailing whitespace alone", () => {
    // Normalizing it would silently rewrite spacing the user typed.
    const draft = appendFileReference("review  ", "/repo/a.ts");
    expect(draft).toBe("review  @/repo/a.ts ");
    expect(getAllAtFileTokens(draft)).toHaveLength(1);
  });

  it("adds no leading separator to an empty draft", () => {
    expect(appendFileReference("", "/repo/a.ts").startsWith("@")).toBe(true);
  });

  it("ends with a space so the next reference cannot fuse onto it", () => {
    const once = appendFileReference("", "/repo/a.ts");
    const twice = appendFileReference(once, "/repo/b.ts");
    expect(getAllAtFileTokens(twice).map((t) => t.path)).toEqual(["/repo/a.ts", "/repo/b.ts"]);
  });

  it("keeps a repeated path as two distinct references", () => {
    // Deduping would diverge from drag/drop and make a second Cmd+I look broken.
    const twice = appendFileReference(appendFileReference("", "/repo/a.ts"), "/repo/a.ts");
    expect(getAllAtFileTokens(twice)).toHaveLength(2);
  });
});

describe("matchesInsertFileReferenceCombo", () => {
  // The matcher takes the modifier fields it reads, not a whole KeyboardEvent,
  // so the fixture needs no cast.
  type ComboEvent = Parameters<typeof matchesInsertFileReferenceCombo>[0];
  const event = (over: Partial<ComboEvent>): ComboEvent => ({
    key: "i",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  });

  it("matches the platform's primary modifier and rejects the other one", () => {
    expect(matchesInsertFileReferenceCombo(event({ metaKey: true }), true)).toBe(true);
    expect(matchesInsertFileReferenceCombo(event({ ctrlKey: true }), true)).toBe(false);
    expect(matchesInsertFileReferenceCombo(event({ ctrlKey: true }), false)).toBe(true);
    expect(matchesInsertFileReferenceCombo(event({ metaKey: true }), false)).toBe(false);
  });

  it("rejects the bare letter, so tree typeahead stays available", () => {
    expect(matchesInsertFileReferenceCombo(event({}), true)).toBe(false);
    expect(matchesInsertFileReferenceCombo(event({}), false)).toBe(false);
  });

  it("rejects extra modifiers so Cmd+Shift+I still reaches terminal.inject", () => {
    expect(matchesInsertFileReferenceCombo(event({ metaKey: true, shiftKey: true }), true)).toBe(
      false
    );
    expect(matchesInsertFileReferenceCombo(event({ metaKey: true, altKey: true }), true)).toBe(
      false
    );
    expect(matchesInsertFileReferenceCombo(event({ ctrlKey: true, shiftKey: true }), false)).toBe(
      false
    );
  });

  it("matches regardless of the key's reported case", () => {
    expect(matchesInsertFileReferenceCombo(event({ key: "I", metaKey: true }), true)).toBe(true);
  });

  it("ignores unrelated keys", () => {
    expect(matchesInsertFileReferenceCombo(event({ key: "k", metaKey: true }), true)).toBe(false);
  });

  it("advertises the same combo the matcher accepts", () => {
    // A drifted constant would leave the menu hint and the aria attribute
    // describing a shortcut the tree no longer honours.
    const [modifier, key] = INSERT_FILE_REFERENCE_COMBO.split("+");
    expect(modifier).toBe("Cmd");
    expect(matchesInsertFileReferenceCombo(event({ key: key!, metaKey: true }), true)).toBe(true);
  });
});
