import { performance } from "node:perf_hooks";
import { parseDiff, type HunkData, type HunkTokens } from "react-diff-view";
import { armBystanderProbe, bystanderMetrics } from "../lib/bystander";
import type { PerfScenario } from "../types";
import {
  runDiffTokenize,
  MAX_INTRALINE_CHANGES,
} from "../../../src/components/Worktree/diffTokenizer";
import type {
  DiffTokenizeRequest,
  DiffTokenizeResult,
} from "../../../src/components/Worktree/diffTokenizer";
import { DiffTokenizeClient } from "../../../src/services/DiffTokenizeService";
import {
  createNodeDiffTokenizeWorker,
  requestSample,
} from "../lib/nodeDiffTokenizeWorkerTransport";

// Diff tokenization — the syntax-highlight + intra-line edit-marking pass that
// the review workspace runs for every file diff (runDiffTokenize, the one
// implementation the Web Worker and in-thread fallback both call, so this is
// the exact production path). Opening a review is a high-traffic surface; a
// tokenize that blows past a frame budget is felt as a blank/janky diff. These
// scenarios gate the tokenize cost at representative and pathological sizes and
// the multi-file open that a review workspace triggers.
//
// runDiffTokenize catches its own errors and returns tokens: null (a silent
// plaintext downgrade). A null pass is FASTER, so every scenario reports
// `tokenizeMisses` — files that came back without a token tree. It is emitted
// on every iteration, 0 when healthy, because a metric that only exists on the
// failure path cannot be read as a predicate: a run where tokenization died
// everywhere would report the same absent column as a run that never happened.
// This used to be a throw, which aborted the whole suite rather than reporting
// the number; the harness measures and only fails on apparatus breakage, and a
// silent plaintext downgrade is a result, not a broken apparatus. The fixture
// assertions below (is the diff actually over the intra-line budget?) stay
// throws — those ARE the apparatus.

interface DiffSpec {
  path: string;
  changedLines: number;
  seed: number;
}

// Emit a valid git unified diff with correctly-counted hunks. Each hunk is
// [context, paired -/+ change block, context]; a paired block of B lines is 2B
// "changed" lines (the metric shouldMarkIntraLineEdits counts). Line cursors
// advance per hunk so parseDiff sees non-overlapping, well-formed headers.
// changedLines is rounded UP to whole 2*PAIRS_PER_HUNK blocks.
function generateUnifiedDiff(spec: DiffSpec): string {
  const CONTEXT = 3;
  const PAIRS_PER_HUNK = 20; // 40 changed lines per hunk
  const hunkCount = Math.max(1, Math.ceil(spec.changedLines / (PAIRS_PER_HUNK * 2)));

  const lines: string[] = [
    `diff --git a/${spec.path} b/${spec.path}`,
    `index 1111111..2222222 100644`,
    `--- a/${spec.path}`,
    `+++ b/${spec.path}`,
  ];

  let oldCursor = 1;
  let newCursor = 1;
  for (let h = 0; h < hunkCount; h += 1) {
    const oldCount = CONTEXT + PAIRS_PER_HUNK + CONTEXT;
    const newCount = CONTEXT + PAIRS_PER_HUNK + CONTEXT;
    lines.push(`@@ -${oldCursor},${oldCount} +${newCursor},${newCount} @@`);

    for (let c = 0; c < CONTEXT; c += 1) {
      lines.push(`   const ctx_${h}_${c} = resolve(${h * 100 + c});`);
    }
    for (let b = 0; b < PAIRS_PER_HUNK; b += 1) {
      const n = spec.seed + h * 1000 + b;
      lines.push(`-  const value_${b} = legacyCompute(${n}, { retries: 3 });`);
    }
    for (let b = 0; b < PAIRS_PER_HUNK; b += 1) {
      const n = spec.seed + h * 1000 + b;
      lines.push(`+  const value_${b} = compute(${n}, { retries: 3, backoff: "expo" });`);
    }
    for (let c = 0; c < CONTEXT; c += 1) {
      lines.push(`   return aggregate(value_${c});`);
    }

    // Advance cursors past this hunk plus a gap so headers stay monotonic.
    oldCursor += oldCount + 8;
    newCursor += newCount + 8;
  }

  lines.push("");
  return lines.join("\n");
}

export function hunksFor(spec: DiffSpec): { hunks: HunkData[]; changedLines: number } {
  const files = parseDiff(generateUnifiedDiff(spec));
  const hunks = files[0]?.hunks ?? [];
  let changedLines = 0;
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "normal") changedLines += 1;
    }
  }
  return { hunks, changedLines };
}

/**
 * The multi-file review PERF-162 and PERF-163 both open.
 *
 * Shared rather than duplicated so the two never drift: PERF-163's number is
 * only readable beside PERF-162's, and a changeset that differed between them
 * would make the pair uninterpretable.
 */
const REVIEW_CHANGESET: ReadonlyArray<{
  spec: DiffSpec;
  language: string;
  /**
   * Whether this language is required to yield syntax tokens over THIS corpus.
   *
   * Declared by the fixture rather than read back from the tokenizer, which is
   * the difference between an oracle and a self-report. The generated diff is
   * code-shaped for every entry, so markdown correctly produces no tokens over
   * it today — and requiring them everywhere would make the predicate nonzero
   * on a perfectly healthy run, which always ends in weakening it until it
   * means nothing.
   *
   * `"unchecked"` rather than `false`, because "must not highlight" is not
   * something the fixture knows: a future grammar that tokenized this content
   * would not be a defect. The file is still graded — the line-count and
   * content terms apply to every entry — so an unchecked file cannot be served
   * by an implementation that does nothing.
   */
  syntaxTokens: SyntaxTokenExpectation;
  /**
   * Reserved words this entry's generated content contains, which its grammar
   * must recognise. Empty where the language has none — JSON and CSS see
   * `const` and `return` as ordinary text, correctly.
   */
  reservedWords: readonly string[];
}> = [
  {
    spec: { path: "src/a.ts", changedLines: 320, seed: 1 },
    language: "typescript",
    syntaxTokens: "required",
    reservedWords: ["const", "return"],
  },
  {
    spec: { path: "src/b.tsx", changedLines: 320, seed: 2 },
    language: "tsx",
    syntaxTokens: "required",
    reservedWords: ["const", "return"],
  },
  {
    spec: { path: "config/c.json", changedLines: 320, seed: 3 },
    language: "json",
    syntaxTokens: "required",
    reservedWords: [],
  },
  {
    spec: { path: "styles/d.css", changedLines: 320, seed: 4 },
    language: "css",
    syntaxTokens: "required",
    reservedWords: [],
  },
  {
    spec: { path: "docs/e.md", changedLines: 320, seed: 5 },
    language: "markdown",
    syntaxTokens: "unchecked",
    reservedWords: [],
  },
];

