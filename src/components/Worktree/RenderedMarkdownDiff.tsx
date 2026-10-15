import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import ReactMarkdown from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import type { Nodes as HastNodes, RootContent as HastContent } from "hast";
import type { GitStatus } from "@shared/types/git";
import {
  MarkdownImageCacheBust,
  useMarkdownRenderPolicy,
} from "@/components/Markdown/markdownRenderPolicy";
import { MARKDOWN_FONT_SIZE_TOKEN } from "@/components/Markdown/MarkdownDocument";
import { MarkdownTableLabelPrefix } from "@/components/Markdown/MarkdownTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { useScopedSelectAll } from "@/hooks/useScopedSelectAll";
import { cn } from "@/lib/utils";
import type { MarkdownFontSize } from "@/store/preferencesStore";
import {
  buildMarkdownDiff,
  type MarkdownBlock,
  type MarkdownBlockChange,
  type MarkdownDiffFailure,
  type TextRange,
} from "./markdownBlockDiff";
import "@/components/Markdown/MarkdownDocument.css";
import "./RenderedMarkdownDiff.css";

/**
 * The rendered-Markdown layout for the diff panel (issue #12171): the document
 * as it reads, with each changed block marked, instead of the source with each
 * changed line marked.
 *
 * There is deliberately no gutter here, and so no line anchors, no per-line
 * open-in-editor and no moved-block markers — a rendered document has no lines
 * for them to attach to. This mode is for reading; the user switches back to
 * Unified or Split to act on a line.
 */

export interface RenderedMarkdownDiffProps {
  /** Raw unified patch text. */
  diff: string;
  /** Whole new-side file from disk; absent for a deleted file. */
  newSource: string | undefined;
  status: GitStatus;
  /** Absolute path of the file, for resolving its relative links and images. */
  filePath: string;
  /** Containment root for daintree-file:// image loads. */
  rootPath: string;
  cacheBust?: string;
  fontSize?: MarkdownFontSize;
  /**
   * Opaque identity of this rendering attempt, echoed back with the verdict.
   * The host derives it from every input the engine consumes, so a verdict can
   * never outlive the inputs that produced it — stamping the patch text alone
   * left a failure applying to a later attempt that shared it.
   */
  attemptKey: string;
  /**
   * Reports whether the engine could build a rendered view from these inputs.
   * The host cannot know in advance — a patch that won't reconstruct looks like
   * any other — so it keeps the segment live and falls back to the source diff
   * on the verdict.
   */
  onVerdict?: (reason: MarkdownDiffFailure | null, forAttempt: string) => void;
  /**
   * How many discrete changes the document holds, so the host can offer a
   * counter and a stepper. A modified pair is ONE change, not two.
   *
   * Reported rather than derived by the host because the host has a patch and
   * this component has the model — and the two disagree by design: a patch hunk
   * is a run of lines, a change here is a block the reader can point at.
   */
  onChangeCount?: (count: number) => void;
}

/**
 * How long a run of untouched blocks may get before it is folded away.
 *
 * A 40-paragraph document with four edits renders 40 paragraphs, and the reader
 * scrolls past screens of prose they have already accepted looking for the next
 * thing to judge — the failure mode every diff tool with a folding affordance
 * exists to avoid. Five is the point where a run stops being context and starts
 * being an obstacle; two blocks stay at each edge because a change reads
 * differently when you cannot see what it follows.
 */
const UNCHANGED_RUN_LIMIT = 5;
const UNCHANGED_CONTEXT = 2;

/** One change the reader can point at, or a run of blocks they can skip. */
type Section =
  | { kind: "change"; index: number; change: MarkdownBlockChange }
  // `blocks` is mutable because `toSections` appends to the run in place as it
  // walks; nothing outside that function touches it.
  | { kind: "unchanged"; id: number; blocks: MarkdownBlock[] };

/**
 * Group the model into the things a reader navigates by.
 *
 * Consecutive untouched blocks collapse into one run so they can be folded as a
 * unit, and everything else takes the next change number. A `modified` pair is
 * one change: it is one edit the reader accepts or rejects, and numbering its
 * halves separately would report twice as many changes as the document has.
 */
