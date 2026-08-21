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
 * module reproduces the exact same output shape with single-pass algorithms
 * and structural sharing (safe: every downstream phase, including the
 * library's own `pickRanges`/`markEdits` enhancers, copies nodes instead of
 * mutating them). Edit detection stays on the library's enhancers so ranking
 * semantics can't drift — only the tree plumbing is reimplemented.
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

function toText(changes: ChangeData[], computeLineNumber: (change: ChangeData) => number): string {
  if (changes.length === 0) return "";
  // Mirrors the library: lines run from 1 to the LAST change's line number,
  // with gaps (context outside hunks) filled by empty strings so absolute
  // line numbers in edit ranges stay aligned.
  const maxLineNumber = computeLineNumber(changes[changes.length - 1]!);
  const byLine = new Array<string>(maxLineNumber).fill("");
  for (const change of changes) {
    const lineNumber = computeLineNumber(change);
    // Out-of-range line numbers (malformed/unordered hunks) are dropped, as
    // the library's fixed-length 1..maxLineNumber mapping does.
    if (lineNumber >= 1 && lineNumber <= maxLineNumber) {
      byLine[lineNumber - 1] = change.content;
    }
  }
  return byLine.join("\n");
}

function toTextPair(hunks: HunkData[]): [string, string] {
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
  return [toText(oldChanges, computeOldLineNumber), toText(newChanges, computeNewLineNumber)];
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
  const [oldText, newText] = toTextPair(hunks);
  const toChildren = options.highlight
    ? (text: string) => options.refractor.highlight(text, options.language)
    : (text: string): TokenNode[] => [{ type: "text", value: text }];

  const enhancers = options.enhancers ?? [];
  if (enhancers.length === 0) {
    return {
      old: splitTreeToLines(toChildren(oldText)),
      new: splitTreeToLines(toChildren(newText)),
    };
  }

  const pair: [TokenPath[][], TokenPath[][]] = [
    nodesToLines(toChildren(oldText)),
    nodesToLines(toChildren(newText)),
  ];
  const [oldEnhanced, newEnhanced] = enhancers.reduce((input, enhance) => enhance(input), pair);

  return {
    old: oldEnhanced.map(backToTreeChildren),
    new: newEnhanced.map(backToTreeChildren),
  };
}
