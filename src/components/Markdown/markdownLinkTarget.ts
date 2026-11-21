import type { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

const EMAIL = /^[^\s/:@]+@[^\s/:@]+$/;
// CommonMark decodes backslash escapes and entity references in a destination
// in one pass, so an escaped `\&amp;` stays literal.
const DESTINATION_ESCAPE =
  /\\([!-/:-@[-`{-~])|&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([A-Za-z][A-Za-z\d]{0,31}));/g;

let entityDecoder: HTMLTextAreaElement | null = null;

function codePoint(value: number): string {
  return value === 0 || value > 0x10ffff ? "�" : String.fromCodePoint(value);
}

function namedEntity(match: string): string {
  if (typeof document === "undefined") return match;
  // A textarea's content is text, never markup, and it knows every HTML entity
  // CommonMark does; an unknown name comes back as written.
  entityDecoder ??= document.createElement("textarea");
  entityDecoder.innerHTML = match;
  return entityDecoder.value;
}

function decodeDestination(raw: string): string {
  return raw
    .replace(/^<([\s\S]*)>$/, "$1")
    .replace(
      DESTINATION_ESCAPE,
      (match: string, escaped?: string, decimal?: string, hex?: string, name?: string) => {
        if (escaped !== undefined) return escaped;
        if (decimal !== undefined) return codePoint(Number.parseInt(decimal, 10));
        if (hex !== undefined) return codePoint(Number.parseInt(hex, 16));
        return name !== undefined ? namedEntity(match) : match;
      }
    );
}

/** The destination of a link or image: the URL after its `](`, not one written in its text. */
function destinationOf(state: EditorState, link: SyntaxNode): SyntaxNode | null {
  for (let child = link.firstChild; child; child = child.nextSibling) {
    const mark = child.prevSibling;
    if (child.name === "URL" && mark?.name === "LinkMark") {
      if (state.sliceDoc(mark.from, mark.to) === "(") return child;
    }
  }
  return null;
}

function isLinkOrImage(node: SyntaxNode): boolean {
  return node.name === "Link" || node.name === "Image";
}

/**
 * The href a Markdown `URL` node stands for, as the rendered document would
 * link it, or null when it stands for none. A destination loses its `<…>`,
 * escapes and entities; a URL written in a link's text goes where the link
 * goes; an autolinked address or bare `www.` host gains the scheme remark-gfm
 * gives it.
 */
export function urlNodeHref(state: EditorState, url: SyntaxNode): string | null {
  const parent = url.parent;
  if (parent && isLinkOrImage(parent)) {
    const destination = destinationOf(state, parent);
    return destination ? decodeDestination(state.sliceDoc(destination.from, destination.to)) : null;
  }
  const text = state.sliceDoc(url.from, url.to);
  if (parent?.name === "LinkReference") return decodeDestination(text);
  if (/^www\./i.test(text)) return `http://${text}`;
  if (EMAIL.test(text)) return `mailto:${text}`;
  return text;
}

/** Walk up from the click position to the nearest link node and read its target. */
export function linkTargetAt(view: EditorView, pos: number): string | null {
  const tree = syntaxTree(view.state);
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node) {
    if (node.name === "URL") return urlNodeHref(view.state, node);
    if (isLinkOrImage(node)) {
      const destination = destinationOf(view.state, node);
      return destination ? urlNodeHref(view.state, destination) : null;
    }
    if (node.name === "Autolink") {
      const url = node.getChild("URL");
      return url ? urlNodeHref(view.state, url) : null;
    }
    node = node.parent;
  }
  return null;
}
