import { useLayoutEffect, useRef, useState } from "react";
import { useToolbarRoving } from "@/hooks/useToolbarRoving";
import { Check, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

let measureContext: CanvasRenderingContext2D | null = null;

function measureTextWidth(text: string, font: string): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return text.length * 8;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/**
 * Width-fitted middle truncation: keeps as many characters from the front and
 * the back as actually fit the element, collapsing the middle with a single
 * ellipsis. The basename is reserved first so the file name always survives.
 * Re-fits on resize; measurement uses canvas measureText with the element's
 * own computed font, so no layout thrash.
 */
function useFittedPath(fullText: string | undefined): {
  spanRef: React.RefObject<HTMLElement | null>;
  display: string | undefined;
} {
  const spanRef = useRef<HTMLElement | null>(null);
  const [display, setDisplay] = useState<string | undefined>(fullText);

  useLayoutEffect(() => {
    const el = spanRef.current;
    if (!el || fullText === undefined) {
      setDisplay(fullText);
      return;
    }

    const fit = () => {
      const style = getComputedStyle(el);
      const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const available =
        el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (available <= 0) {
        // Not measurable (hidden/zero-width): show the new text rather than a
        // stale fit of the previous path; CSS truncate is the backstop.
        setDisplay(fullText);
        return;
      }
      if (measureTextWidth(fullText, font) <= available) {
        setDisplay(fullText);
        return;
      }
      const slashIdx = fullText.lastIndexOf("/");
      const basename = slashIdx >= 0 ? fullText.slice(slashIdx) : fullText;
      const head = fullText.slice(0, fullText.length - basename.length);
      const build = (kept: number) => {
        const front = Math.ceil(kept / 2);
        const back = kept - front;
        return `${head.slice(0, front)}…${back > 0 ? head.slice(head.length - back) : ""}${basename}`;
      };
      // Binary search the most head characters that still fit.
      let lo = 0;
      let hi = head.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (measureTextWidth(build(mid), font) <= available) lo = mid;
        else hi = mid - 1;
      }
      const candidate = build(lo);
      if (measureTextWidth(candidate, font) <= available) {
        setDisplay(candidate);
        return;
      }
      // Very narrow pane: prefer the bare file name over "…/file.md"; if even
      // that overflows, CSS truncate is the backstop.
      const bare = basename.startsWith("/") ? basename.slice(1) : basename;
      setDisplay(measureTextWidth(`…${basename}`, font) <= available ? `…${basename}` : bare);
    };

    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fullText]);

  return { spanRef, display };
}

/**
 * One icon size for every control in this toolbar family, so the four panels
 * that use it (FilePane, DiffPane, and the file browser's two header rows)
 * cannot drift apart a pixel at a time.
 *
 * 14px rather than 16: at 16 the glyphs read heavier than the text beside them
 * and Refresh in particular dominated a row it only shares. With the button's
 * `p-1.5` this still leaves a 26px target, above the 24px WCAG 2.5.8 floor.
 *
 * Load-bearing beyond looks: the file browser's tree header hand-rolls its own
 * row to match `Root`'s height so the border under the two halves reads as one
 * continuous line (#11328). Sizing icons per call site is what would let that
 * line break, so the size lives here and callers spread it.
 */
export const TOOLBAR_ICON_CLASS = "h-3.5 w-3.5";

/**
 * The plain-file-viewing toolbar shared by the FilePane panel and the
 * FileViewerModal dialog, so the two surfaces can't drift apart again. Both
 * render the same viewer bodies (CodeViewer/MarkdownViewer/HtmlViewer); this
 * is the chrome above them.
 *
 * Composed rather than config-driven: the two surfaces own materially
 * different state (the dialog has diff modes and an Open-as-panel action the
 * panel has no concept of), so they supply their own children and keep their
 * own handlers. SegmentedToggle stays a separate import for the same reason —
 * the dialog appends a Diff segment the panel never has.
 *
 * None of these primitives take a className. The chrome is deliberately fixed:
 * `toolbar-icon-button` owns the transition/focus/armed-state contract, and a
 * caller-supplied `transition-*` utility would silently replace its transition
 * under tailwind-merge.
 */