function toSections(changes: readonly MarkdownBlockChange[]): {
  sections: Section[];
  changeCount: number;
} {
  const sections: Section[] = [];
  let changeCount = 0;
  let runId = 0;
  for (const change of changes) {
    if (change.kind === "unchanged") {
      const last = sections[sections.length - 1];
      if (last?.kind === "unchanged") {
        last.blocks.push(change.block);
        continue;
      }
      sections.push({ kind: "unchanged", id: runId++, blocks: [change.block] });
      continue;
    }
    sections.push({ kind: "change", index: changeCount++, change });
  }
  return { sections, changeCount };
}

type BlockKind = "unchanged" | "added" | "removed";

const BLOCK_LABEL: Record<BlockKind, string> = {
  unchanged: "",
  added: "Added block:",
  removed: "Removed block:",
};

/** Tells the two tab stops of a changed table apart (see `MarkdownTableLabelPrefix`). */
const TABLE_LABEL_PREFIX: Record<BlockKind, string | undefined> = {
  unchanged: undefined,
  added: "Added",
  removed: "Removed",
};

/**
 * What a marked range is announced as.
 *
 * `<ins>` and `<del>` carry the `insertion` and `deletion` roles, but no
 * mainstream screen reader announces either one in browse mode unless the user
 * has already raised their verbosity. So the elements are for the accessibility
 * tree and this hidden text is for the reader: without it a screen-reader user
 * hears the block-level "Added block" and then the same prose as everywhere
 * else, with no idea which words the agent actually touched.
 */
const RANGE_LABEL: Record<"added" | "removed", string> = {
  added: "Inserted: ",
  removed: "Deleted: ",
};

/**
 * Flatten a hast tree the way the engine flattens mdast, and hand back the text
 * nodes that may carry inline marks.
 *
 * `<pre>` contributes its characters but is never wrapped: the fence body is
 * rendered by `HighlightedCode`, which reads `String(children)` and would
 * stringify an injected element into the code. Raw nodes contribute nothing —
 * `skipHtml` drops them before they render, so counting them would shift every
 * offset after an embedded HTML tag.
 */
function collectTextNodes(tree: HastNodes): {
  text: string;
  entries: Array<{ children: HastContent[]; index: number; start: number; value: string }>;
} {
  let text = "";
  const entries: Array<{
    children: HastContent[];
    index: number;
    start: number;
    value: string;
  }> = [];
  const walk = (node: HastNodes, wrappable: boolean): void => {
    const children = "children" in node ? (node.children as HastContent[] | undefined) : undefined;
    if (!children) return;
    children.forEach((child, index) => {
      if (child.type === "text") {
        // mdast-util-to-hast inserts its own whitespace text nodes to lay out
        // the markup — between list items, around table sections, after a
        // <br>. They carry no source position, and counting them made every
        // list, table, blockquote and task list disagree with the mdast
        // flattening and so lose its inline marks entirely.
        if (!child.position && !/\S/.test(child.value)) return;
        if (wrappable) entries.push({ children, index, start: text.length, value: child.value });
        text += child.value;
        return;
      }
      if (child.type !== "element") return;
      if (child.tagName === "br") {
        text += "\n";
        return;
      }
      walk(child, wrappable && child.tagName !== "pre");
    });
  };
  walk(tree, true);
  return { text, entries };
}

/**
 * Rehype plugin wrapping the given character ranges of a block's visible text.
 *
 * The ranges were measured on the mdast tree, so the plugin re-derives the same
 * string from the hast tree and does nothing unless the two agree. That check
 * is the whole safety story for a handful of constructs whose two
 * representations differ (a GFM footnote reference renders a marker the source
 * tree has no text for): rather than sliding every mark after one of them, the
 * block silently keeps its whole-block treatment, which is still correct.
 */
