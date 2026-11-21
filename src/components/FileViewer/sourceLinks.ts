import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type PluginValue,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { urlNodeHref } from "@/components/Markdown/markdownLinkTarget";

export interface SourceLinkPolicy {
  /** Whether a click on this href would go anywhere; only those get a pointer. */
  canFollow: (href: string) => boolean;
  follow: (href: string) => void;
}

const LINK_CLASS = "cm-sourceLink";
const linkMark = Decoration.mark({ class: LINK_CLASS });
// Past this, the press is a drag selecting text, wherever it ends up.
const DRAG_SLOP_PX = 4;

interface Press {
  linkFrom: number;
  x: number;
  y: number;
  moved: boolean;
}

function urlNodeAt(view: EditorView, pos: number): SyntaxNode | null {
  let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1);
  while (node && node.name !== "URL") node = node.parent;
  return node;
}

function linkUnder(view: EditorView, target: EventTarget | null): SyntaxNode | null {
  if (!(target instanceof Element)) return null;
  const mark = target.closest(`.${LINK_CLASS}`);
  if (!mark || !view.contentDOM.contains(mark)) return null;
  return urlNodeAt(view, view.posAtDOM(mark, 0));
}

/**
 * Plain-click links for the read-only Source view of a Markdown file. Only
 * the link's own text is a target, never the caret's nearest position, so a
 * click beside a link stays a click. A press that moves, extends with Shift,
 * or leaves a selection is selecting text and never follows.
 */
export function sourceLinks(policy: SourceLinkPolicy): Extension {
  const plugin = ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: DecorationSet;
      press: Press | null = null;
      private readonly doc: Document;

      constructor(readonly view: EditorView) {
        this.doc = view.dom.ownerDocument;
        this.decorations = this.build();
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        ) {
          this.decorations = this.build();
        }
      }

      build(): DecorationSet {
        const { state } = this.view;
        const builder = new RangeSetBuilder<Decoration>();
        const tree = syntaxTree(state);
        let last = -1;
        for (const { from, to } of this.view.visibleRanges) {
          tree.iterate({
            from,
            to,
            enter: (node) => {
              if (node.name !== "URL") return;
              // A link straddling two visible ranges is met twice.
              if (node.from >= last && policy.canFollow(urlNodeHref(state, node.node))) {
                builder.add(node.from, node.to, linkMark);
                last = node.to;
              }
              return false;
            },
          });
        }
        return builder.finish();
      }

      onMove = (event: MouseEvent) => {
        const press = this.press;
        if (!press) return;
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG_SLOP_PX) {
          press.moved = true;
        }
      };

      onRelease = () => {
        this.doc.removeEventListener("mousemove", this.onMove, true);
        this.doc.removeEventListener("mouseup", this.onRelease, true);
      };

      begin(event: MouseEvent) {
        this.onRelease();
        this.press = null;
        if (event.button !== 0 || event.detail > 1 || event.shiftKey || event.altKey) return;
        const link = linkUnder(this.view, event.target);
        if (!link) return;
        this.press = { linkFrom: link.from, x: event.clientX, y: event.clientY, moved: false };
        this.doc.addEventListener("mousemove", this.onMove, true);
        this.doc.addEventListener("mouseup", this.onRelease, true);
      }

      finish(event: MouseEvent): boolean {
        const press = this.press;
        this.press = null;
        if (!press || press.moved) return false;
        if (event.button !== 0 || event.detail > 1 || event.shiftKey || event.altKey) return false;
        if (!this.view.state.selection.main.empty) return false;
        const link = linkUnder(this.view, event.target);
        if (!link || link.from !== press.linkFrom) return false;
        const href = urlNodeHref(this.view.state, link);
        if (!policy.canFollow(href)) return false;
        event.preventDefault();
        policy.follow(href);
        return true;
      }

      destroy() {
        this.onRelease();
        this.press = null;
      }
    },
    {
      decorations: (value) => value.decorations,
      eventObservers: {
        mousedown(event) {
          this.begin(event);
        },
      },
      eventHandlers: {
        click(event) {
          return this.finish(event);
        },
      },
    }
  );
  return [plugin, EditorView.baseTheme({ [`.${LINK_CLASS}`]: { cursor: "pointer" } })];
}
