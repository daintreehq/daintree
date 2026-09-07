import { describe, expect, it } from "vitest";
import type { HunkTokens } from "react-diff-view";
import { gradeTokens, hunksFor } from "../scenarios/diffTokenize";

/**
 * Does PERF-160..163's token oracle react?
 *
 * It replaced `result.tokens !== null`, which was not an oracle: the tokenizer
 * catches its own errors and returns null for a real failure, so an
 * implementation that skipped parsing and highlighting but returned SOMETHING
 * came back truthy and posted a much faster number at zero misses.
 *
 * Each test below feeds the grader a tree corresponding to one way of doing
 * less work, and asserts the term for that operation moves. The sparse-array
 * case is the important one — it is what a reviewer proposed as the way to
 * defeat the line-count and highlight terms, and the content term is the answer.
 */

const HUNKS = hunksFor({ path: "src/x.ts", changedLines: 40, seed: 7 }).hunks;

/** What the generator plants in a TypeScript file, per the corpus declaration. */
const RESERVED = ["const", "return"] as const;

/** One text node per line at its absolute index — a faithful tree, no highlighting. */
function plainTokens(): HunkTokens {
  const old: unknown[][] = [];
  const now: unknown[][] = [];
  for (const change of HUNKS.flatMap((hunk) => hunk.changes)) {
    const record = change as {
      oldLineNumber?: number;
      newLineNumber?: number;
      lineNumber?: number;
      content?: string;
    };
    const node = [{ type: "text", value: record.content ?? "" }];
    if (change.type !== "insert") old[(record.oldLineNumber ?? record.lineNumber ?? 1) - 1] = node;
    if (change.type !== "delete") now[(record.newLineNumber ?? record.lineNumber ?? 1) - 1] = node;
  }
  return { old, new: now } as unknown as HunkTokens;
}

/**
 * The same tree with grammar-shaped output: several categorised tokens per
 * line, across several categories.
 *
 * Two earlier versions of this helper were themselves the fake the oracle now
 * rejects — first a token appended beside the line (which broke the content
 * term, because it added text the source did not have), then one span wrapped
 * around the whole line (exactly the non-syntactic wrapper the term exists to
 * catch). A fixture that canonises the fake is worse than no fixture: it makes
 * a weak oracle look proven.
 *
 * Tokens wrap lexemes and the gaps ride beside them, so `lineText` still
 * reconstructs the source exactly.
 */
function realTokens(): HunkTokens {
  const plain = plainTokens() as unknown as { old: unknown[][]; new: unknown[][] };
  // The category is chosen FROM the content, the way a lexer chooses it — a
  // fixture that cycled names regardless of text would be the very fake the
  // category contract exists to reject, and would fail its own oracle.
  // Reserved words only, the way a lexer decides it — the fixture knows which
  // words it planted as identifiers and must not call them keywords, or it
  // would be the character classifier the oracle exists to reject and would
  // fail its own grading.
  const RESERVED = new Set(["const", "return"]);
  const categoryFor = (piece: string): string => {
    if (/^[0-9]+$/.test(piece)) return "number";
    if (!/[A-Za-z0-9]/.test(piece)) return "punctuation";
    return RESERVED.has(piece) ? "keyword" : "function";
  };
  const grammar = (line: unknown[] | undefined) => {
    if (line === undefined) return undefined;
    const text = String((line[0] as { value?: string })?.value ?? "");
    const out: unknown[] = [];
    // Quoted literals first and whole, the way a lexer emits them — the fixture
    // has to satisfy its own oracle, and splitting a literal into three would
    // make it the very fake `tokenStringMisses` exists to reject.
    for (const piece of text.split(/("[^"]*")|(\s+)|([^\w\s]+)/).filter(Boolean)) {
      if (/^"[^"]*"$/.test(piece)) {
        out.push({
          type: "element",
          tagName: "span",
          properties: { className: ["token", "string"] },
          children: [{ type: "text", value: piece }],
        });
        continue;
      }
      if (/^\s+$/.test(piece)) {
        out.push({ type: "text", value: piece });
        continue;
      }
      out.push({
        type: "element",
        tagName: "span",
        properties: { className: ["token", categoryFor(piece)] },
        children: [{ type: "text", value: piece }],
      });
    }
    return out;
  };
  return {
    old: plain.old.map(grammar),
    new: plain.new.map(grammar),
  } as unknown as HunkTokens;
}

