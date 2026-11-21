import type { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

const HAS_SCHEME = /^[a-z][a-z\d+.-]*:/i;
// CommonMark lets any ASCII punctuation be backslash-escaped in a destination.
const BACKSLASH_ESCAPE = /\\([!-/:-@[-`{-~])/g;

/**
 * The href a Markdown `URL` node stands for, as the rendered document would
 * link it: a destination loses its `<…>` and its escapes, and an autolinked
 * address or bare `www.` host gains the scheme remark-gfm gives it.
 */
export function urlNodeHref(state: EditorState, url: SyntaxNode): string {
  const text = state.sliceDoc(url.from, url.to);
  const parent = url.parent?.name;
  if (parent === "Link" || parent === "Image" || parent === "LinkReference") {
    return text.replace(/^<([\s\S]*)>$/, "$1").replace(BACKSLASH_ESCAPE, "$1");
  }
  if (HAS_SCHEME.test(text)) return text;
  if (text.includes("@")) return `mailto:${text}`;
  if (/^www\./i.test(text)) return `http://${text}`;
  return text;
}

/** Walk up from the click position to the nearest link node and read its target. */
export function linkTargetAt(view: EditorView, pos: number): string | null {
  const tree = syntaxTree(view.state);
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node) {
    if (node.name === "URL") return urlNodeHref(view.state, node);
    if (node.name === "Link" || node.name === "Image" || node.name === "Autolink") {
      const url = node.getChild("URL");
      return url ? urlNodeHref(view.state, url) : null;
    }
    node = node.parent;
  }
  return null;
}
