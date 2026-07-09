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
    byLine[computeLineNumber(change) - 1] = change.content;
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

function collectPaths(node: TokenNode, ancestors: TokenNode[], output: TokenPath[]): void {
  const children = node.children;
  if (children) {
    const { children: _omit, ...interior } = node;
    ancestors.push(interior);
    for (const child of children) {
      collectPaths(child, ancestors, output);
    }
    ancestors.pop();
  } else {
    output.push([...ancestors, node]);
  }
}

function withLeafValue(path: TokenPath, value: string): TokenPath {
  const next = path.slice();
  next[next.length - 1] = { ...path[path.length - 1]!, value };
  return next;
}

function normalizeToLines(children: TokenNode[]): TokenPath[][] {
  const paths: TokenPath[] = [];
  const ancestors: TokenNode[] = [];
  for (const child of children) {
    collectPaths(child, ancestors, paths);
  }

  const lines: TokenPath[][] = [];
  let current: TokenPath[] = [];
  for (const path of paths) {
    const leaf = path[path.length - 1]!;
    const value = leaf.value;
    if (typeof value !== "string") {
      throw new Error(`Invalid token path with leaf of type ${leaf.type}`);
    }
    if (!value.includes("\n")) {
      current.push(path);
      continue;
    }
    const parts = value.split("\n");
    current.push(withLeafValue(path, parts[0]!));
    for (let i = 1; i < parts.length; i += 1) {
      lines.push(current);
      current = [withLeafValue(path, parts[i]!)];
    }
  }
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

export function tokenizeFast(hunks: HunkData[], options: FastTokenizeOptions): HunkTokens {
  const [oldText, newText] = toTextPair(hunks);
  const toChildren = options.highlight
    ? (text: string) => options.refractor.highlight(text, options.language)
    : (text: string): TokenNode[] => [{ type: "text", value: text }];

  const pair: [TokenPath[][], TokenPath[][]] = [
    normalizeToLines(toChildren(oldText)),
    normalizeToLines(toChildren(newText)),
  ];
  const [oldEnhanced, newEnhanced] = (options.enhancers ?? []).reduce(
    (input, enhance) => enhance(input),
    pair
  );

  return {
    old: oldEnhanced.map(backToTreeChildren),
    new: newEnhanced.map(backToTreeChildren),
  };
}
