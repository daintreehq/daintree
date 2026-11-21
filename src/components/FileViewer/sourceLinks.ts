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

// A second press of a double-click selects a word; Shift and Alt extend or
// draw a selection.
function isPlainPress(event: MouseEvent): boolean {
  return event.button === 0 && event.detail <= 1 && !event.shiftKey && !event.altKey;
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
 * click beside a link stays a click. A press that moves or extends with Shift
 * is selecting text and never follows.
 *
 * A link follows on its release, not on `click`: CodeMirror's handling of the
 * press can redraw the link (clearing a find match does), and Chromium sends
 * no click once the node pressed is gone. The release is hit-tested afresh,
 * so it finds the redrawn link and notices a pointer that slid off its edge.
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
        // The offset a press holds names a different link once the text moves.
        if (update.docChanged) this.press = null;
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
              if (node.from < last) return false;
              const href = urlNodeHref(state, node.node);
              if (href !== null && policy.canFollow(href)) {
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

      onRelease = (event: MouseEvent) => {
        const press = this.press;
        this.press = null;
        this.stopTracking();
        if (!press || press.moved || !isPlainPress(event)) return;
        const link = linkUnder(this.view, event.target);
        if (!link || link.from !== press.linkFrom) return;
        const href = urlNodeHref(this.view.state, link);
        if (href !== null && policy.canFollow(href)) policy.follow(href);
      };

      stopTracking() {
        this.doc.removeEventListener("mousemove", this.onMove, true);
        this.doc.removeEventListener("mouseup", this.onRelease, true);
      }

      begin(event: MouseEvent) {
        this.stopTracking();
        this.press = null;
        if (!isPlainPress(event)) return;
        const link = linkUnder(this.view, event.target);
        if (!link) return;
        this.press = { linkFrom: link.from, x: event.clientX, y: event.clientY, moved: false };
        this.doc.addEventListener("mousemove", this.onMove, true);
        this.doc.addEventListener("mouseup", this.onRelease, true);
      }

      destroy() {
        this.stopTracking();
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
    }
  );
  return [plugin, EditorView.baseTheme({ [`.${LINK_CLASS}`]: { cursor: "pointer" } })];
}