function inlineRangePlugin(ranges: readonly TextRange[], expectedText: string, kind: BlockKind) {
  return () => (tree: HastNodes) => {
    if (!ranges.length) return;
    const { text, entries } = collectTextNodes(tree);
    if (text !== expectedText) return;
    // hast models a class attribute as a list, not the joined string.
    const className = ["rendered-markdown-diff__inline", `rendered-markdown-diff__inline--${kind}`];
    // Native revision elements rather than styled spans: `<ins>` and `<del>`
    // are what an assistive technology reads as a revision, and a `<span>` with
    // a background is not a revision to anything but a sighted reader.
    const tagName = kind === "removed" ? "del" : "ins";
    const label = RANGE_LABEL[kind === "removed" ? "removed" : "added"];
    // Rebuilt back-to-front within each parent so an earlier splice can't
    // invalidate a later recorded index.
    for (const entry of [...entries].reverse()) {
      const end = entry.start + entry.value.length;
      const overlapping = ranges.filter((range) => range.start < end && range.end > entry.start);
      if (!overlapping.length) continue;
      const replacement: HastContent[] = [];
      let cursor = entry.start;
      for (const range of overlapping) {
        const from = Math.max(range.start, entry.start);
        const to = Math.min(range.end, end);
        if (from > cursor) {
          replacement.push({
            type: "text",
            value: entry.value.slice(cursor - entry.start, from - entry.start),
          });
        }
        replacement.push({
          type: "element",
          tagName,
          properties: { className },
          children: [
            {
              type: "element",
              tagName: "span",
              properties: { className: ["sr-only"] },
              children: [{ type: "text", value: label }],
            },
            { type: "text", value: entry.value.slice(from - entry.start, to - entry.start) },
          ],
        });
        cursor = to;
      }
      if (cursor < end) {
        replacement.push({ type: "text", value: entry.value.slice(cursor - entry.start) });
      }
      entry.children.splice(entry.index, 1, ...replacement);
    }
  };
}

function DiffBlock({
  kind,
  source,
  definitions,
  ranges,
  expectedText,
  whole,
  blockRef,
  tabIndex,
  components,
  urlTransform,
}: {
  kind: BlockKind;
  source: string;
  definitions: string;
  ranges: readonly TextRange[];
  expectedText: string;
  /** Focus target, for the block a fold hands focus to when it opens. */
  blockRef?: React.Ref<HTMLDivElement>;
  tabIndex?: number;
  /**
   * True when the whole block is the change — an insertion or a deletion with
   * no counterpart. False for either half of a substitution, where the block
   * has a partner and only parts of it actually moved.
   */
  whole: boolean;
  components: ReturnType<typeof useMarkdownRenderPolicy>["components"];
  urlTransform: ReturnType<typeof useMarkdownRenderPolicy>["urlTransform"];
}) {
  // Definitions live anywhere in the document but are cited from a block, so a
  // block rendered on its own would lose its link targets. Appended only to the
  // blocks that actually cite one: a footnote definition renders a whole
  // footnote section, so attaching them to every block put one under every
  // paragraph. Two blocks citing different footnotes still mint the same
  // generated ids, which is a cosmetic duplicate rather than a wrong render.
  const content = definitions ? `${source}\n\n${definitions}` : source;
  const rehypePlugins = useMemo<PluggableList>(
    () => (ranges.length ? [inlineRangePlugin(ranges, expectedText, kind)] : []),
    [ranges, expectedText, kind]
  );

  return (
    <div
      ref={blockRef}
      tabIndex={tabIndex}
      className={cn("rendered-markdown-diff__block", `rendered-markdown-diff__block--${kind}`)}
      data-block-kind={kind}
      data-whole={whole ? "true" : "false"}
    >
      {kind !== "unchanged" && <span className="sr-only">{BLOCK_LABEL[kind]}</span>}
      <MarkdownTableLabelPrefix value={TABLE_LABEL_PREFIX[kind]}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={rehypePlugins}
          urlTransform={urlTransform}
          components={components}
          skipHtml
        >
          {content}
        </ReactMarkdown>
      </MarkdownTableLabelPrefix>
    </div>
  );
}

type MarkdownFontStyle = CSSProperties & Record<"--markdown-font-size", string>;