/**
 * Reserved words the generator plants in every TypeScript file it writes.
 *
 * PERF-160 and PERF-161 build their own single-file diffs rather than using
 * REVIEW_CHANGESET, and the generator emits `const` and `return` on every hunk,
 * so they carry the same declaration.
 */
const TYPESCRIPT_RESERVED = ["const", "return"] as const;

/** Roughly one frame. Below this the probe is measuring the probe. */
const PROBE_CADENCE_MS = 8;

/**
 * The idle calibration window, in milliseconds.
 *
 * Fixed rather than matched to the workload's own duration, and taken BEFORE
 * the workload rather than after it. Both choices were forced by measurement:
 * run afterwards, the calibration inherits the tokenizer's garbage collection
 * and reported 10-45ms of "idle" stall on an untouched loop, which put the
 * headline `excessLongestStallMs` anywhere between 8ms and 72ms across three
 * iterations of identical work. The workload's own GC is legitimately part of
 * what it costs the foreground and belongs in the load window; it does not
 * belong in the window that is supposed to describe the machine.
 *
 * Long enough to see a scheduler hiccup, short enough that it is not most of
 * the scenario's cost.
 */
const IDLE_CALIBRATION_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Hand the loop back so pending timers, including the probe's, can run.
 *
 * `setTimeout(0)` rather than a microtask OR `setImmediate`, and the difference
 * between the last two is the whole reason this is a named function. A resolved
 * promise is a microtask and never leaves the current phase at all. But
 * `setImmediate` lands in the CHECK phase, and an `await` continuation is a
 * microtask drained at the end of that callback — so the next file's
 * synchronous tokenize runs still inside the check phase, before the timer
 * phase gets another turn. The probe's pending ticks would then be at the mercy
 * of whatever the tokenizer happens to await internally, which makes the tick
 * count a property of an implementation detail rather than of the yield.
 *
 * `setTimeout(0)` is queued in the timers phase behind the probe's own pending
 * ticks, so every tick owed from the block that just finished is paid before
 * the next file starts. That is what makes the measured stall the cost of ONE
 * file. Node clamps it to 1ms, so five files cost ~5ms against a workload of
 * ~200ms.
 */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Grade what the tokenizer actually produced, against the fixture's own input.
 *
 * `result.tokens !== null` was the whole oracle here, and it is not one. The
 * tokenizer catches its own errors and returns `{ tokens: null }` for a genuine
 * failure — but an implementation returning an empty or plaintext tree for every
 * language would skip parsing, highlighting and edit marking, come back truthy,
 * and post a much faster number at zero misses. That is the "still doing most of
 * its work" shape the harness's own rule warns about: which operation inside the
 * timed bracket has no term in the predicate?
 *
 * Three terms, all read from the OUTPUT and compared against the parsed hunks:
 *
 * - `tokenLineMisses` — `HunkTokens.old` and `.new` are indexed by ABSOLUTE file
 *   line, not by change position, so each side's length must equal the highest
 *   line number that side touches.
 * - `tokenContentMisses` — the text of every changed line, reconstructed from
 *   its token nodes, must equal that line's source content. This is the term
 *   that closes the obvious hole in the other two: an implementation returning
 *   correctly-sized SPARSE arrays with one fabricated `className: ["token"]`
 *   node somewhere satisfies both of them and preserves none of the real
 *   output.
 * - `tokenHighlightMisses` — each side must carry at least two categorised
 *   tokens per source line across at least three distinct categories, where the
 *   fixture declares highlighting is expected. Graded per side, so one
 *   highlighted side cannot average its way past an unhighlighted one.
 * - `tokenCategoryMisses` — every token naming a universal category must carry
 *   text that category could describe, and enough of them must exist. This is
 *   consistent with the vocabulary a grammar produces: the real tokenizer is
 *   perfectly consistent over this corpus and a category-cycling wrapper is 56%
 *   inconsistent.
 * - `tokenLexicalMisses` — graded both ways: no identifier the fixture planted
 *   may be labelled a keyword, AND every reserved word it planted must be. This
 *   is the only term a grammar-free implementation cannot satisfy, because
 *   telling `const` from `compute` needs lexical knowledge and nothing about
 *   their characters supplies it. One direction alone is not enough: a
 *   classifier calling every word run `function` mislabels no identifier.
 * - `tokenStringMisses` — every quoted literal the fixture wrote must come back
 *   as ONE token spanning its quotes. This is the term a spelling-based fake
 *   cannot reach at all: it requires matching a multi-character span, and an
 *   implementation that matches spans is a lexer.
 *
 * Grading is deliberately done OUTSIDE every timed bracket. It walks the whole
 * tree, which is comparable to the work being measured.
 */
export interface TokenGrade {
  tokenLineMisses: number;
  tokenContentMisses: number;
  tokenHighlightMisses: number;
  tokenCategoryMisses: number;
  tokenLexicalMisses: number;
  tokenStringMisses: number;
}

/**
 * Whether a corpus entry's language yields syntax tokens over THIS content.
 *
 * Named states rather than a boolean, because a boolean read as "expects none"
 * would assert something the fixture does not know: the generated diff is
 * code-shaped for every entry, so markdown correctly produces no tokens today,
 * but a future grammar that tokenized it would not be a defect. `"unchecked"`
 * says the fixture declines to assert, which is what it actually means; the
 * content term still grades that file.
 */
export type SyntaxTokenExpectation = "required" | "unchecked";

/** The highest line number each side of the diff reaches. */
function expectedLineCounts(hunks: readonly HunkData[]): { old: number; new: number } {
  let oldLines = 0;
  let newLines = 0;
  for (const change of hunks.flatMap((hunk) => hunk.changes)) {
    const record = change as {
      oldLineNumber?: number;
      newLineNumber?: number;
      lineNumber?: number;
    };
    if (change.type !== "insert") {
      oldLines = Math.max(oldLines, record.oldLineNumber ?? record.lineNumber ?? 0);
    }
    if (change.type !== "delete") {
      newLines = Math.max(newLines, record.newLineNumber ?? record.lineNumber ?? 0);
    }
  }
  return { old: oldLines, new: newLines };
}

/** Concatenate the text nodes of one tokenized line back into its source text. */
function lineText(node: unknown): string {
  if (Array.isArray(node)) return node.map(lineText).join("");
  if (typeof node !== "object" || node === null) return "";
  const candidate = node as { type?: unknown; value?: unknown; children?: unknown };
  if (candidate.type === "text") return String(candidate.value ?? "");
  return lineText(candidate.children);
}

