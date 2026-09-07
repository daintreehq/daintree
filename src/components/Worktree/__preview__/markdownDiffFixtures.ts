/**
 * Fixtures for the rendered-Markdown diff review harness.
 *
 * Each fixture is a pair of whole documents. The patch between them is built
 * here, at load time, rather than checked in: `RenderedMarkdownDiff` consumes a
 * unified patch plus the new side from disk, so a hand-written patch that drifts
 * from its own document by one line reconstructs into prose that never existed —
 * the exact failure the engine's `source-mismatch` guard is there to catch, and
 * a miserable thing to debug from a screenshot.
 *
 * The documents themselves are deliberately real prose, not lorem: the whole
 * question this harness exists to answer is whether a reader can see which
 * sentences moved, and that is unanswerable against filler text.
 */

/** Longest common subsequence over lines, as index pairs. */
function lineLcs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * A whole-file unified patch with full context in one hunk.
 *
 * Full context rather than the usual three: the engine reverse-applies hunks
 * against the new source and trusts the gaps between them, so a single hunk
 * spanning the file is both the simplest thing to generate correctly and the
 * strictest thing to reconstruct — every line is verified.
 */
export function patchFrom(oldText: string, newText: string, name = "doc.md"): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const anchors = lineLcs(oldLines, newLines);

  const body: string[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  const emitGap = (oldEnd: number, newEnd: number): void => {
    for (; oldCursor < oldEnd; oldCursor++) body.push(`-${oldLines[oldCursor]}`);
    for (; newCursor < newEnd; newCursor++) body.push(`+${newLines[newCursor]}`);
  };
  for (const [oldIndex, newIndex] of anchors) {
    emitGap(oldIndex, newIndex);
    body.push(` ${oldLines[oldIndex]}`);
    oldCursor = oldIndex + 1;
    newCursor = newIndex + 1;
  }
  emitGap(oldLines.length, newLines.length);

  return [
    `diff --git a/${name} b/${name}`,
    `--- a/${name}`,
    `+++ b/${name}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...body,
    "",
  ].join("\n");
}

export interface MarkdownDiffFixture {
  /** What this fixture is here to prove. */
  what: string;
  old: string;
  new: string;
}

/** Twelve paragraphs of untouched prose, so a change has real context around it. */
const TAIL = `It wasn't, really — you can run as many agents as you like. What I kept running out of was my own attention, and that doesn't grow just because you opened more tabs.

And an agent that's waiting on you isn't doing anything. The longer it takes you to notice, the more of your afternoon just disappears.

So this video is really about how I scaled up to a lot of agents, across a lot of projects, and still stay in the loop with all of them — and the free tool I built to let you do the same.

That tool is Daintree, and here's what it does for you: it gives you insight into the status of all your agents, so you're not clicking through a wall of terminal tabs to find out who's doing what. You can pinpoint the ones that need you.

Daintree runs your agents in real terminals, and every terminal shows you whether its agent is working or waiting, and when it's waiting, what it's waiting for. But they're not all in front of you. Some are in other projects, some are tucked away in a worktree you're not looking at.

So you can press Option-Command-O and get the All agents view — everything you're running, across every project, mostly just working and waiting, with the ones waiting on you at the top of each project. You jump to one, answer it, and move on to the next.

That was the main thing Daintree had to solve: how do you jump between a lot of real agents very quickly?

And the agents are still the ones you already use — for me that's Claude Code, Codex and Grok, and a lot of my role now is knowing which one suits a particular task. You'll have your own favourites. Daintree just runs them and watches what they do — the output, the silence, the prompts, the exits — and works out from that whether each agent is working or waiting.`;

export const FIXTURES: Record<string, MarkdownDiffFixture> = {
  /**
   * The complaint case, taken from the screenshot that opened this review: a
   * paragraph rewritten around its surviving clauses. Word marks cover well
   * past half the characters, so the coverage rule throws them all away and the
   * reader gets two walls of text.
   */
  "prose-rewrite": {
    what: "a rewritten paragraph that keeps most of its clauses — the case the coverage rule blanks",
    old: `There are five coding agents running on my machine right now, across a few different projects. And when I started working like this, I thought the hard part was going to be running more agents.

${TAIL}`,
    new: `This is how I'm working now. There are five coding agents running on my machine, across a few different projects, and at any moment I know exactly which one of them needs me. When I was working the old way, I always thought it was all about adding more agents.

${TAIL}`,
  },

  /**
   * The case that already works: a handful of words swapped inside a paragraph
   * the reader can still recognise. This is the must-not-break baseline for any
   * change to the granularity rules.
   */
  "light-edit": {
    what: "a few words swapped — word marks already survive here and must keep surviving",
    old: `That tool is Daintree, and here's what it does for you: it gives you insight into the status of all your agents, so you're not clicking through a wall of terminal tabs to find out who's doing what.

${TAIL}`,
    new: `That tool is Daintree, and here's what it does for you: it gives you a live picture of the status of all your agents, so you're never clicking through a wall of terminal tabs to find out who's doing what.

${TAIL}`,
  },

  /**
   * Structure rather than prose. A heading reworded, a list item edited, one
   * added and one removed, and a blockquote rewritten — the four block types
   * whose marks are most likely to collide with their own layout.
   */
  structure: {
    what: "heading, list items and a blockquote — where inline marks fight block layout",
    old: `## Running the fleet

Daintree keeps a few promises about how your agents behave:

- Every agent runs in a real terminal, not a wrapper.
- The state you see is read from the output, never from the agent's own claims.
- A worktree is created per task, so nothing collides.
- Broadcasting a prompt reaches every selected terminal at once.

> The hard part was never spawning more agents. It was noticing which one had stopped.

${TAIL}`,
    new: `## Running the fleet, in practice

Daintree keeps a few promises about how your agents actually behave:

- Every agent runs in a real terminal, not a wrapper around one.
- The state you see is read from the output, never from the agent's own claims.
- Broadcasting a prompt reaches every selected terminal at once.
- Closing a terminal keeps its scrollback, so you can pick the thread back up.

> The hard part was never spawning more agents. It was noticing, quickly, which one of them had stopped and was waiting on me.

${TAIL}`,
  },

  /**
   * A table cell and a fenced block. Both are places where a text decoration or
   * an injected span would land on top of machinery that owns its own
   * rendering — the grid, and the syntax highlighter.
   */
  "table-and-code": {
    what: "a changed table cell and a changed code fence — marks must not fight the grid or the highlighter",
    old: `| Shortcut | What it does |
| --- | --- |
| Option-Command-O | All agents, every project |
| Option-Command-I | All agents in this project |
| Option-Command-T | New terminal |

Run it like this:

\`\`\`bash
npm run dev -- --project daintree
\`\`\`

${TAIL}`,
    new: `| Shortcut | What it does |
| --- | --- |
| Option-Command-O | Every agent, across every project |
| Option-Command-I | All agents in this project |
| Option-Command-T | New terminal in the current worktree |

Run it like this:

\`\`\`bash
npm run dev -- --project daintree --watch
\`\`\`

${TAIL}`,
  },

  /**
   * Blocks with no partner at all: one paragraph inserted whole, one removed
   * whole. There is no old/new pair to sit them in, so whatever carries the
   * "this is an addition" signal has to work on its own.
   */
  "insert-and-delete": {
    what: "an unpaired insertion and an unpaired deletion — no partner block to lean on",
    old: `There are five coding agents running on my machine right now, across a few different projects.

This paragraph is going away entirely. It said something that stopped being true, and nothing replaced it.

${TAIL}`,
    new: `There are five coding agents running on my machine right now, across a few different projects.

This paragraph is brand new. Nothing in the old document said anything like it, so there is no counterpart for it to be paired against.

${TAIL}`,
  },

  /**
   * The orientation case: a long document with two changes, one near the top
   * and one near the bottom, and nothing but unchanged prose in between.
   */
  sparse: {
    what: "two changes in a long document — the reader has to find them",
    old: `# Multi-agent workflow

There are five coding agents running on my machine right now.

${TAIL}

That's two people, not a universal limit. But their numbers matched the ceiling I kept hitting, and that's why I stopped trying to fix the attention problem by running more agents.`,
    new: `# Multi-agent workflow

There are five coding agents running on my machine as I write this.

${TAIL}

That's two people, not a universal limit. But their numbers matched the ceiling I kept hitting, which is why I stopped trying to fix an attention problem by running more agents.`,
  },
};

export type FixtureName = keyof typeof FIXTURES;