/** Every line wrapped whole in a bare `["token"]` span — shape without grammar. */
function wholeLineWrapped(): HunkTokens {
  return wrapEachLine(["token"]);
}

/** Every line wrapped whole in a CATEGORISED span — one token, one category. */
function wholeLineCategorised(): HunkTokens {
  return wrapEachLine(["token", "keyword"]);
}

function wrapEachLine(className: string[]): HunkTokens {
  const plain = plainTokens() as unknown as { old: unknown[][]; new: unknown[][] };
  const wrap = (line: unknown[] | undefined) =>
    line === undefined
      ? undefined
      : [{ type: "element", tagName: "span", properties: { className }, children: line }];
  return { old: plain.old.map(wrap), new: plain.new.map(wrap) } as unknown as HunkTokens;
}

describe("diff token oracle", () => {
  it("scores a faithful tree at zero on every term", () => {
    expect(gradeTokens(realTokens(), HUNKS, "required", RESERVED)).toEqual({
      tokenLineMisses: 0,
      tokenContentMisses: 0,
      tokenHighlightMisses: 0,
      tokenCategoryMisses: 0,
      tokenLexicalMisses: 0,
      tokenStringMisses: 0,
    });
  });

  it("catches an empty tree", () => {
    const grade = gradeTokens(
      { old: [], new: [] } as unknown as HunkTokens,
      HUNKS,
      "required",
      RESERVED
    );
    expect(grade.tokenLineMisses).toBeGreaterThan(0);
    expect(grade.tokenContentMisses).toBeGreaterThan(0);
    // One per side: the highlight term is graded separately for `old` and
    // `new`, so a total failure reads as two rather than one.
    expect(grade.tokenHighlightMisses).toBe(2);
  });

  it("catches correctly-sized SPARSE arrays carrying one fabricated token", () => {
    // The defeat proposed for the other two terms: return arrays of exactly the
    // right length, drop every line's real content, and place one
    // `className: ["token"]` node anywhere. The line count still passes.
    const real = realTokens();
    const sparse = {
      old: new Array(real.old.length).fill(undefined),
      new: new Array(real.new.length).fill(undefined),
    } as unknown as HunkTokens;
    sparse.old[0] = [
      {
        type: "element",
        tagName: "span",
        properties: { className: ["token", "keyword"] },
        children: [{ type: "text", value: "const" }],
      },
    ] as never;

    const grade = gradeTokens(sparse, HUNKS, "required", RESERVED);
    expect(grade.tokenLineMisses).toBe(0);
    // Both of the other terms see it: the content is gone, and one highlighted
    // line out of hundreds is not a tokenizer that highlighted the file.
    expect(grade.tokenContentMisses).toBeGreaterThan(0);
    expect(grade.tokenHighlightMisses).toBe(2);
  });

  it("catches a faithful tree with a single planted token element", () => {
    // Every line's content preserved exactly, so the content and line terms
    // pass, plus one categorised token to satisfy a yes/no highlight check.
    // Requiring a SHARE of lines is what separates a grammar from a plant.
    const planted = plainTokens() as unknown as { old: unknown[][]; new: unknown[][] };
    planted.old[0] = [
      {
        type: "element",
        tagName: "span",
        properties: { className: ["token", "keyword"] },
        children: planted.old[0] ?? [],
      },
    ];

    const grade = gradeTokens(planted as unknown as HunkTokens, HUNKS, "required", RESERVED);
    expect(grade.tokenContentMisses).toBe(0);
    expect(grade.tokenLineMisses).toBe(0);
    // Both sides fall short — one planted line is not half of either.
    expect(grade.tokenHighlightMisses).toBe(2);
  });

  it("rejects whole-line spans, categorised or not", () => {
    // The cheapest convincing fakes: wrap every line in one span. Content and
    // line counts are perfect and no grammar ran. Naming a category does not
    // save it — a real grammar emits 5.9-12.5 tokens per line across 4-6
    // categories, a wrapper emits exactly one of each, which is why the term
    // measures the SHAPE of the output rather than any single node's classes.
    for (const tree of [wholeLineWrapped(), wholeLineCategorised()]) {
      const grade = gradeTokens(tree, HUNKS, "required", RESERVED);
      expect(grade.tokenContentMisses).toBe(0);
      expect(grade.tokenLineMisses).toBe(0);
      expect(grade.tokenHighlightMisses).toBe(2);
    }
  });

  it("rejects a second class name that names no category", () => {
    // `["token", "token"]` satisfies "the className has more than one entry"
    // while naming nothing, which is why the category set excludes "token".
    const grade = gradeTokens(wrapEachLine(["token", "token"]), HUNKS, "required", RESERVED);
    expect(grade.tokenHighlightMisses).toBe(2);
  });

  it("rejects one categorised lexeme per line", () => {
    // Wrapping each line's first word as a keyword passes any per-line share
    // test and any second-class-name test. It is one token and one category per
    // line, so it fails both floors.
    const plain = plainTokens() as unknown as { old: unknown[][]; new: unknown[][] };
    const firstWordOnly = (line: unknown[] | undefined) => {
      if (line === undefined) return undefined;
      const text = String((line[0] as { value?: string })?.value ?? "");
      const match = /^(\s*)(\S+)([\s\S]*)$/.exec(text);
      if (!match) return line;
      const [, lead, lexeme, rest] = match;
      return [
        { type: "text", value: lead },
        {
          type: "element",
          tagName: "span",
          properties: { className: ["token", "keyword"] },
          children: [{ type: "text", value: lexeme }],
        },
        { type: "text", value: rest },
      ];
    };
    const tree = {
      old: plain.old.map(firstWordOnly),
      new: plain.new.map(firstWordOnly),
    } as unknown as HunkTokens;

    const grade = gradeTokens(tree, HUNKS, "required", RESERVED);
    expect(grade.tokenContentMisses).toBe(0);
    expect(grade.tokenLineMisses).toBe(0);
    expect(grade.tokenHighlightMisses).toBe(2);
  });

  it("rejects tokens that span only whitespace", () => {
    const plain = plainTokens() as unknown as { old: unknown[][]; new: unknown[][] };
    const hollow = (line: unknown[] | undefined) =>
      line === undefined
        ? undefined
        : [
            {
              type: "element",
              tagName: "span",
              properties: { className: ["token", "keyword"] },
              children: [{ type: "text", value: "" }],
            },
            ...line,
          ];
    const tree = { old: plain.old.map(hollow), new: plain.new.map(hollow) };
    expect(
      gradeTokens(tree as unknown as HunkTokens, HUNKS, "required", RESERVED).tokenHighlightMisses
    ).toBe(2);
  });

  it("grades each side separately, so one good side cannot carry the other", () => {
    // Pooling old and new would let a tree that highlighted `old` perfectly and
    // `new` not at all average its way to a pass.
    const real = realTokens() as unknown as { old: unknown[][] };
    const plain = plainTokens() as unknown as { new: unknown[][] };
    const lopsided = { old: real.old, new: plain.new } as unknown as HunkTokens;
    expect(gradeTokens(lopsided, HUNKS, "required", RESERVED).tokenHighlightMisses).toBe(1);
  });

  it("catches a plaintext passthrough that kept every line", () => {
    const grade = gradeTokens(plainTokens(), HUNKS, "required", RESERVED);
    expect(grade.tokenContentMisses).toBe(0);
    expect(grade.tokenLineMisses).toBe(0);
    expect(grade.tokenHighlightMisses).toBe(2);
  });

  it("catches a per-character wrapper cycling category names", () => {
    // The reviewer's final objection, built exactly as described: wrap every
    // non-whitespace CHARACTER in a categorised token, cycling the names. It
    // preserves the source, so content passes; it is dense and diverse, so both
    // floors pass. Nothing parsed anything.
    //
    // It fails because a lexer assigns categories BY CONTENT and a wrapper
    // cannot: this one labels `const` an operator and `(` a keyword. Measured
    // over the real corpus the tokenizer commits zero such violations and this
    // wrapper commits 56%.
    const categories = ["keyword", "operator", "number"];
    const plain = plainTokens() as unknown as { old: unknown[][]; new: unknown[][] };
    let index = 0;
    const perCharacter = (line: unknown[] | undefined) => {
      if (line === undefined) return undefined;
      const text = String((line[0] as { value?: string })?.value ?? "");
      return [...text].map((character) =>
        /\s/.test(character)
          ? { type: "text", value: character }
          : {
              type: "element",
              tagName: "span",
              properties: { className: ["token", categories[index++ % categories.length]] },
              children: [{ type: "text", value: character }],
            }
      );
    };
    const tree = {
      old: plain.old.map(perCharacter),
      new: plain.new.map(perCharacter),
    } as unknown as HunkTokens;

    const grade = gradeTokens(tree, HUNKS, "required", RESERVED);
    // Everything the earlier terms measure looks perfect.
    expect(grade.tokenContentMisses).toBe(0);
    expect(grade.tokenLineMisses).toBe(0);
    expect(grade.tokenHighlightMisses).toBe(0);
    // And the category contract sees straight through it.
    expect(grade.tokenCategoryMisses).toBeGreaterThan(100);
  });

  it("catches a wrapper that dodges the contracted categories entirely", () => {
    // The obvious counter to the contract: cycle only category names nothing
    // checks. Three of those satisfy the diversity floor. Requiring the output
    // to actually USE the universal vocabulary is what forces a fake back onto
    // ground where its content betrays it.
    const categories = ["function", "selector", "property"];
    const plain = plainTokens() as unknown as { old: unknown[][]; new: unknown[][] };
    let index = 0;
    const uncontracted = (line: unknown[] | undefined) => {
      if (line === undefined) return undefined;
      const text = String((line[0] as { value?: string })?.value ?? "");
      return text.split(/(\s+)/).map((piece) =>
        /^\s*$/.test(piece)
          ? { type: "text", value: piece }
          : {
              type: "element",
              tagName: "span",
              properties: { className: ["token", categories[index++ % categories.length]] },
              children: [{ type: "text", value: piece }],
            }
      );
    };
    const tree = {
      old: plain.old.map(uncontracted),
      new: plain.new.map(uncontracted),
    } as unknown as HunkTokens;

    const grade = gradeTokens(tree, HUNKS, "required", RESERVED);
    expect(grade.tokenContentMisses).toBe(0);
    expect(grade.tokenHighlightMisses).toBe(0);
    // No violations — it never used a contracted name — but no coverage either,
    // which is one miss per side.
    expect(grade.tokenCategoryMisses).toBe(2);
  });

  it("does not grade categories where the fixture declines to assert", () => {
    // Markdown produces no tokens over this corpus, so the contract must not
    // manufacture a coverage miss for it.
    expect(gradeTokens(plainTokens(), HUNKS, "unchecked", RESERVED).tokenCategoryMisses).toBe(0);
    expect(gradeTokens(realTokens(), HUNKS, "unchecked", RESERVED).tokenCategoryMisses).toBe(0);
  });

  it("catches a grammar-free character classifier", () => {
    // The reviewer's final construction, and the strongest fake anyone produced:
    // classify by character class — digit becomes `number`, letter run becomes
    // `keyword`, everything else becomes `punctuation`. It preserves the source
    // exactly, it is dense, it names three categories, and every category is
    // consistent with its own text. It clears line count, content, density,
    // diversity AND the category contracts.
    //
    // It cannot tell a reserved word from an identifier, because nothing about
    // their characters says which is which. The real tokenizer labels exactly
    // `const` and `return`; this labels `compute`, `aggregate`, `retries` and
    // `backoff` too.
    const plain = plainTokens() as unknown as { old: unknown[][]; new: unknown[][] };
    const classify = (line: unknown[] | undefined) => {
      if (line === undefined) return undefined;
      const text = String((line[0] as { value?: string })?.value ?? "");
      return text
        .split(/(\s+)|([A-Za-z_$][\w$]*)|([0-9]+)/)
        .filter(Boolean)
        .map((piece) => {
          if (/^\s+$/.test(piece)) return { type: "text", value: piece };
          const category = /^[0-9]+$/.test(piece)
            ? "number"
            : /[A-Za-z]/.test(piece)
              ? "keyword"
              : "punctuation";
          return {
            type: "element",
            tagName: "span",
            properties: { className: ["token", category] },
            children: [{ type: "text", value: piece }],
          };
        });
    };
    const tree = {
      old: plain.old.map(classify),
      new: plain.new.map(classify),
    } as unknown as HunkTokens;

    const grade = gradeTokens(tree, HUNKS, "required", RESERVED);
    // Everything the other four terms measure looks perfect.
    expect(grade.tokenContentMisses).toBe(0);
    expect(grade.tokenLineMisses).toBe(0);
    expect(grade.tokenHighlightMisses).toBe(0);
    expect(grade.tokenCategoryMisses).toBe(0);
    // And lexical discrimination sees straight through it.
    expect(grade.tokenLexicalMisses).toBeGreaterThan(100);
  });

  it("grades lexical discrimination even where highlighting is unchecked", () => {
    // A file the fixture declines to assert highlighting for may still not
    // rename the fixture's own identifiers into keywords.
    const plain = plainTokens() as unknown as { old: unknown[][]; new: unknown[][] };
    const asKeyword = (line: unknown[] | undefined) => {
      if (line === undefined) return undefined;
      const text = String((line[0] as { value?: string })?.value ?? "");
      // Split on identifier boundaries, not whitespace: the corpus writes
      // `compute(1,` as one whitespace-delimited chunk, so a whitespace split
      // would never produce a bare identifier to mislabel.
      return text
        .split(/(\s+)|([A-Za-z_$][\w$]*)/)
        .filter(Boolean)
        .map((piece) =>
          /^\s+$/.test(piece)
            ? { type: "text", value: piece }
            : {
                type: "element",
                tagName: "span",
                properties: { className: ["token", "keyword"] },
                children: [{ type: "text", value: piece }],
              }
        );
    };
    const tree = {
      old: plain.old.map(asKeyword),
      new: plain.new.map(asKeyword),
    } as unknown as HunkTokens;

    expect(gradeTokens(tree, HUNKS, "unchecked", RESERVED).tokenLexicalMisses).toBeGreaterThan(0);
  });

  it("catches a classifier that calls every word run a non-keyword", () => {
    // The last construction standing, and the reason the lexical term needs
    // BOTH directions. Classify every word run — `const` and `return`
    // included — as `function`, digits as `number`, everything else as
    // `punctuation`. It mislabels no identifier, so a false-positive check
    // alone waves it through, and it clears all four other terms.
    //
    // It fails because the fixture knows it wrote `const` and `return`, and a
    // grammar for this language has to recognise them.
    const plain = plainTokens() as unknown as { old: unknown[][]; new: unknown[][] };
    const classify = (line: unknown[] | undefined) => {
      if (line === undefined) return undefined;
      const text = String((line[0] as { value?: string })?.value ?? "");
      return text
        .split(/(\s+)|([A-Za-z_$][\w$]*)|([0-9]+)/)
        .filter(Boolean)
        .map((piece) => {
          if (/^\s+$/.test(piece)) return { type: "text", value: piece };
          const category = /^[0-9]+$/.test(piece)
            ? "number"
            : /[A-Za-z]/.test(piece)
              ? "function"
              : "punctuation";
          return {
            type: "element",
            tagName: "span",
            properties: { className: ["token", category] },
            children: [{ type: "text", value: piece }],
          };
        });
    };
    const tree = {
      old: plain.old.map(classify),
      new: plain.new.map(classify),
    } as unknown as HunkTokens;

    const grade = gradeTokens(tree, HUNKS, "required", RESERVED);
    expect(grade.tokenContentMisses).toBe(0);
    expect(grade.tokenLineMisses).toBe(0);
    expect(grade.tokenHighlightMisses).toBe(0);
    expect(grade.tokenCategoryMisses).toBe(0);
    // Every planted `const` and `return` went unrecognised.
    expect(grade.tokenLexicalMisses).toBeGreaterThan(20);
  });

  it("does not require keywords of a language that has none", () => {
    // JSON and CSS see `const` and `return` as ordinary text, correctly, so
    // they declare no reserved words and the term must not manufacture misses.
    const grade = gradeTokens(realTokens(), HUNKS, "required", []);
    expect(grade.tokenLexicalMisses).toBe(0);
  });

  it("catches a spelling-based classifier that knows the keywords", () => {
    // The last construction a reviewer produced: hardcode the reserved words,
    // classify every other word `function`, digits `number`, everything else
    // `punctuation`. It satisfies line count, content, density, diversity,
    // category consistency AND lexical discrimination in both directions,
    // because it has been handed the keyword table.
    //
    // It cannot produce `"expo"` as one token. The quotes are non-alphanumeric,
    // so a character-class rule calls them punctuation and splits the literal
    // into three. Emitting it whole requires recognising an opening quote and
    // suppressing every other rule until the closing one — a mode carried
    // across characters, which is what tokenizing is.
    const plain = plainTokens() as unknown as { old: unknown[][]; new: unknown[][] };
    const reserved = new Set<string>(RESERVED);
    const classify = (line: unknown[] | undefined) => {
      if (line === undefined) return undefined;
      const text = String((line[0] as { value?: string })?.value ?? "");
      return text
        .split(/(\s+)|([A-Za-z_$][\w$]*)|([0-9]+)/)
        .filter(Boolean)
        .map((piece) => {
          if (/^\s+$/.test(piece)) return { type: "text", value: piece };
          const category = reserved.has(piece)
            ? "keyword"
            : /^[0-9]+$/.test(piece)
              ? "number"
              : /[A-Za-z]/.test(piece)
                ? "function"
                : "punctuation";
          return {
            type: "element",
            tagName: "span",
            properties: { className: ["token", category] },
            children: [{ type: "text", value: piece }],
          };
        });
    };
    const tree = {
      old: plain.old.map(classify),
      new: plain.new.map(classify),
    } as unknown as HunkTokens;

    const grade = gradeTokens(tree, HUNKS, "required", RESERVED);
    // Every earlier term is satisfied — this fake has been given everything
    // spelling alone can carry.
    expect(grade.tokenContentMisses).toBe(0);
    expect(grade.tokenLineMisses).toBe(0);
    expect(grade.tokenHighlightMisses).toBe(0);
    expect(grade.tokenCategoryMisses).toBe(0);
    expect(grade.tokenLexicalMisses).toBe(0);
    // And it cannot pair a quote.
    expect(grade.tokenStringMisses).toBeGreaterThan(0);
  });

  it("does not require string tokens where highlighting is unchecked", () => {
    // Markdown produces no string tokens over this corpus and declares nothing.
    expect(gradeTokens(plainTokens(), HUNKS, "unchecked", []).tokenStringMisses).toBe(0);
  });

  it("catches a tree whose lines are shifted by one", () => {
    // An off-by-one in absolute-line indexing would mis-position every
    // highlight in the UI while the tree looks structurally plausible.
    const real = realTokens();
    const shifted = { old: [undefined, ...real.old], new: real.new } as unknown as HunkTokens;
    const grade = gradeTokens(shifted, HUNKS, "required", RESERVED);
    expect(grade.tokenContentMisses).toBeGreaterThan(0);
    expect(grade.tokenLineMisses).toBe(1);
  });

  it("declines to assert highlighting where the fixture says unchecked", () => {
    // "unchecked" means the fixture does not know, not that tokens are
    // forbidden — the content and line terms still grade the file either way,
    // so an unchecked entry cannot be served by an implementation doing nothing.
    expect(gradeTokens(plainTokens(), HUNKS, "unchecked", RESERVED).tokenHighlightMisses).toBe(0);
    expect(gradeTokens(realTokens(), HUNKS, "unchecked", RESERVED).tokenHighlightMisses).toBe(0);
    expect(gradeTokens(plainTokens(), HUNKS, "unchecked", RESERVED).tokenContentMisses).toBe(0);
    const empty = { old: [], new: [] } as unknown as HunkTokens;
    expect(gradeTokens(empty, HUNKS, "unchecked", RESERVED).tokenContentMisses).toBeGreaterThan(0);
  });

  it("charges a null tree once, through tokenizeMisses alone", () => {
    // Otherwise one failure is reported hundreds of times over and the real
    // first cause is buried.
    expect(gradeTokens(null, HUNKS, "required", RESERVED)).toEqual({
      tokenLineMisses: 0,
      tokenContentMisses: 0,
      tokenHighlightMisses: 0,
      tokenCategoryMisses: 0,
      tokenLexicalMisses: 0,
      tokenStringMisses: 0,
    });
  });
});