/**
 * What a running grammar leaves behind, as distinct from a wrapper.
 *
 * Four progressively weaker versions were rejected on the way here, each
 * defeated by a cheaper fake than the last:
 *
 * - "the tree contains a token element somewhere" — one planted node covers a
 *   whole file.
 * - "…spanning non-empty text" — one `<span class="token">` around one line.
 * - "…on a share of lines" — still satisfied by wrapping whole lines.
 * - "…whose className carries a second entry" — satisfied by `["token", "x"]`,
 *   or by wrapping each line's first lexeme as a `keyword`. A second class name
 *   is not evidence that anything parsed.
 *
 * So the test is on the SHAPE of the output rather than on any single node,
 * measured against what the real tokenizer produces over this exact corpus:
 *
 *   typescript  12.5 tokens/line   6 categories
 *   tsx         12.5 tokens/line   6 categories
 *   json         5.9 tokens/line   4 categories
 *   css          9.4 tokens/line   5 categories
 *   markdown     0                 0            (declared "unchecked")
 *
 * Every wrapper fake above produces exactly 1 token per line and exactly 1
 * category, so the floors below sit an order of magnitude clear of them while
 * leaving room for a grammar upgrade to rename or merge categories. This is
 * deliberately NOT a golden digest of the output: that would pin the reading to
 * one version of refractor and turn an ordinary dependency bump into a
 * correctness failure, which is how a predicate gets weakened until it means
 * nothing.
 *
 * These floors detect SPARSE output. They cannot, on their own, tell a grammar
 * from a dense wrapper — that is what `CATEGORY_CONTRACTS` below is for.
 */
interface TokenShape {
  tokens: number;
  categories: Set<string>;
}

function tokenShape(
  node: unknown,
  into: TokenShape = { tokens: 0, categories: new Set() }
): TokenShape {
  if (Array.isArray(node)) {
    for (const child of node) tokenShape(child, into);
    return into;
  }
  if (typeof node !== "object" || node === null) return into;
  const candidate = node as {
    type?: unknown;
    properties?: { className?: unknown };
    children?: unknown;
  };
  if (candidate.type === "element") {
    const className = candidate.properties?.className;
    if (
      Array.isArray(className) &&
      className.includes("token") &&
      lineText(candidate).trim().length > 0
    ) {
      into.tokens += 1;
      for (const name of className) if (name !== "token") into.categories.add(String(name));
    }
  }
  return tokenShape(candidate.children, into);
}

/**
 * Categorised tokens per source line a real grammar must beat.
 *
 * Two, against a measured worst case of 5.9 for JSON. Every wrapper fake
 * produces exactly one.
 */
const MIN_TOKENS_PER_SOURCE_LINE = 2;

/**
 * Distinct syntax categories a real grammar must name.
 *
 * Three, against a measured worst case of four for JSON. A wrapper names one,
 * and `["token", "token"]` names none.
 */
const MIN_DISTINCT_CATEGORIES = 3;

/**
 * What each syntax category MEANS, as a contract its text must satisfy.
 *
 * This is the term that establishes a grammar ran, and it is the one thing the
 * density and diversity floors cannot do. A reviewer's final objection was that
 * a wrapper emitting a categorised token around every character, cycling
 * category names, clears both floors without parsing anything. It does — and it
 * fails here, because it assigns `operator` to `const` and `keyword` to `(`.
 *
 * Measured over this corpus: the real tokenizer commits ZERO violations across
 * 13,000+ contracted tokens in four languages, while that exact cycling wrapper
 * commits 56%. The asymmetry is not a threshold anyone tuned — it falls out of
 * the fact that a lexer assigns categories BY content and a wrapper cannot.
 *
 * Only categories whose meaning is language-independent are contracted.
 * `function`, `selector`, `property` and `class-name` mean different things per
 * grammar, and `string` is dropped because intra-line edit marking can split a
 * literal so a fragment carries no quote. Each contract is also written to
 * survive fragmentation: a piece of a keyword is still letters, a piece of
 * punctuation is still punctuation.
 */
const CATEGORY_CONTRACTS: Readonly<Record<string, (text: string) => boolean>> = {
  punctuation: (text) => !/[A-Za-z0-9]/.test(text),
  operator: (text) => !/[A-Za-z0-9]/.test(text),
  // Digits, with hex letters and exponent markers tolerated; nothing else.
  number: (text) => /[0-9]/.test(text) && !/[G-WYZg-wyz_$]/.test(text),
  keyword: (text) => /[A-Za-z]/.test(text) && !/[(){}[\];,]/.test(text),
};

/**
 * Contracted tokens per source line a real grammar must produce.
 *
 * Without a floor here, a wrapper could dodge the contracts entirely by cycling
 * only uncontracted category names — three of those satisfy the diversity floor
 * and nothing would ever check their content. Requiring the output to actually
 * USE the universal vocabulary is what forces a fake onto ground where it fails.
 *
 * One, against a measured worst case of 4.5 for CSS and JSON.
 */
const MIN_CONTRACTED_TOKENS_PER_LINE = 1;

interface CategoryAudit {
  contracted: number;
  violations: number;
}

function auditCategories(
  node: unknown,
  into: CategoryAudit = { contracted: 0, violations: 0 }
): CategoryAudit {
  if (Array.isArray(node)) {
    for (const child of node) auditCategories(child, into);
    return into;
  }
  if (typeof node !== "object" || node === null) return into;
  const candidate = node as {
    type?: unknown;
    properties?: { className?: unknown };
    children?: unknown;
  };
  if (candidate.type === "element") {
    const className = candidate.properties?.className;
    if (Array.isArray(className) && className.includes("token")) {
      const text = lineText(candidate).trim();
      if (text.length > 0) {
        for (const name of className) {
          const contract = CATEGORY_CONTRACTS[String(name)];
          if (!contract) continue;
          into.contracted += 1;
          if (!contract(text)) into.violations += 1;
        }
      }
    }
  }
  return auditCategories(candidate.children, into);
}

