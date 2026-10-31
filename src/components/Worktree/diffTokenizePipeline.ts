import { computeNewLineNumber, computeOldLineNumber, isDelete, isNormal } from "react-diff-view";
import type {
  ChangeData,
  HunkData,
  HunkTokens,
  TokenNode,
  TokenPath,
  TokenizeEnhancer,
} from "react-diff-view";

/**
 * Linear-time replacement for react-diff-view's `tokenize` plumbing. The
 * library's `normalizeToLines` rebuilds its whole accumulator with spreads per
 * token path (O(paths²)) and its `backToTree` runs a lodash deep-equal per
 * attached node, which together dominate tokenize cost on large diffs. This
 * module reproduces the same tokens for every line the hunks carry with
 * single-pass algorithms and structural sharing (safe: every downstream phase,
 * including the library's own `pickRanges`/`markEdits` enhancers, copies nodes
 * instead of mutating them). Unlike the library it lexes only those lines and
 * leaves every other absolute line a hole, so lexing, enhancing and cloning
 * follow the size of the diff and depth in the file costs one hole per line.
 * Edit detection stays on the library's enhancers so ranking semantics can't
 * drift — only the tree plumbing is reimplemented.
 */

export interface RefractorLike {
  highlight: (code: string, language: string) => TokenNode[];
}

export interface FastTokenizeOptions {
  highlight: boolean;
  refractor: RefractorLike;
  language: string;
  enhancers?: TokenizeEnhancer[];
}

/**
 * Blank lines lexed in place of a gap between two lines a side carries.
 *
 * The library lexes one empty line per absolute line above and between the
 * hunks, so a one-line change at line 100,000 cost 100,000 lexed, split,
 * enhanced and cloned lines. Gaps up to this bound lex byte-for-byte as
 * before; a longer run of blank lines is shortened to it and still reads as a
 * line break and a blank line. The one shipped rule with a bounded quantifier
 * that can consume a run of bare newlines, C++'s raw-string delimiter, spans
 * at most 16 characters, so it can't tell a shortened run from the original
 * (C's character literal is bounded too, but needs a backslash before each
 * newline, so blank filler never reaches it). PHP's heredoc delimiter can,
 * by comparing two newline-spanning runs through a backreference, which no
 * valid PHP produces.
 */
export const MAX_GAP_FILLER_LINES = 16;

const MAX_ARRAY_LENGTH = 2 ** 32 - 1;

interface SideText {
  text: string;
  /** For each line of `text`, the absolute line index it lexes, or -1 for gap filler. */
  sources: number[];
  /** The tree's length: one slot per absolute line up to the LAST change's line. */
  length: number;
}

const EMPTY_SIDE: SideText = { text: "", sources: [], length: 1 };

function toSideText(
  changes: ChangeData[],
  computeLineNumber: (change: ChangeData) => number
): SideText {
  if (changes.length === 0) return EMPTY_SIDE;
  // Mirrors the library: lines run from 1 to the LAST change's line number,
  // so absolute line numbers in edit ranges stay aligned. A non-number (which
  // parseDiff and the expansion helpers never produce) leaves the side empty;
  // a number that is not a valid length throws, as the `new Array(lastLine)`
  // this replaced did, and runDiffTokenize turns that into a null pass.
  const lastLine: unknown = computeLineNumber(changes[changes.length - 1]!);
  if (typeof lastLine !== "number") return EMPTY_SIDE;
  if (!Number.isInteger(lastLine) || lastLine < 0 || lastLine > MAX_ARRAY_LENGTH) {
    throw new RangeError(`Invalid last line number: ${lastLine}`);
  }
  const byLine = new Map<number, string>();
  for (const change of changes) {
    const lineNumber = computeLineNumber(change);
    // Out-of-range line numbers (malformed/unordered hunks) are dropped, as
    // the library's fixed-length 1..lastLine mapping does; a later change on
    // the same line wins, as it did there.
    if (Number.isInteger(lineNumber) && lineNumber >= 1 && lineNumber <= lastLine) {
      byLine.set(lineNumber, change.content);
    }
  }

  const present = [...byLine.keys()].sort((a, b) => a - b);
  const lines: string[] = [];
  const sources: number[] = [];
  let previous = 0;
  for (const lineNumber of present) {
    const filler = Math.min(lineNumber - previous - 1, MAX_GAP_FILLER_LINES);
    for (let i = 0; i < filler; i += 1) {
      lines.push("");
      sources.push(-1);
    }
    lines.push(byLine.get(lineNumber)!);
    sources.push(lineNumber - 1);
    previous = lineNumber;
  }
  return { text: lines.join("\n"), sources, length: Math.max(lastLine, 1) };
}

