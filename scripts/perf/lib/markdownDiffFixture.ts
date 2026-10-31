import type { ReconstructInput } from "../../../src/components/Worktree/markdownBlockDiff";

/**
 * Fixtures for PERF-419 and PERF-420, the rendered-Markdown diff engine (#15679).
 *
 * Generated rather than read from `docs/`: the issue measured repository
 * documents, but those change with every docs PR, and a workload that moves
 * between two measurements is not a comparison. Each spec is sized to one of
 * the issue's documents — bytes, and roughly its block count, because cost
 * tracks both the parses (bytes) and the block LCS (blocks) — and the edit is
 * the issue's: one single-hunk patch changing one line in fifty.
 *
 * The mix is ordinary prose with the structure the engine actually walks:
 * headings, wrapped paragraphs with inline emphasis, code and links, lists,
 * GFM tables, fenced code, blockquotes and reference definitions. A document of
 * one repeated paragraph would parse faster than anything a user opens.
 */

export interface MarkdownDiffFixtureSpec {
  /** Metric prefix. */
  label: string;
  /** The issue's document this stands in for. */
  standsFor: string;
  /** Minimum realized document size. */
  targetBytes: number;
  /** Approximate top-level block count to aim for. */
  targetBlocks: number;
  /**
   * Wrap width for prose, which sets the line count. Wide by default: this
   * repository never hard-wraps Markdown (host-api.md is 330 KB in 2,846 lines),
   * and the 5,000-line reconstruction ceiling is checked before any parse.
   */
  lineWidth: number;
  /** Stop before the document reaches this many lines. */
  maxLines?: number;
  /** The verdict the engine must reach: within the block ceiling, or refused by it. */
  expected: "ok" | "too-large";
  seed: number;
}

export interface MarkdownDiffFixture {
  spec: MarkdownDiffFixtureSpec;
  input: ReconstructInput;
  /** Bytes of the new side — the document's size. */
  sourceBytes: number;
  /** Logical lines of the new side. */
  sourceLines: number;
  patchBytes: number;
  editedLines: number;
}

/** One line in fifty, as the issue measured. */
export const EDIT_EVERY_LINES = 50;

export const OPEN_FIXTURES: readonly MarkdownDiffFixtureSpec[] = [
  {
    label: "readme9k",
    standsFor: "README.md, 9 KB, 31 blocks",
    targetBytes: 9_000,
    targetBlocks: 28,
    lineWidth: 400,
    expected: "ok",
    seed: 4191,
  },
  {
    label: "manifest67k",
    standsFor: "docs/plugins/manifest.md, 67 KB, 137 blocks",
    targetBytes: 67_000,
    targetBlocks: 125,
    lineWidth: 400,
    expected: "ok",
    seed: 4192,
  },
  {
    label: "views103k",
    standsFor: "docs/plugins/views.md, 103 KB, 239 blocks",
    targetBytes: 103_000,
    targetBlocks: 217,
    lineWidth: 400,
    expected: "ok",
    seed: 4193,
  },
  {
    label: "contribution217k",
    standsFor: "docs/plugins/contribution-points.md, 217 KB, 441 blocks",
    targetBytes: 217_000,
    targetBlocks: 400,
    lineWidth: 400,
    expected: "ok",
    seed: 4194,
  },
  {
    label: "uiKit236k",
    standsFor: "docs/plugins/ui-kit.md, 236 KB, 180 blocks",
    targetBytes: 236_000,
    targetBlocks: 164,
    lineWidth: 400,
    expected: "ok",
    seed: 4195,
  },
  {
    label: "hostApi328k",
    standsFor: "docs/plugins/host-api.md, 328 KB, 634 blocks (refused by the block ceiling)",
    targetBytes: 328_000,
    targetBlocks: 577,
    lineWidth: 400,
    expected: "too-large",
    seed: 4196,
  },
  {
    label: "changelog238k",
    standsFor: "CHANGELOG.md, first 5,000 lines, ~238 KB, over 500 blocks (refused)",
    targetBytes: 238_000,
    targetBlocks: 800,
    lineWidth: 90,
    maxLines: 5_000,
    expected: "too-large",
    seed: 4197,
  },
];

/** The two ~220 KB documents PERF-420 steps between. */
export const STEP_FIXTURES: readonly MarkdownDiffFixtureSpec[] = [
  { ...OPEN_FIXTURES[3]!, label: "stepA", standsFor: "a ~217 KB document", seed: 4201 },
  { ...OPEN_FIXTURES[3]!, label: "stepB", standsFor: "a second ~217 KB document", seed: 4202 },
];

const WORDS = [
  "agent",
  "worktree",
  "terminal",
  "panel",
  "review",
  "change",
  "context",
  "branch",
  "session",
  "command",
  "plugin",
  "layout",
  "the",
  "a",
  "of",
  "and",
  "to",
  "when",
  "every",
  "which",
  "only",
  "never",
  "returns",
  "renders",
  "reads",
  "writes",
  "settles",
  "reports",
  "stays",
  "moves",
  "focus",
  "state",
  "value",
  "result",
  "request",
  "response",
  "file",
  "document",
  "block",
  "patch",
  "source",
  "verdict",
  "model",
  "pane",
  "toolbar",
  "action",
  "manifest",
  "contribution",
  "host",
  "surface",
];

