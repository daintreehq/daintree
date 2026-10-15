import {
  EditorView,
  closeHoverTooltips,
  hasHoverTooltips,
  hoverTooltip,
  type HoverTooltipSource,
  type Rect,
  type Tooltip,
} from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { TOOLTIP_CARD_PADDING } from "@/components/ui/tooltip";
import {
  OVERLAY_SIDE_OFFSET,
  TOOLTIP_PRESS_DISMISSED_MOTION_CLASS,
} from "@/components/ui/overlayMotion";
import { cn } from "@/lib/utils";
import { chipPendingDeleteField } from "./chipBackspace";

/**
 * The one card every chip's hover tooltip paints: `TooltipContent`'s recipe
 * reproduced for CodeMirror, whose tooltips are imperative DOM and cannot
 * mount the Radix component. Entrance only, because CodeMirror removes a hover
 * tooltip on the spot — the same pairing the app uses for a caption whose
 * trigger was pressed. `font-sans` because the card sits inside the editor and
 * would otherwise inherit its monospace face; paths opt back in.
 */
const CHIP_CARD_CLASS = cn(
  "block max-w-xs rounded-[var(--radius-md)] surface-overlay shadow-overlay font-sans text-xs leading-snug text-text-primary",
  TOOLTIP_CARD_PADDING,
  TOOLTIP_PRESS_DISMISSED_MOTION_CLASS
);

/** A line of plain description: what the chip attaches. */
export function chipCardText(text: string): HTMLElement {
  const p = document.createElement("p");
  p.textContent = text;
  return p;
}

/**
 * A full path. It is what most of these cards exist to disclose, so it takes
 * the primary ink, and it wraps between folders rather than inside a name:
 * each segment is one unbreakable run that only splits when it is wider than
 * the card on its own. Left to the line breaker, `quarterly-report-q3.pdf`
 * broke at its hyphen and a clipboard path broke mid-word.
 */
export function chipCardPath(path: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "font-mono";
  for (const part of path.split(/(?<=[/\\])/)) {
    const segment = document.createElement("span");
    segment.className = "inline-block max-w-full whitespace-pre-wrap wrap-anywhere";
    segment.textContent = part;
    p.append(segment);
  }
  return p;
}

/** A secondary fact about the attachment (its size), one step down the ink ramp. */
export function chipCardMeta(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "mt-0.5 text-text-secondary tabular-nums";
  p.textContent = text;
  return p;
}

function chipCard(children: Node[]): HTMLElement {
  const dom = document.createElement("div");
  dom.className = CHIP_CARD_CLASS;
  // The cards open above their chip; the shared slide reads its direction from here.
  dom.dataset.side = "top";
  dom.append(...children);
  return dom;
}

/**
 * Narrow a card to its widest line. A box that wraps keeps the width it was
 * offered, so a path that broke between folders left a column of empty card
 * beside its shorter lines; CSS has no way to shrink a box to wrapped content,
 * so the line boxes are measured once the card is in the document.
 */
function fitToLines(card: HTMLElement): void {
  // Text runs and images only: a block's own box is as wide as the card.
  const rects: DOMRect[] = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof HTMLImageElement) {
      rects.push(node.getBoundingClientRect());
    } else if (node.nodeType === Node.TEXT_NODE) {
      range.selectNodeContents(node);
      rects.push(...range.getClientRects());
    }
  }
  let left = Infinity;
  let right = -Infinity;
  for (const rect of rects) {
    if (rect.width === 0) continue;
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
  }
  if (!Number.isFinite(left)) return;
  const cs = getComputedStyle(card);
  const chrome =
    parseFloat(cs.paddingLeft) +
    parseFloat(cs.paddingRight) +
    parseFloat(cs.borderLeftWidth) +
    parseFloat(cs.borderRightWidth);
  const fitted = Math.ceil(right - left + chrome);
  if (fitted < card.getBoundingClientRect().width) card.style.width = `${fitted}px`;
}

const OFFSCREEN: Rect = { left: 0, right: 0, top: 0, bottom: 0 };

/**
 * The chip's own first line box. CodeMirror anchors a tooltip at
 * `coordsAtPos(pos)`, and for a chip that begins a soft-wrapped row that
 * position resolves to the end of the row above, so the card opened over the
 * previous line, nowhere near the chip it describes.
 */
function chipRect(view: EditorView, from: number, selector: string): Rect | null {
  for (const el of view.contentDOM.querySelectorAll<HTMLElement>(selector)) {
    try {
      if (view.posAtDOM(el) === from) return el.getClientRects()[0] ?? null;
    } catch {
      // A widget detached mid-measure has no position; try the next one.
    }
  }
  return null;
}

/**
 * A chip's hover card: the shared card, opened above the chip whose range is
 * `from`–`to` and whose widget matches `selector`. The card's text doubles as
 * the chip's `aria-description`, so what the card discloses on hover is also
 * what assistive tech reads with the chip.
 */
export function chipTooltip(
  range: { from: number; to: number },
  selector: string,
  content: () => Node[]
): Tooltip {
  return {
    pos: range.from,
    end: range.to,
    above: true,
    create(view) {
      const dom = chipCard(content());
      return {
        dom,
        mount: () => fitToLines(dom),
        // The same gap every Radix tooltip and menu hangs from its trigger.
        offset: { x: 0, y: OVERLAY_SIDE_OFFSET },
        // `pos`, not the range captured at open: CodeMirror maps an open
        // tooltip through edits, and a stale start would find another chip.
        getCoords: (pos) => chipRect(view, pos, selector) ?? view.coordsAtPos(pos) ?? OFFSCREEN,
      };
    },
  };
}

// WCAG 1.4.13: content shown on hover must be dismissible without moving the
// pointer. Escape still reaches the composer's own handler afterwards, so it
// keeps meaning what it means there.
const dismissOnEscape = EditorView.domEventHandlers({
  keydown(event, view) {
    if (event.key === "Escape" && hasHoverTooltips(view.state)) {
      view.dispatch({ effects: closeHoverTooltips });
    }
    return false;
  },
});

/**
 * `hoverTooltip` for a chip kind, with the shared Escape dismissal. No card
 * opens while a chip is staged for deletion: the staged chip is the one thing
 * that moment is about, and a card over it would compete with it.
 */
export function chipHoverTooltip(source: HoverTooltipSource): Extension {
  return [
    hoverTooltip((view, pos, side) =>
      view.state.field(chipPendingDeleteField, false) ? null : source(view, pos, side)
    ),
    dismissOnEscape,
  ];
}