/**
 * Place each lexed line at its absolute index. Gap filler and every line no
 * hunk carries stay holes: react-diff-view only reads `tokens[side][line - 1]`
 * for rendered changes, every enhancer walks lines with `.map` (which skips
 * holes), and structured clone writes a holey array in its sparse form. An
 * unrendered line still costs a slot per array and a step per `.map`, which
 * is pointer-sized work rather than a lexed, split, cloned and retained entry.
 */
function scatter<T>(lexed: T[], side: SideText): T[] {
  const out = new Array<T>(side.length);
  const { sources } = side;
  const count = Math.min(sources.length, lexed.length);
  for (let i = 0; i < count; i += 1) {
    const at = sources[i]!;
    if (at >= 0) out[at] = lexed[i]!;
  }
  return out;
}

function toSidePair(hunks: HunkData[]): [SideText, SideText] {
  const oldChanges: ChangeData[] = [];
  const newChanges: ChangeData[] = [];
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      if (isNormal(change)) {
        oldChanges.push(change);
        newChanges.push(change);
      } else if (isDelete(change)) {
        oldChanges.push(change);
      } else {
        newChanges.push(change);
      }
    }
  }
  return [
    toSideText(oldChanges, computeOldLineNumber),
    toSideText(newChanges, computeNewLineNumber),
  ];
}

function stripChildren(node: TokenNode): TokenNode {
  const { children: _omit, ...interior } = node;
  return interior;
}

function appendPath(line: TokenPath[], ancestors: TokenNode[], leaf: TokenNode): void {
  const depth = ancestors.length;
  if (depth === 0) {
    line.push([leaf]);
    return;
  }
  const path = new Array<TokenNode>(depth + 1) as TokenPath;
  for (let i = 0; i < depth; i += 1) path[i] = ancestors[i]!;
  path[depth] = leaf;
  line.push(path);
}

/**
 * Flatten a highlight tree straight into per-line token paths.
 *
 * Fusing the tree walk with the newline split is what keeps this cheap: the
 * separate collect-then-split shape it replaced materialised one path array
 * per leaf, then re-sliced a second array for every leaf whose value spanned
 * lines. On a review-sized diff that is tens of thousands of throwaway arrays,
 * and the GC bill for them showed up as the single largest slice of tokenize
 * CPU. Output is identical, path for path.
 */
function nodesToLines(children: TokenNode[]): TokenPath[][] {
  const lines: TokenPath[][] = [];
  const ancestors: TokenNode[] = [];
  let current: TokenPath[] = [];

  const walk = (node: TokenNode): void => {
    const kids = node.children;
    if (kids) {
      ancestors.push(stripChildren(node));
      for (const child of kids) walk(child);
      ancestors.pop();
      return;
    }

    const value = node.value;
    if (typeof value !== "string") {
      throw new Error(`Invalid token path with leaf of type ${node.type}`);
    }

    let newlineAt = value.indexOf("\n");
    if (newlineAt === -1) {
      appendPath(current, ancestors, node);
      return;
    }

    let start = 0;
    for (;;) {
      const segment = newlineAt === -1 ? value.slice(start) : value.slice(start, newlineAt);
      appendPath(current, ancestors, { ...node, value: segment });
      if (newlineAt === -1) return;
      lines.push(current);
      current = [];
      start = newlineAt + 1;
      newlineAt = value.indexOf("\n", start);
    }
  };

  for (const child of children) walk(child);
  lines.push(current);
  return lines;
}