export function RenderedMarkdownDiff({
  diff,
  newSource,
  status,
  filePath,
  rootPath,
  cacheBust,
  fontSize,
  attemptKey,
  onVerdict,
  onChangeCount,
}: RenderedMarkdownDiffProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useScopedSelectAll(rootRef);

  // Reconstruction, parsing and both LCS passes run here and nowhere else. The
  // React Compiler memoizes component output, not synchronous work in a render
  // body, so without this the whole pipeline would re-run on every keystroke
  // that re-renders the panel.
  const result = useMemo(
    () => buildMarkdownDiff({ diff, newSource, status }),
    [diff, newSource, status]
  );

  const reason = result.ok ? null : result.reason;
  useEffect(() => {
    onVerdict?.(reason, attemptKey);
  }, [onVerdict, reason, attemptKey]);

  const { sections, changeCount } = useMemo(
    () => (result.ok ? toSections(result.model.changes) : { sections: [], changeCount: 0 }),
    [result]
  );

  useEffect(() => {
    onChangeCount?.(changeCount);
  }, [onChangeCount, changeCount]);

  // Which folded runs the reader has opened. Keyed by run id rather than index
  // so re-rendering the same document keeps them open; a new document produces
  // a new model and the set is dropped with it.
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<number>>(() => new Set());
  useEffect(() => {
    setExpandedRuns(new Set());
  }, [attemptKey]);
  const expandRun = useCallback((id: number) => {
    setExpandedRuns((current) => new Set(current).add(id));
  }, []);

  // Removed blocks resolve their relative links and images against the current
  // path too. On a rename that is the wrong directory for the old side, and a
  // local image in a removed block shows its current bytes rather than the ones
  // that revision had — the protocol handler reads the working tree, and a
  // historical blob would need an IPC this view deliberately avoids.
  const { components, urlTransform } = useMarkdownRenderPolicy({ filePath, rootPath });

  const fontStyle: MarkdownFontStyle | undefined =
    fontSize === undefined
      ? undefined
      : { "--markdown-font-size": MARKDOWN_FONT_SIZE_TOKEN[fontSize] };

  // The host swaps back to the source diff on the verdict; render nothing in
  // the frame between.
  if (!result.ok) return null;

  if (result.model.identical) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <EmptyState
          variant="zero-data"
          scale="canvas"
          title="No rendered content changes"
          description="The source changed, but the rendered Markdown is the same."
        />
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-testid="rendered-markdown-diff"
      className="rendered-markdown-diff markdown-document prose px-6 py-5"
      style={fontStyle}
    >
      <MarkdownImageCacheBust value={cacheBust}>
        {sections.map((section) =>
          section.kind === "change" ? (
            <div
              key={`change-${section.index}`}
              data-change-index={section.index}
              className="rendered-markdown-diff__change"
            >
              <BlockChange
                change={section.change}
                oldDefinitions={result.model.oldDefinitions}
                newDefinitions={result.model.newDefinitions}
                components={components}
                urlTransform={urlTransform}
              />
            </div>
          ) : (
            <UnchangedRun
              key={`unchanged-${section.id}`}
              blocks={section.blocks}
              definitions={result.model.newDefinitions}
              expanded={expandedRuns.has(section.id)}
              onExpand={() => expandRun(section.id)}
              components={components}
              urlTransform={urlTransform}
            />
          )
        )}
      </MarkdownImageCacheBust>
    </div>
  );
}

/**
 * A run of untouched blocks, folded in the middle once it gets long enough to
 * be an obstacle rather than context.
 *
 * Expanding is one-way on purpose. A reader opens a run to check something and
 * then keeps reading; a control that offers to close it again is a second
 * decision about text they have already accepted, and it would move the change
 * they were heading for back off the screen.
 */
function UnchangedRun({
  blocks,
  definitions,
  expanded,
  onExpand,
  components,
  urlTransform,
}: {
  blocks: readonly MarkdownBlock[];
  /** The new side's reference definitions, for the blocks that cite one. */
  definitions: string;
  expanded: boolean;
  onExpand: () => void;
  components: ReturnType<typeof useMarkdownRenderPolicy>["components"];
  urlTransform: ReturnType<typeof useMarkdownRenderPolicy>["urlTransform"];
}) {
  // The fold unmounts when it opens, which would drop focus on `document.body`
  // and strand a keyboard user in the middle of a long document. Focus goes to
  // the first block the fold just revealed instead — the thing they asked to
  // see.
  const revealedRef = useRef<HTMLDivElement>(null);
  const wasExpanded = useRef(expanded);
  useEffect(() => {
    if (expanded && !wasExpanded.current) revealedRef.current?.focus({ preventScroll: true });
    wasExpanded.current = expanded;
  }, [expanded]);

  const shared = { components, urlTransform, kind: "unchanged" as const, ranges: [], whole: false };
  const render = (block: MarkdownBlock, key: string, reveal = false) => (
    <DiffBlock
      key={key}
      blockRef={reveal ? revealedRef : undefined}
      tabIndex={reveal ? -1 : undefined}
      source={block.source}
      // Every block renders on its own, so one citing `[docs][d]` needs the
      // definition appended or it renders the literal brackets and loses its
      // link. Only the blocks that actually cite one pay for it.
      definitions={block.referenceIds.length ? definitions : ""}
      expectedText={block.text}
      {...shared}
    />
  );

  if (expanded || blocks.length <= UNCHANGED_RUN_LIMIT) {
    return (
      <>
        {blocks.map((block, index) =>
          render(block, `block-${index}`, expanded && index === UNCHANGED_CONTEXT)
        )}
      </>
    );
  }

  const hiddenCount = blocks.length - UNCHANGED_CONTEXT * 2;
  return (
    <>
      {blocks.slice(0, UNCHANGED_CONTEXT).map((block, index) => render(block, `lead-${index}`))}
      <button
        type="button"
        onClick={onExpand}
        className="rendered-markdown-diff__fold"
        aria-expanded={false}
      >
        {/*
          "Expand", not "Show", and "unchanged", not "hidden": the Unified and
          Split layouts of this same panel are one segmented-control click away
          and their hunk expanders already say `Expand N lines` and
          `N unchanged lines hidden`. Same panel, same gesture, same verb.
        */}
        {`Expand ${hiddenCount} unchanged ${hiddenCount === 1 ? "block" : "blocks"}`}
      </button>
      {blocks
        .slice(blocks.length - UNCHANGED_CONTEXT)
        .map((block, index) => render(block, `trail-${index}`))}
    </>
  );
}