/** mulberry32: small, fast and the same on every platform. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Writer {
  random: () => number;
  spec: MarkdownDiffFixtureSpec;
  references: number;
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function word(writer: Writer): string {
  const roll = writer.random();
  const base = pick(writer.random, WORDS);
  if (roll < 0.03) return `\`${base}()\``;
  if (roll < 0.05) return `**${base}**`;
  if (roll < 0.06) return `_${base}_`;
  if (roll < 0.07) return `[${base}](https://example.com/${base}/${writer.references})`;
  if (roll < 0.075) {
    writer.references++;
    return `[${base}][ref-${writer.references % 12}]`;
  }
  return base;
}

/** Words up to roughly `bytes`, wrapped at the spec's width. */
function prose(writer: Writer, bytes: number, prefix = ""): string[] {
  const lines: string[] = [];
  let line = "";
  let written = 0;
  while (written < bytes) {
    const next = word(writer);
    written += next.length + 1;
    if (line && line.length + next.length + 1 > writer.spec.lineWidth - prefix.length) {
      lines.push(prefix + line);
      line = next;
    } else {
      line = line ? `${line} ${next}` : next;
    }
  }
  if (line) lines.push(`${prefix}${line}.`);
  return lines;
}

function block(writer: Writer, averageBytes: number, index: number): string[] {
  const { random } = writer;
  const size = Math.max(40, Math.round(averageBytes * (0.5 + random())));
  const roll = random();
  if (index % 9 === 0) {
    const depth = index % 27 === 0 ? "##" : "###";
    return [`${depth} ${prose(writer, 24).join(" ").replace(/\.$/, "")}`];
  }
  if (roll < 0.62) return prose(writer, size);
  if (roll < 0.76) {
    const items = Math.max(2, Math.round(size / 70));
    const lines: string[] = [];
    for (let item = 0; item < items; item++) {
      const [first = "", ...rest] = prose(writer, 60);
      lines.push(`- ${first}`, ...rest.map((line) => `  ${line}`));
    }
    return lines;
  }
  if (roll < 0.86) {
    const rows = Math.max(2, Math.round(size / 60));
    const lines = ["| Name | Kind | Notes |", "| --- | --- | --- |"];
    for (let row = 0; row < rows; row++) {
      lines.push(
        `| \`${pick(random, WORDS)}\` | ${pick(random, WORDS)} | ${prose(writer, 32).join(" ")} |`
      );
    }
    return lines;
  }
  if (roll < 0.95) {
    const lines = ["```ts"];
    const count = Math.max(2, Math.round(size / 40));
    for (let line = 0; line < count; line++) {
      lines.push(`const ${pick(random, WORDS)}${line} = ${pick(random, WORDS)}(${line});`);
    }
    lines.push("```");
    return lines;
  }
  return prose(writer, size, "> ");
}

/** A whole document for `spec`, newline-terminated. */
export function generateMarkdownDocument(spec: MarkdownDiffFixtureSpec): string {
  const writer: Writer = { random: createRandom(spec.seed), spec, references: 0 };
  const averageBytes = spec.targetBytes / spec.targetBlocks;
  const definitions = Array.from(
    { length: 12 },
    (_, index) => `[ref-${index}]: https://example.com/reference/${index}`
  );
  const definitionBytes = definitions.join("\n").length + 2;
  const lines: string[] = [`# ${spec.standsFor}`];
  let bytes = lines[0]!.length + 1;
  const lineBudget = (spec.maxLines ?? Infinity) - definitions.length - 2;
  for (let index = 1; bytes + definitionBytes < spec.targetBytes; index++) {
    const next = block(writer, averageBytes, index);
    if (lines.length + next.length + 1 > lineBudget) break;
    lines.push("", ...next);
    bytes += next.reduce((sum, line) => sum + line.length + 1, 1);
  }
  lines.push("", ...definitions);
  return `${lines.join("\n")}\n`;
}

function editable(line: string): boolean {
  if (!line.trim()) return false;
  if (line.startsWith("```")) return false;
  // A table's delimiter row is structure: editing it would turn the table into
  // a paragraph, which is a different and much larger change than one line.
  if (/^\|\s*:?-{3,}/.test(line)) return false;
  return true;
}

function edit(line: string): string {
  if (line.endsWith(" |")) return `${line.slice(0, -2)} revised |`;
  return `${line} revised`;
}

/**
 * One hunk spanning the whole document, with every fiftieth editable line
 * changed. The issue's shape: a single-hunk modification, one line in fifty.
 */
export function buildMarkdownDiffFixture(spec: MarkdownDiffFixtureSpec): MarkdownDiffFixture {
  const oldSource = generateMarkdownDocument(spec);
  // Logical lines: the element a trailing newline splits off is not a line.
  const oldLines = oldSource.slice(0, -1).split("\n");
  const newLines = oldLines.map((line, index) =>
    index % EDIT_EVERY_LINES === EDIT_EVERY_LINES / 2 && editable(line) ? edit(line) : line
  );
  const body: string[] = [];
  let editedLines = 0;
  for (let index = 0; index < oldLines.length; index++) {
    const before = oldLines[index]!;
    const after = newLines[index]!;
    if (before === after) {
      body.push(` ${before}`);
      continue;
    }
    editedLines++;
    body.push(`-${before}`, `+${after}`);
  }
  const path = `docs/${spec.label}.md`;
  const diff = [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...body,
  ].join("\n");
  const newSource = `${newLines.join("\n")}\n`;
  return {
    spec,
    input: { diff, newSource, status: "modified" },
    sourceBytes: Buffer.byteLength(newSource),
    sourceLines: newLines.length,
    patchBytes: Buffer.byteLength(diff),
    editedLines,
  };
}