/**
 * Identifiers the generator plants, which no grammar may call a keyword.
 *
 * THIS is the term that establishes a grammar ran, and it is the only one that
 * cannot be satisfied without lexical knowledge. Everything above it —
 * line count, content, density, category-to-content consistency — is satisfiable
 * by a per-character classifier: digit becomes `number`, letter becomes
 * `keyword`, anything else becomes `punctuation`. That classifier is a real
 * construction, a reviewer named it, and it clears every other check here.
 *
 * What it cannot do is tell a reserved word from an identifier. `const` is a
 * keyword and `compute` is not, and nothing about their characters says so —
 * only a lexer that knows the language does. Measured over this corpus, the
 * real tokenizer labels exactly `const` and `return` as keywords, 28% of word
 * tokens in TypeScript and none at all in JSON or CSS, and mislabels ZERO of
 * the identifiers below. A letter-run classifier labels every one of them.
 *
 * The list is the FIXTURE's own record of what it wrote, not a vocabulary
 * borrowed from the grammar — which is what keeps it an oracle rather than a
 * second implementation of the thing it grades.
 *
 * BOTH DIRECTIONS ARE REQUIRED, and the one-sided version was a real hole. A
 * classifier that labels every word run `function` — including `const` and
 * `return` — mislabels no identifier and passes a false-positive check
 * outright. So each corpus entry also declares the reserved words it planted,
 * and every occurrence of one must come back as a keyword. Scoped per entry
 * because JSON and CSS legitimately have no keywords at all: measured over this
 * corpus, TypeScript and TSX match exactly at every scale (208, 520 and 2,730
 * occurrences, delta 0) while JSON and CSS observe none and declare none.
 *
 * WHERE THE ESCALATION STOPS
 *   These five terms were built against a reviewer producing successively
 *   better fakes, and each one closed the fake before it: a null tree, an empty
 *   tree, sparse arrays, a planted token, whole-line spans, `["token","token"]`,
 *   one lexeme per line, a category-cycling per-character wrapper, a
 *   character-class classifier, and a classifier calling every word a
 *   non-keyword. The unit test contains every one of them.
 *
 *   The next fake is a classifier that hardcodes this language's reserved
 *   words. It is not closed, and it is not going to be: any check on a property
 *   P is satisfied by an impostor that encodes P, so the escalation has no
 *   fixed point. What ends it is the threat model rather than another term.
 *   This predicate exists to catch a subject that got FASTER by doing LESS — a
 *   stub, a silent fallback, a plaintext downgrade — because that is the only
 *   direction a performance benchmark can be gamed from. Every fake above is
 *   cheaper than tokenizing and every one now fails. A classifier carrying a
 *   keyword table is more expensive than the real path and would report a worse
 *   number, so nothing pushes an implementation toward it.
 *
 *   `README.md` states the general form of this limit: an oracle cannot be
 *   mechanically proven independent, and whether a predicate is real rather
 *   than decorative is a review obligation. This is where that obligation was
 *   discharged, and this comment is the record of how far it was taken.
 */
const PLANTED_IDENTIFIERS: ReadonlySet<string> = new Set([
  "resolve",
  "legacyCompute",
  "compute",
  "aggregate",
  "retries",
  "backoff",
]);

/**
 * Quoted literals the fixture wrote, which only a lexer can reassemble.
 *
 * This is the term that ends the escalation, and it ends it on a property
 * rather than on a judgement call. Every fake before it classified by SPELLING:
 * look at a word or a character, emit a category. `"expo"` cannot be produced
 * that way. It is one token spanning the quotes — and the quote characters are
 * non-alphanumeric, so any character-class rule calls them punctuation and
 * splits the literal into three. Emitting it whole means recognising an opening
 * quote and consuming to the closing one as a unit. That is recognition of a
 * multi-character lexical SPAN — not necessarily an explicit quote mode; a
 * scanner whose alternation leads with `"[^"]*"` clears it too. Either way the
 * implementation has stopped classifying by spelling and started lexing, which
 * is the point: the thing that passes this term is a tokenizer, so a benchmark
 * that passes it is measuring one.
 *
 * Measured over this corpus, expected against observed, per side: TypeScript,
 * TSX, JSON and CSS all match exactly at every scale the family uses — 160, 400
 * and 2,100 literals, delta 0 — while markdown produces none and declares
 * itself unchecked.
 */
function countQuotedLiterals(hunks: readonly HunkData[], side: "old" | "new"): number {
  let count = 0;
  for (const change of hunks.flatMap((hunk) => hunk.changes)) {
    if (side === "old" && change.type === "insert") continue;
    if (side === "new" && change.type === "delete") continue;
    const content = (change as { content?: string }).content ?? "";
    count += (content.match(/"[^"]*"/g) ?? []).length;
  }
  return count;
}

/** Tokens categorised `string` whose text spans a complete quoted literal. */
function countStringTokens(node: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce<number>((sum, child) => sum + countStringTokens(child), 0);
  }
  if (typeof node !== "object" || node === null) return 0;
  const candidate = node as {
    type?: unknown;
    properties?: { className?: unknown };
    children?: unknown;
  };
  let found = 0;
  if (candidate.type === "element") {
    const className = candidate.properties?.className;
    if (
      Array.isArray(className) &&
      className.includes("token") &&
      className.includes("string") &&
      /^".*"$/s.test(lineText(candidate).trim())
    ) {
      found += 1;
    }
  }
  return found + countStringTokens(candidate.children);
}

/** Words the fixture planted, as a lexer would find them. */
function wordsIn(text: string): string[] {
  return text.match(/[A-Za-z_$][\w$]*/g) ?? [];
}

/** Occurrences of the entry's declared reserved words in the source it wrote. */
function countPlantedReservedWords(
  hunks: readonly HunkData[],
  side: "old" | "new",
  reservedWords: ReadonlySet<string>
): number {
  if (reservedWords.size === 0) return 0;
  let count = 0;
  for (const change of hunks.flatMap((hunk) => hunk.changes)) {
    if (side === "old" && change.type === "insert") continue;
    if (side === "new" && change.type === "delete") continue;
    const content = (change as { content?: string }).content ?? "";
    for (const word of wordsIn(content)) if (reservedWords.has(word)) count += 1;
  }
  return count;
}

/** Tokens the tokenizer labelled `keyword` whose text is a declared reserved word. */
function countKeywordTokens(node: unknown, reservedWords: ReadonlySet<string>): number {
  if (Array.isArray(node)) {
    return node.reduce<number>((sum, child) => sum + countKeywordTokens(child, reservedWords), 0);
  }
  if (typeof node !== "object" || node === null) return 0;
  const candidate = node as {
    type?: unknown;
    properties?: { className?: unknown };
    children?: unknown;
  };
  let found = 0;
  if (candidate.type === "element") {
    const className = candidate.properties?.className;
    if (
      Array.isArray(className) &&
      className.includes("token") &&
      className.includes("keyword") &&
      reservedWords.has(lineText(candidate).trim())
    ) {
      found += 1;
    }
  }
  return found + countKeywordTokens(candidate.children, reservedWords);
}

/** Tokens that called one of the fixture's own identifiers a reserved word. */
function countKeywordMislabels(node: unknown): number {
  if (Array.isArray(node))
    return node.reduce<number>((sum, child) => sum + countKeywordMislabels(child), 0);
  if (typeof node !== "object" || node === null) return 0;
  const candidate = node as {
    type?: unknown;
    properties?: { className?: unknown };
    children?: unknown;
  };
  let misses = 0;
  if (candidate.type === "element") {
    const className = candidate.properties?.className;
    if (
      Array.isArray(className) &&
      className.includes("token") &&
      className.includes("keyword") &&
      PLANTED_IDENTIFIERS.has(lineText(candidate).trim())
    ) {
      misses += 1;
    }
  }
  return misses + countKeywordMislabels(candidate.children);
}