/** Keys that scroll a focused table or activate something in it. */
const READER_SCROLL_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  " ",
  "Enter",
]);

/** A table's column spans from its first row, in its viewport's scroll coordinates. */
function columnSpans(viewport: HTMLElement): Array<[left: number, width: number]> {
  const row = viewport.querySelector("tr");
  if (!row) return [];
  return [...row.cells].map((cell) => [cell.offsetLeft, cell.offsetWidth]);
}

/** The leader's scroll offset, as the same point within the same column of the follower. */
function correspondingOffset(leader: HTMLElement, follower: HTMLElement): number {
  const from = columnSpans(leader);
  const to = columnSpans(follower);
  const offset = leader.scrollLeft;
  if (from.length === 0 || from.length !== to.length) return offset;
  const index = from.findIndex(([left, width]) => offset < left + width);
  if (index === -1) return follower.scrollWidth;
  const [left, width] = from[index]!;
  const [targetLeft, targetWidth] = to[index]!;
  return targetLeft + ((offset - left) / Math.max(width, 1)) * targetWidth;
}

/**
 * The two halves of a changed table scroll as one. Each sits in its own
 * viewport, so a reviewer who found the changed column in the removed table
 * would otherwise have to find it again in the added one. Both open on the
 * first change, since that column is what the reader came for.
 *
 * Each viewport follows the other by column rather than by pixel: the edit
 * that made the pair usually changes a column's width, and a shared pixel
 * offset would show two different column boundaries at the left edge. A
 * follower's own scroll event is recognised by the offset it was given and not
 * passed back, so a clamped echo cannot pin the wider half to the narrower
 * one's end.
 */