function backToTreeChildren(pathList: TokenPath[]): TokenNode[] {
  const rootChildren: TokenNode[] = [];
  for (const path of pathList) {
    let siblings = rootChildren;
    const leafIndex = path.length - 1;
    for (let i = 0; i <= leafIndex; i += 1) {
      const node = path[i]!;
      const previous = siblings[siblings.length - 1];
      if (i === leafIndex) {
        // Only adjacent text leaves merge — non-text siblings always carry
        // differing accumulated children, which the library's deep-equal
        // mergeability check likewise never unifies.
        if (previous && previous.type === "text" && node.type === "text") {
          siblings[siblings.length - 1] = {
            ...previous,
            value: `${previous.value ?? ""}${node.value ?? ""}`,
          };
        } else {
          siblings.push({ ...node });
        }
      } else {
        const attached: TokenNode = { ...node, children: [] };
        siblings.push(attached);
        siblings = attached.children!;
      }
    }
  }
  return rootChildren;
}

/**
 * Fused equivalent of `backToTreeChildren(nodesToLines(children))` for the
 * enhancer-less pass (the over-budget large-diff path skips markEdits
 * entirely). Splits the highlight tree straight into per-line node arrays
 * without materialising the intermediate token paths, byte-for-byte matching
 * the two-phase output: one fresh interior chain per leaf, adjacent top-level
 * text leaves merged.
 */
function splitTreeToLines(children: TokenNode[]): TokenNode[][] {
  const lines: TokenNode[][] = [];
  const ancestors: TokenNode[] = [];
  let current: TokenNode[] = [];

  const emit = (leaf: TokenNode): void => {
    if (ancestors.length === 0) {
      const previous = current[current.length - 1];
      if (previous && previous.type === "text" && leaf.type === "text") {
        current[current.length - 1] = {
          ...previous,
          value: `${previous.value ?? ""}${leaf.value ?? ""}`,
        };
        return;
      }
      current.push({ ...leaf });
      return;
    }
    let siblings = current;
    for (const ancestor of ancestors) {
      const attached: TokenNode = { ...ancestor, children: [] };
      siblings.push(attached);
      siblings = attached.children!;
    }
    siblings.push({ ...leaf });
  };

  const walk = (node: TokenNode): void => {
    const kids = node.children;
    if (kids) {
      ancestors.push(stripChildren(node));
      for (const child of kids) walk(child);
      ancestors.pop();
      return;
    }
    const value = node.value;
    if (typeof value !== "string") {
      throw new Error(`Invalid token path with leaf of type ${node.type}`);
    }
    let newlineAt = value.indexOf("\n");
    if (newlineAt === -1) {
      emit(node);
      return;
    }
    let start = 0;
    for (;;) {
      const segment = newlineAt === -1 ? value.slice(start) : value.slice(start, newlineAt);
      emit({ ...node, value: segment });
      if (newlineAt === -1) return;
      lines.push(current);
      current = [];
      start = newlineAt + 1;
      newlineAt = value.indexOf("\n", start);
    }
  };

  for (const child of children) walk(child);
  lines.push(current);
  return lines;
}

export function tokenizeFast(hunks: HunkData[], options: FastTokenizeOptions): HunkTokens {
  const [oldSide, newSide] = toSidePair(hunks);
  const toChildren = options.highlight
    ? (text: string) => options.refractor.highlight(text, options.language)
    : (text: string): TokenNode[] => [{ type: "text", value: text }];

  const enhancers = options.enhancers ?? [];
  if (enhancers.length === 0) {
    return {
      old: scatter(splitTreeToLines(toChildren(oldSide.text)), oldSide),
      new: scatter(splitTreeToLines(toChildren(newSide.text)), newSide),
    };
  }

  const pair: [TokenPath[][], TokenPath[][]] = [
    scatter(nodesToLines(toChildren(oldSide.text)), oldSide),
    scatter(nodesToLines(toChildren(newSide.text)), newSide),
  ];
  const [oldEnhanced, newEnhanced] = enhancers.reduce((input, enhance) => enhance(input), pair);

  return {
    old: rebuildTrees(oldEnhanced, oldSide),
    new: rebuildTrees(newEnhanced, newSide),
  };
}

/** `backToTreeChildren` over the lines the side carries, without walking its holes. */
function rebuildTrees(enhanced: TokenPath[][], side: SideText): TokenNode[][] {
  const out = new Array<TokenNode[]>(side.length);
  for (const at of side.sources) {
    if (at < 0) continue;
    const line = enhanced[at];
    if (line) out[at] = backToTreeChildren(line);
  }
  return out;
}