/** Source lines each side of the diff actually contains. */
function sourceLineCounts(hunks: readonly HunkData[]): { old: number; new: number } {
  let old = 0;
  let now = 0;
  for (const change of hunks.flatMap((hunk) => hunk.changes)) {
    if (change.type !== "insert") old += 1;
    if (change.type !== "delete") now += 1;
  }
  return { old, new: now };
}

export function gradeTokens(
  tokens: HunkTokens | null,
  hunks: readonly HunkData[],
  syntaxTokens: SyntaxTokenExpectation,
  /**
   * Reserved words this corpus entry planted, which the grammar for its
   * language must recognise. Empty for languages that have none.
   */
  reservedWords: readonly string[] = []
): TokenGrade {
  if (!tokens) {
    // A null tree is already counted by `tokenizeMisses`; charging the line and
    // content counts here as well would report one failure hundreds of times.
    return {
      tokenLineMisses: 0,
      tokenContentMisses: 0,
      tokenHighlightMisses: 0,
      tokenCategoryMisses: 0,
      tokenLexicalMisses: 0,
      tokenStringMisses: 0,
    };
  }

  const expected = expectedLineCounts(hunks);
  let tokenContentMisses = 0;
  for (const change of hunks.flatMap((hunk) => hunk.changes)) {
    const record = change as {
      oldLineNumber?: number;
      newLineNumber?: number;
      lineNumber?: number;
      content?: string;
    };
    const content = record.content ?? "";
    if (change.type !== "insert") {
      const at = (record.oldLineNumber ?? record.lineNumber ?? 0) - 1;
      if (lineText(tokens.old[at]) !== content) tokenContentMisses += 1;
    }
    if (change.type !== "delete") {
      const at = (record.newLineNumber ?? record.lineNumber ?? 0) - 1;
      if (lineText(tokens.new[at]) !== content) tokenContentMisses += 1;
    }
  }

  const sources = sourceLineCounts(hunks);
  const shortOfFloor = (side: readonly unknown[], sourceLines: number): boolean => {
    if (sourceLines <= 0) return false;
    const shape = tokenShape(side);
    return (
      shape.tokens < sourceLines * MIN_TOKENS_PER_SOURCE_LINE ||
      shape.categories.size < MIN_DISTINCT_CATEGORIES
    );
  };
  // One miss per SIDE that fell short, so a tree highlighting only `old`
  // reports half a failure rather than none.
  const highlightMisses =
    (shortOfFloor(tokens.old, sources.old) ? 1 : 0) +
    (shortOfFloor(tokens.new, sources.new) ? 1 : 0);

  // Category-to-content consistency, per side. A shortfall in contracted
  // tokens counts as one miss (the output never used the vocabulary a grammar
  // produces); every inconsistent token counts as one more.
  const auditSide = (side: readonly unknown[], sourceLines: number): number => {
    if (sourceLines <= 0) return 0;
    const audit = auditCategories(side);
    const coverageShortfall =
      audit.contracted < sourceLines * MIN_CONTRACTED_TOKENS_PER_LINE ? 1 : 0;
    return coverageShortfall + audit.violations;
  };
  const categoryMisses =
    syntaxTokens === "required"
      ? auditSide(tokens.old, sources.old) + auditSide(tokens.new, sources.new)
      : 0;

  // Graded on BOTH sides regardless of `syntaxTokens`: an entry the fixture
  // declines to assert highlighting for may still not rename the fixture's
  // identifiers into keywords, and markdown produces no keyword tokens at all,
  // so this reads 0 there rather than being skipped.
  const reserved = new Set(reservedWords);
  const lexicalMisses =
    // False positives: an identifier the fixture planted, called a keyword.
    countKeywordMislabels(tokens.old) +
    countKeywordMislabels(tokens.new) +
    // False negatives: a reserved word the fixture planted, NOT called a
    // keyword. Without this, labelling every word run `function` passes.
    Math.abs(
      countPlantedReservedWords(hunks, "old", reserved) - countKeywordTokens(tokens.old, reserved)
    ) +
    Math.abs(
      countPlantedReservedWords(hunks, "new", reserved) - countKeywordTokens(tokens.new, reserved)
    );

  // Multi-character lexical SPANS, as distinct from lexical knowledge. A
  // spelling-based classifier can carry a keyword table; it cannot emit
  // `"expo"` as one token, because that means matching a span rather than
  // classifying a character.
  const stringMisses =
    syntaxTokens === "required"
      ? Math.abs(countQuotedLiterals(hunks, "old") - countStringTokens(tokens.old)) +
        Math.abs(countQuotedLiterals(hunks, "new") - countStringTokens(tokens.new))
      : 0;

  return {
    tokenLineMisses:
      Math.abs(expected.old - tokens.old.length) + Math.abs(expected.new - tokens.new.length),
    tokenContentMisses,
    tokenHighlightMisses: syntaxTokens === "required" ? highlightMisses : 0,
    tokenCategoryMisses: categoryMisses,
    tokenLexicalMisses: lexicalMisses,
    tokenStringMisses: stringMisses,
  };
}

function emptyTokenGrade(): TokenGrade {
  return {
    tokenLineMisses: 0,
    tokenContentMisses: 0,
    tokenHighlightMisses: 0,
    tokenCategoryMisses: 0,
    tokenLexicalMisses: 0,
    tokenStringMisses: 0,
  };
}

function addTokenGrade(into: TokenGrade, from: TokenGrade): TokenGrade {
  into.tokenLineMisses += from.tokenLineMisses;
  into.tokenContentMisses += from.tokenContentMisses;
  into.tokenHighlightMisses += from.tokenHighlightMisses;
  into.tokenCategoryMisses += from.tokenCategoryMisses;
  into.tokenLexicalMisses += from.tokenLexicalMisses;
  into.tokenStringMisses += from.tokenStringMisses;
  return into;
}

/** How many selections PERF-164's burst issues under one key. */
const BURST_REQUESTS = 20;

/** One consumer key: a reviewer holding j/k down inside ONE diff viewer. */
const BURST_KEY = "perf-164-review-viewer";

/**
 * The entries of the review changeset whose fixture REQUIRES syntax tokens.
 *
 * PERF-164 grades only its final selection, so that selection has to be one
 * the strict oracle applies to. Cycling all five entries over twenty requests
 * would land the last one on markdown, whose entry deliberately declines to
 * assert highlighting over this corpus.
 */
const HIGHLIGHTED_REVIEW_FILES = REVIEW_CHANGESET.filter(
  (file) => file.syntaxTokens === "required"
);

/**
 * PERF-162's changeset, scaled to twenty distinct selections.
 *
 * Every entry gets its own path and seed. `generateUnifiedDiff` writes the seed
 * into each changed line, so a client that resolved an EARLIER selection's
 * token tree fails the content term rather than passing quietly.
 */