/**
 * `label` is required rather than optional: `role="toolbar"` without an
 * accessible name announces as an unnamed container, and a panel with two
 * toolbars on screen would then have two of them. Making it a required prop
 * means the compiler asks every surface which row this is.
 */
function Root({ label, children }: { label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useToolbarRoving(ref);

  return (
    <div
      ref={ref}
      // The APG toolbar pattern: one tab stop for the whole row, Left/Right
      // between its controls. Before this every button here was its own tab
      // stop, so tabbing past a viewer toolbar cost one press per control.
      role="toolbar"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex shrink-0 items-center gap-1.5 border-b border-overlay bg-surface px-2 py-1.5"
    >
      {children}
    </div>
  );
}

/**
 * Path pill — mirrors the browser toolbar's address field. Click copies the
 * absolute path; the middle collapses to fit the available width while the
 * file name always survives. `path` is what's shown (root-relative where the
 * surface can compute it); what gets copied is the caller's business.
 */
function Path({ path, copied, onCopy }: { path?: string; copied: boolean; onCopy: () => void }) {
  const { spanRef, display } = useFittedPath(path);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onCopy}
          aria-label="Copy file path"
          className="relative flex items-center min-w-0 flex-1 group/path"
        >
          {copied ? (
            <Check className="absolute left-2 w-3.5 h-3.5 text-status-success pointer-events-none" />
          ) : (
            <FileText
              aria-hidden="true"
              className="absolute left-2 w-3.5 h-3.5 text-daintree-text/40 pointer-events-none"
            />
          )}
          <span
            ref={spanRef}
            className="w-full pl-7 pr-2 py-1 text-left text-xs font-mono rounded bg-surface-canvas border border-overlay text-text-secondary truncate transition-colors group-hover/path:border-border-strong group-hover/path:text-text-primary"
          >
            {display}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{copied ? "Copied!" : "Click to copy"}</TooltipContent>
    </Tooltip>
  );
}

/** Right-aligned action group; holds the IconButtons. */
function Actions({ children }: { children: React.ReactNode }) {
  return <div className="ml-auto flex items-center gap-1.5 shrink-0">{children}</div>;
}

function IconButton({
  label,
  onClick,
  pressed,
  expanded,
  controls,
  sidebarToggle,
  children,
  "data-testid": testId,
}: {
  label: string;
  onClick: () => void;
  /** Renders the button as a toggle with an `aria-pressed` state. */
  pressed?: boolean;
  /**
   * Renders the button as a disclosure control with `aria-expanded` (show/hide
   * a region), the WAI-ARIA APG pattern for a collapsible sidebar. Mutually
   * exclusive with `pressed` — never set both, so the button carries one role.
   */
  expanded?: boolean;
  /** id of the region a disclosure button controls; omit while that region is unmounted. */
  controls?: string;
  /**
   * Opts the button out of the persistent `toolbar-icon-button` armed chip via
   * `data-sidebar-toggle` (see `toolbar.css`): a sidebar toggle sits in its
   * "on" state almost always, so the icon swap, not a lit background, carries
   * the state.
   */
  sidebarToggle?: boolean;
  children: React.ReactNode;
  "data-testid"?: string;
}) {
  const active = pressed === true || expanded === true;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-pressed={pressed}
          aria-expanded={expanded}
          aria-controls={controls}
          data-sidebar-toggle={sidebarToggle ? "" : undefined}
          data-testid={testId}
          className={cn(
            "toolbar-icon-button p-1.5 rounded",
            active ? "text-text-primary" : "text-text-secondary"
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export const FileViewerToolbar = { Root, Path, Actions, IconButton };