function useLinkedTableScroll(pairRef: RefObject<HTMLDivElement | null>, contentKey: string) {
  useEffect(() => {
    const pair = pairRef.current;
    if (!pair) return;
    // Only a one-table-per-half pair has an obvious partner for each table.
    const halves = [...pair.children].map((half) =>
      half.querySelectorAll<HTMLElement>(".markdown-table__viewport")
    );
    if (halves.length !== 2 || halves.some((tables) => tables.length !== 1)) return;
    const removed = halves[0]![0]!;
    const added = halves[1]![0]!;

    const echoes = new Map<HTMLElement, number>();
    const follow = (leader: HTMLElement, follower: HTMLElement) => () => {
      if (echoes.get(leader) === leader.scrollLeft) {
        echoes.delete(leader);
        return;
      }
      const before = follower.scrollLeft;
      follower.scrollLeft = correspondingOffset(leader, follower);
      if (follower.scrollLeft !== before) echoes.set(follower, follower.scrollLeft);
    };
    const fromRemoved = follow(removed, added);
    const fromAdded = follow(added, removed);
    removed.addEventListener("scroll", fromRemoved, { passive: true });
    added.addEventListener("scroll", fromAdded, { passive: true });

    // Opens the pair on its first change, re-checked whenever a table or its
    // viewport settles at a new size — the wide layout lands in a later
    // commit, fonts later still, and a narrowing pane can push the change back
    // out — until the reader moves the table themselves. Tab passing through
    // is not that; a scroll or activation key is. The change counts as shown
    // only clear of the edge fades (the viewport's scroll padding); the whole
    // cell is brought in when it fits, otherwise the change itself.
    let readerMoved = false;
    const yieldToReader = () => {
      readerMoved = true;
    };
    const yieldToKey = (event: KeyboardEvent) => {
      if (READER_SCROLL_KEYS.has(event.key)) readerMoved = true;
    };
    const reveal = () => {
      if (readerMoved) return;
      const mark =
        added.querySelector(".rendered-markdown-diff__inline") ??
        removed.querySelector(".rendered-markdown-diff__inline");
      const cell = mark?.closest("td, th");
      if (!mark || !cell) return;
      const viewport = added.contains(mark) ? added : removed;
      const box = viewport.getBoundingClientRect();
      const inset = parseFloat(getComputedStyle(viewport).scrollPaddingLeft) || 0;
      const left = box.left + inset;
      const right = box.right - inset;
      const change = mark.getBoundingClientRect();
      if (change.left >= left && change.right <= right) return;
      const whole = cell.getBoundingClientRect();
      const anchor = whole.width <= right - left ? whole : change;
      viewport.scrollLeft += anchor.left - left;
    };
    const intents = ["wheel", "pointerdown"] as const;
    for (const type of intents) {
      pair.addEventListener(type, yieldToReader, { capture: true, passive: true });
    }
    pair.addEventListener("keydown", yieldToKey, { capture: true, passive: true });
    const layout = new ResizeObserver(reveal);
    for (const viewport of [removed, added]) {
      layout.observe(viewport);
      if (viewport.firstElementChild) layout.observe(viewport.firstElementChild);
    }

    return () => {
      layout.disconnect();
      for (const type of intents) pair.removeEventListener(type, yieldToReader, { capture: true });
      pair.removeEventListener("keydown", yieldToKey, { capture: true });
      removed.removeEventListener("scroll", fromRemoved);
      added.removeEventListener("scroll", fromAdded);
    };
    // Re-linked when the pair's text changes, since the tables may be new
    // nodes; a refresh that changes nothing keeps the reader's position.
  }, [pairRef, contentKey]);
}

function BlockChange({
  change,
  oldDefinitions,
  newDefinitions,
  components,
  urlTransform,
}: {
  change: MarkdownBlockChange;
  oldDefinitions: string;
  newDefinitions: string;
  components: ReturnType<typeof useMarkdownRenderPolicy>["components"];
  urlTransform: ReturnType<typeof useMarkdownRenderPolicy>["urlTransform"];
}) {
  const shared = { components, urlTransform };
  if (change.kind === "modified") {
    return (
      <ModifiedPair
        change={change}
        oldDefinitions={oldDefinitions}
        newDefinitions={newDefinitions}
        {...shared}
      />
    );
  }
  const kind = change.kind === "unchanged" ? "unchanged" : change.kind;
  const definitions = change.block.referenceIds.length
    ? change.kind === "removed"
      ? oldDefinitions
      : newDefinitions
    : "";
  return (
    <DiffBlock
      kind={kind}
      source={change.block.source}
      definitions={definitions}
      ranges={[]}
      expectedText={change.block.text}
      whole={kind !== "unchanged"}
      {...shared}
    />
  );
}

function ModifiedPair({
  change,
  oldDefinitions,
  newDefinitions,
  components,
  urlTransform,
}: {
  change: Extract<MarkdownBlockChange, { kind: "modified" }>;
  oldDefinitions: string;
  newDefinitions: string;
  components: ReturnType<typeof useMarkdownRenderPolicy>["components"];
  urlTransform: ReturnType<typeof useMarkdownRenderPolicy>["urlTransform"];
}) {
  const pairRef = useRef<HTMLDivElement>(null);
  useLinkedTableScroll(pairRef, `${change.old.source}\n${change.new.source}`);
  const shared = { components, urlTransform };
  // Removed then added, GitHub's ordering: the reader sees what the block
  // said before the replacement that follows it.
  return (
    <div ref={pairRef} className="rendered-markdown-diff__pair">
      <DiffBlock
        kind="removed"
        source={change.old.source}
        definitions={change.old.referenceIds.length ? oldDefinitions : ""}
        ranges={change.inline.old}
        expectedText={change.old.text}
        whole={false}
        {...shared}
      />
      <DiffBlock
        kind="added"
        source={change.new.source}
        definitions={change.new.referenceIds.length ? newDefinitions : ""}
        ranges={change.inline.new}
        expectedText={change.new.text}
        whole={false}
        {...shared}
      />
    </div>
  );
}