const ADMISSION_BURST: ReadonlyArray<{
  spec: DiffSpec;
  language: string;
  syntaxTokens: SyntaxTokenExpectation;
  reservedWords: readonly string[];
}> = Array.from({ length: BURST_REQUESTS }, (_unused, index) => {
  const source = HIGHLIGHTED_REVIEW_FILES[index % HIGHLIGHTED_REVIEW_FILES.length]!;
  return {
    spec: {
      path: `burst-${index}/${source.spec.path}`,
      changedLines: source.spec.changedLines,
      seed: source.spec.seed + index * 97,
    },
    language: source.language,
    syntaxTokens: source.syntaxTokens,
    reservedWords: source.reservedWords,
  };
});

/** Every grammar the burst touches, warmed before the bracket opens. */
const BURST_LANGUAGES = [...new Set(ADMISSION_BURST.map((file) => file.language))];

export const diffTokenizeScenarios: PerfScenario[] = [
  {
    id: "PERF-160",
    name: "Diff Tokenize - Representative File",
    description:
      "Tokenize a single ~800-changed-line TypeScript diff with highlight + intra-line edit " +
      "marking (under the markEdits budget, so markEdits + suppressFullLineEdits run) — the common " +
      "'review a substantial file change' case. durationMs is the runDiffTokenize pass the " +
      "worker/fallback executes; fixture build + parseDiff are excluded from the bracket. Throws " +
      "tokenizeMisses is non-zero if tokenization silently degraded to null.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 14, nightly: 20 },
    warmups: 1,
    correctness: [
      "tokenizeMisses",
      "tokenLineMisses",
      "tokenContentMisses",
      "tokenHighlightMisses",
      "tokenCategoryMisses",
      "tokenLexicalMisses",
      "tokenStringMisses",
    ],
    async run() {
      const { hunks, changedLines } = hunksFor({
        path: "src/service.ts",
        changedLines: 800,
        seed: 160,
      });
      const start = performance.now();
      const result = await runDiffTokenize({
        hunks,
        language: "typescript",
        highlight: true,
        extraRanges: null,
      });
      const durationMs = performance.now() - start;
      const tokenizeMisses = result.tokens ? 0 : 1;
      return {
        durationMs,
        metrics: {
          changedLines,
          hunks: hunks.length,
          tokensProduced: 1 - tokenizeMisses,
          tokenizeMisses,
          ...gradeTokens(result.tokens, hunks, "required", TYPESCRIPT_RESERVED),
        },
        notes: tokenizeMisses > 0 ? "runDiffTokenize returned null tokens" : undefined,
      };
    },
  },
  {
    id: "PERF-161",
    name: "Diff Tokenize - Oversized Fallback",
    description:
      "Tokenize a diff sized past the real MAX_INTRALINE_CHANGES budget so shouldMarkIntraLineEdits " +
      "returns false and the whole-line fallback runs (no per-block diff-match-patch churn). Proves " +
      "the large-diff path git-diff-highlight/VS Code also use stays cheap; markedIntraLine (derived " +
      "from the imported production threshold) must stay 0; tokenizeMisses catches a null tokenize.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: [
      "tokenizeMisses",
      "tokenLineMisses",
      "tokenContentMisses",
      "tokenHighlightMisses",
      "tokenCategoryMisses",
      "tokenLexicalMisses",
      "tokenStringMisses",
    ],
    async run() {
      // Size from the real threshold with margin so the fixture is over-budget
      // regardless of what MAX_INTRALINE_CHANGES is set to in production.
      const target = Math.ceil(MAX_INTRALINE_CHANGES * 1.4);
      const { hunks, changedLines } = hunksFor({
        path: "src/generated.ts",
        changedLines: target,
        seed: 161,
      });
      if (changedLines <= MAX_INTRALINE_CHANGES) {
        throw new Error(
          `PERF-161: fixture (${changedLines}) did not exceed MAX_INTRALINE_CHANGES (${MAX_INTRALINE_CHANGES})`
        );
      }
      const start = performance.now();
      const result = await runDiffTokenize({
        hunks,
        language: "typescript",
        highlight: true,
        extraRanges: null,
      });
      const durationMs = performance.now() - start;
      const tokenizeMisses = result.tokens ? 0 : 1;
      return {
        durationMs,
        metrics: {
          changedLines,
          hunks: hunks.length,
          // Mirrors shouldMarkIntraLineEdits against the imported production
          // threshold — 0 asserts the fallback (no intra-line marking) path.
          markedIntraLine: changedLines <= MAX_INTRALINE_CHANGES ? 1 : 0,
          tokensProduced: 1 - tokenizeMisses,
          tokenizeMisses,
          ...gradeTokens(result.tokens, hunks, "required", TYPESCRIPT_RESERVED),
        },
        notes: tokenizeMisses > 0 ? "runDiffTokenize returned null tokens" : undefined,
      };
    },
  },
  {
    id: "PERF-162",
    name: "Diff Tokenize - Multi-File Review Open",
    description:
      "Tokenize a five-file, multi-language changeset (typescript, tsx, json, css, markdown), each " +
      "~320 changed lines (rounded to whole hunks), back to back — models opening a multi-file " +
      "review workspace where each file is tokenized on demand. durationMs is the summed tokenize " +
      "cost; tokenizeMisses counts files that produced no tokens.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: [
      "tokenizeMisses",
      "tokenLineMisses",
      "tokenContentMisses",
      "tokenHighlightMisses",
      "tokenCategoryMisses",
      "tokenLexicalMisses",
      "tokenStringMisses",
    ],
    async run() {
      const prepared = REVIEW_CHANGESET.map((file) => ({
        ...hunksFor(file.spec),
        language: file.language,
        syntaxTokens: file.syntaxTokens,
        reservedWords: file.reservedWords,
      }));

      const start = performance.now();
      let filesTokenized = 0;
      let changedLines = 0;
      // The trees are RETAINED and graded after the bracket closes. Grading
      // walks every token node, which is comparable to the work being measured,
      // so doing it inside the loop would put the oracle in the number.
      const produced: Array<HunkTokens | null> = [];
      for (const file of prepared) {
        const result = await runDiffTokenize({
          hunks: file.hunks,
          language: file.language,
          highlight: true,
          extraRanges: null,
        });
        produced.push(result.tokens);
        if (result.tokens) filesTokenized += 1;
        changedLines += file.changedLines;
      }
      const durationMs = performance.now() - start;
      const tokenizeMisses = prepared.length - filesTokenized;

      // Accumulated PER FILE. One summed grade over the whole changeset would
      // let four healthy files cover for one that came back empty.
      const tokenGrade = prepared.reduce(
        (into, file, index) =>
          addTokenGrade(
            into,
            gradeTokens(produced[index]!, file.hunks, file.syntaxTokens, file.reservedWords)
          ),
        emptyTokenGrade()
      );

      return {
        durationMs,
        metrics: {
          filesTokenized,
          fileCount: prepared.length,
          changedLines,
          tokenizeMisses,
          ...tokenGrade,
        },
        notes:
          tokenizeMisses > 0
            ? `only ${filesTokenized}/${prepared.length} files tokenized`
            : undefined,
      };
    },
  },
  {
    id: "PERF-163",
    name: "Diff Tokenize - Foreground Cost of a Review Open",
    description:
      "The same five-file changeset as PERF-162, tokenized with a fixed-cadence probe watching the " +
      "main thread — preceded by the same probe over a fixed idle window on a settled heap, so the " +
      "reported cost is the DIFFERENCE rather than a property of the machine. A Node timer cannot fire while " +
      "synchronous work holds the loop, so the gap between probe observations IS main-thread " +
      "starvation in milliseconds. This answers the question PERF-160..162 cannot: opening a review " +
      "20% faster is not an improvement if the longest single block the user's terminal waits " +
      "behind is unchanged. It is main-thread AVAILABILITY, not keystroke-to-paint — there is no " +
      "Chromium scheduler or xterm here. A workload that did nothing would post perfect stall " +
      "numbers, so the tokenizer's own output is graded alongside probeMisses: the tree must carry " +
      "one entry per old and new line (counted from the fixture's hunks, not from the tokenizer) " +
      "and must contain real syntax-token elements. A plaintext passthrough satisfies the line " +
      "count exactly and fails the highlight term; an empty tree fails the line count. probeMisses " +
      "proves only that the probe stayed alive.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: [
      "tokenizeMisses",
      "tokenLineMisses",
      "tokenContentMisses",
      "tokenHighlightMisses",
      "tokenCategoryMisses",
      "tokenLexicalMisses",
      "tokenStringMisses",
      "probeMisses",
    ],
    // The changeset is the workload. Four files instead of five, or a
    // generator that shrank its hunks, would report a shorter block and a
    // cleaner loop with every predicate at zero.
    workloadFloors: { fileCount: 5, filesTokenized: 5, changedLines: 1_500 },
    async run() {
      const prepared = REVIEW_CHANGESET.map((file) => ({
        ...hunksFor(file.spec),
        language: file.language,
        syntaxTokens: file.syntaxTokens,
        reservedWords: file.reservedWords,
      }));

      // Calibrate first, on a settled heap. Anything measured here is the
      // machine, not the tokenizer.
      //
      // The forced collection also puts this scenario's own bracket on a
      // cleaner heap than PERF-162's, which pays whatever collection falls due
      // inside it. The two durations are therefore NOT comparable to each other
      // even though the changeset is identical; each is comparable to itself.
      globalThis.gc?.();
      const idleProbe = await armBystanderProbe({ cadenceMs: PROBE_CADENCE_MS });
      try {
        await sleep(IDLE_CALIBRATION_MS);
      } finally {
        idleProbe.stop();
      }
      const idle = idleProbe.stop();

      let filesTokenized = 0;
      let changedLines = 0;
      // Retained and graded after the bracket — grading walks every token node,
      // and this scenario's whole subject is what the loop was doing during it.
      const produced: Array<HunkTokens | null> = [];

      const workloadProbe = await armBystanderProbe({ cadenceMs: PROBE_CADENCE_MS });
      const start = performance.now();
      // The probe's timer is REFERENCED while it is live — an unref'd one lets
      // the process exit before it has ever fired, which is a deadlock rather
      // than a leak. So a workload that throws must not leave one running.
      // `stop()` is idempotent, so the finally is safe on the success path too.
      try {
        for (const file of prepared) {
          const result = await runDiffTokenize({
            hunks: file.hunks,
            language: file.language,
            highlight: true,
            extraRanges: null,
          });
          produced.push(result.tokens);
          if (result.tokens) filesTokenized += 1;
          changedLines += file.changedLines;
          // Production tokenizes one file per component render, so the loop is
          // free between files. Yielding here is what makes the measured stall
          // the cost of ONE file rather than of the whole changeset — the frame
          // the user actually loses.
          await yieldToLoop();
        }
      } finally {
        workloadProbe.stop();
      }
      const durationMs = performance.now() - start;
      const underLoad = workloadProbe.stop();

      const tokenizeMisses = prepared.length - filesTokenized;
      const tokenGrade = prepared.reduce(
        (into, file, index) =>
          addTokenGrade(
            into,
            gradeTokens(produced[index]!, file.hunks, file.syntaxTokens, file.reservedWords)
          ),
        emptyTokenGrade()
      );

      return {
        durationMs,
        metrics: {
          filesTokenized,
          fileCount: prepared.length,
          changedLines,
          ...bystanderMetrics("load", underLoad),
          ...bystanderMetrics("idle", idle),
          // The headline: how much longer the worst block was with the
          // tokenizer on the loop than without it. Subtraction, not a ratio —
          // an idle stall near zero makes a ratio meaningless.
          excessLongestStallMs: Math.max(0, underLoad.longestStallMs - idle.longestStallMs),
          tokenizeMisses,
          ...tokenGrade,
          probeMisses: underLoad.probeMisses + idle.probeMisses,
        },
        notes:
          tokenizeMisses > 0
            ? `only ${filesTokenized}/${prepared.length} files tokenized`
            : `longest block ${underLoad.longestStallMs.toFixed(1)}ms vs ${idle.longestStallMs.toFixed(1)}ms idle`,
      };
    },
  },
  {
    id: "PERF-164",
    name: "Diff Tokenize - Superseded Selection Burst",
    description:
      "Twenty tokenize requests under ONE consumer key, issued back to back with no await between " +
      "them. One key is one MOUNTED FILE DIFF, not a whole review: DiffViewer's useTokens takes its " +
      "key from useId(), so each file gets its own and different files are independent consumers by " +
      "design. What re-requests the same key twenty times is a search query being typed — " +
      "extraRanges is deliberately ungated in that effect, so every keystroke re-tokenizes the file " +
      "— along with collapse, wrap and view-type changes. The subject is DiffTokenizeClient's " +
      "admission control, not the tokenizer: PERF-160..163 all call runDiffTokenize directly and " +
      "none of them post work the client has already given up on. The client is driven UNMODIFIED " +
      "against a real node:worker_threads thread running the production tokenizer, so executedJobs " +
      "is counted where the work happens rather than inferred from what the client posted — the " +
      "client's own bookkeeping is the thing under test and cannot also be the oracle. " +
      "finalSelectionMs is the last tokenize() call to its resolved result: a service-level " +
      "completion time, NOT keystroke-to-paint — there is no renderer, no Chromium scheduler and no " +
      "React commit here. executedJobs and supersededPosted are raw counts and deliberately NOT " +
      "correctness terms — a predicate asserting 'exactly two jobs ran' would fail on an unmodified " +
      "client, which is precisely the arm this scenario has to be able to measure. Only the final " +
      "selection is graded, on PERF-162's terms: it is the one result a caller consumes, each entry " +
      "carries its own seed so an earlier selection's tree fails the content term instead of " +
      "passing quietly, and that seed is also how the oracle identifies WHICH posted request was " +
      "the final one rather than trusting id order.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: [
      "tokenizeMisses",
      "supersededResolutionMisses",
      "executionAccountingMisses",
      "workerRoutingMisses",
      "tokenLineMisses",
      "tokenContentMisses",
      "tokenHighlightMisses",
      "tokenCategoryMisses",
      "tokenLexicalMisses",
      "tokenStringMisses",
    ],
    // The burst IS the workload. A fixture that quietly issued two requests
    // would report executedJobs: 2 with every predicate at zero — the best
    // result this scenario can post, from doing none of the work.
    workloadFloors: {
      requestCount: BURST_REQUESTS,
      fileCount: BURST_REQUESTS,
      changedLines: 6_400,
      minChangedLinesPerRequest: 320,
    },
    async run() {
      const prepared = ADMISSION_BURST.map((file) => ({
        ...hunksFor(file.spec),
        language: file.language,
        syntaxTokens: file.syntaxTokens,
        reservedWords: file.reservedWords,
      }));
      const requestFor = (file: (typeof prepared)[number]): DiffTokenizeRequest => ({
        hunks: file.hunks,
        language: file.language,
        highlight: true,
        extraRanges: null,
      });

      const { harness, factory } = createNodeDiffTokenizeWorker();
      let factoryCalls = 0;
      const client = new DiffTokenizeClient(() => {
        factoryCalls += 1;
        return factory();
      });

      try {
        // Warm every grammar the burst uses, outside the bracket. The worker
        // lazy-loads a language on first use, and that import inside the
        // measurement would report a grammar load as tokenize latency.
        for (const language of BURST_LANGUAGES) {
          await client.tokenize(`perf-164-warmup-${language}`, {
            ...requestFor(prepared[0]!),
            language,
          });
        }
        const warm = await harness.stats();
        const postedBeforeBurst = harness.posted.length;
        const deliveredBeforeBurst = harness.delivered.length;

        // The workload has to be counted where the calls are MADE, not read off
        // the prepared fixture. A submission loop that quietly issued two
        // requests would still let the fixture report twenty — the exact
        // flattering shortfall the floors below exist to catch.
        const issued: number[] = [];
        const supersededPromises: Array<Promise<DiffTokenizeResult | null>> = [];
        const start = performance.now();
        for (let index = 0; index < prepared.length - 1; index += 1) {
          // No await between calls. A loop that waited would measure a queue
          // nobody has, and would never supersede anything.
          issued.push(index);
          supersededPromises.push(client.tokenize(BURST_KEY, requestFor(prepared[index]!)));
        }
        const finalIndex = prepared.length - 1;
        const finalFile = prepared[finalIndex]!;
        issued.push(finalIndex);
        const finalStart = performance.now();
        const finalResult = await client.tokenize(BURST_KEY, requestFor(finalFile));
        const finished = performance.now();
        const finalSelectionMs = finished - finalStart;
        const durationMs = finished - start;

        // Graded HERE, before any further await. A client that resolved early
        // with a stale tree and repaired it once the real response landed would
        // otherwise report the early timestamp and still pass the content term.
        const tokenizeMisses =
          finalResult && finalResult.tokens && !finalResult.langLoadFailed ? 0 : 1;
        const tokenGrade = gradeTokens(
          finalResult?.tokens ?? null,
          finalFile.hunks,
          finalFile.syntaxTokens,
          finalFile.reservedWords
        );

        // Everything below is outside both clocks: the superseded promises are
        // already settled, and the tally is the oracle, not the subject.
        const superseded = await Promise.all(supersededPromises);
        const after = await harness.stats();

        const burstPosted = harness.posted.slice(postedBeforeBurst);
        const burstDelivered = harness.delivered.slice(deliveredBeforeBurst);
        const burstExecuted = after.executedIds.slice(warm.executedIds.length);
        // Identify the final selection by its CONTENT, not by id order. Correct
        // final tokens are not by themselves evidence the worker produced them:
        // a client that ran the held request in-thread would return the right
        // tree, resolve the other nineteen null and post a flattering count
        // with every term at zero. Matching the seed the generator wrote into
        // the fixture, and requiring that id's response to have been delivered,
        // is what makes the route part of the measurement.
        const finalSample = requestSample(finalFile.hunks);
        const finalPost = burstPosted.find((post) => post.sample === finalSample);
        const finalId = finalPost?.id ?? -1;

        const postedIds = new Set(burstPosted.map((post) => post.id));
        const deliveredIds = new Set(burstDelivered);
        const executedIds = new Set(burstExecuted);
        let executionAccountingMisses =
          burstPosted.length - postedIds.size + (burstExecuted.length - executedIds.size);
        for (const id of postedIds) if (!executedIds.has(id)) executionAccountingMisses += 1;
        for (const id of executedIds) if (!postedIds.has(id)) executionAccountingMisses += 1;
        if (finalId < 0) executionAccountingMisses += 1;
        else if (!executedIds.has(finalId) || !deliveredIds.has(finalId)) {
          executionAccountingMisses += 1;
        }

        const issuedFiles = issued.map((index) => prepared[index]!);
        const changedLines = issuedFiles.reduce((total, file) => total + file.changedLines, 0);

        return {
          durationMs,
          metrics: {
            finalSelectionMs,
            executedJobs: burstExecuted.length,
            postedJobs: burstPosted.length,
            // Jobs that DID cross postMessage and whose result nobody used. A
            // request held back and never posted is not one of these — that is
            // the whole difference the gate makes.
            supersededPosted: burstPosted.filter((post) => post.id !== finalId).length,
            requestCount: issued.length,
            fileCount: new Set(issued.map((index) => ADMISSION_BURST[index]!.spec.path)).size,
            changedLines,
            minChangedLinesPerRequest: Math.min(...issuedFiles.map((file) => file.changedLines)),
            tokenizeMisses,
            supersededResolutionMisses: superseded.filter((result) => result !== null).length,
            executionAccountingMisses,
            workerRoutingMisses: (factoryCalls === 1 ? 0 : 1) + harness.failures.length,
            ...tokenGrade,
          },
          notes: `${burstExecuted.length}/${issued.length} selections reached the worker`,
        };
      } finally {
        // The thread holds the process open, and the liveness driver's own
        // process.exit would mask that rather than prove it was cleaned up.
        await harness.close();
      }
    },
  },
];
