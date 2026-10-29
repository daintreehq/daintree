import { ChevronRight, Ellipsis } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  componentsOf,
  elementLabel,
  pickedComponent,
  primaryObservation,
  type ComponentView,
  type PickedSelection,
  type SourcePoint,
} from "./selection.js";

/**
 * One definition of "where this element sits", shared by the strip and the
 * drawer.
 *
 * They used to build their own. The strip walked the task scopes and the drawer
 * walked the raw ancestry, so the same selection read `+page.svelte > PricingCard
 * > button "Start Pro"` in one place and `PricingCard > each > button` in the
 * other — different starting points, different lengths, and one of them naming
 * `each`. A Svelte `{#each}` is control flow, not a place: it is not a file you
 * can open and not a thing an agent can be pointed at, so it never earns a crumb.
 *
 * Outermost first, ending at what was picked, which is the direction every
 * breadcrumb in the product runs.
 */
export interface TrailCrumb {
  readonly label: string;
  /** Components carry the file they are written in, once the host found it; the element does not. */
  readonly file: string | null;
  /**
   * Where the component was invoked, as the page reported it — the identity a
   * picked component is matched on. Two nested components can share a label;
   * they cannot share a call site.
   */
  readonly usedAt: SourcePoint | null;
}

/**
 * The route to a selection: the components it was reached through, outermost
 * first, and then the selection itself — the component when one was picked,
 * the element otherwise.
 *
 * A picked component is matched by its id in the page's chain, never by
 * label, since two nested components can share a name. The crumbs inside it
 * are the route the selection was reached THROUGH, not where it is, so they
 * are dropped. A picked component the chain does not name is still what the
 * user picked — but the chain was trimmed from the outside to fit, so every
 * frame that survived is inside it; none of them is above.
 *
 * Split in two because the callers sit differently: the strip has no header,
 * so it shows both to say what is selected at all; the drawer names the
 * selection in its identity block two lines up and shows only what is above.
 *
 * `truncated` is the page's own word that the chain was cut from the outside:
 * a trail that starts mid-app must not read as one that starts at the root.
 */
export function trailFor(selection: PickedSelection): {
  above: TrailCrumb[];
  current: TrailCrumb;
  truncated: boolean;
} {
  // Innermost first, as the page reports it.
  const components = componentsOf(selection);
  const truncated = primaryObservation(selection)?.componentChain.truncated ?? false;
  const picked = pickedComponent(selection);
  const pickedAt =
    picked === null
      ? -1
      : components.findIndex((component) => component.componentId === picked.componentId);
  const outerFrom = picked === null ? 0 : pickedAt === -1 ? components.length : pickedAt + 1;
  const above = components.slice(outerFrom).map(crumbFor).reverse();
  if (picked === null) {
    return {
      above,
      current: { label: elementLabel(primaryObservation(selection)), file: null, usedAt: null },
      truncated,
    };
  }
  return { above, current: crumbFor(pickedAt === -1 ? picked : components[pickedAt]!), truncated };
}

function crumbFor(component: ComponentView): TrailCrumb {
  return {
    label: component.name ?? "component",
    file: component.definedIn?.path ?? null,
    usedAt: component.usedAt,
  };
}

/**
 * Whether a crumb can be selected from the trail: there is a way to select,
 * the page reported where it was invoked, and no component inside it shares
 * that call site (a recursive component, which the page can only select at
 * its innermost).
 */
function selectability(
  crumbs: readonly TrailCrumb[],
  index: number,
  selectionSite: SourcePoint | null,
  canSelect: boolean
): "yes" | "no" | "recursive" {
  const site = crumbs[index]!.usedAt;
  if (!canSelect || site === null) return "no";
  const shared = [...crumbs.slice(index + 1).map((inner) => inner.usedAt), selectionSite].some(
    (inner) =>
      inner !== null &&
      inner.file === site.file &&
      inner.line === site.line &&
      inner.column === site.column
  );
  return shared ? "recursive" : "yes";
}

/** Width the overflow control and its separator take, used before it has been measured. */
const OVERFLOW_FALLBACK_PX = 40;

/**
 * A real breadcrumb: a named `nav` around an `<ol>`, separators hidden from
 * assistive technology, and `aria-current` on the crumb that is actually
 * selected.
 *
 * Given `onSelect`, each crumb above the selection is a button that selects
 * that component — the same move as `⌥↑`, aimed. Clicking the page lands on
 * the innermost thing under the pointer, and the component a request should
 * be about is usually a step or two up; the trail already names those steps,
 * so it is the place to pick one. Those crumbs wear a quiet chip, so which
 * steps can be picked is visible before the pointer finds them; a crumb that
 * can't be picked stays plain text and says why on hover. The selection itself
 * is text: it is where you already are. The drawer hides its current crumb,
 * so it passes that call site as `selectionSite` for the recursion check.
 *
 * A deep chain never shrinks every crumb to a sliver. The trail measures its
 * crumbs at their natural width and folds the OUTER ones — layouts, providers,
 * route wrappers, the least telling part of a chain — into one "More
 * components" menu, keeping the nearest owners and the selection whole. Only
 * when even the nearest owner and the selection don't fit do those two
 * truncate, with their full names a hover or focus away.
 */
export function SelectionTrail({
  crumbs,
  currentIndex,
  currentLabel,
  onSelect,
  selectionSite = null,
  truncated = false,
  density = "drawer",
  currentBadge,
  className,
}: {
  crumbs: readonly TrailCrumb[];
  /**
   * Which crumb is the selection, by position — never by label, since two
   * nested components can share a name. An index past the end (the drawer
   * hides its terminal crumb because the header names it) marks nothing
   * visible and carries `currentLabel` as visually-hidden text instead, so the
   * accessibility tree and the visible identity always agree.
   */
  currentIndex: number;
  currentLabel: string;
  /**
   * Select the component a crumb names. Without it the trail is read-only.
   * `fromMenu` marks a pick from the overflow menu, made while focus sits in
   * a portal outside the surface the trail belongs to.
   */
  onSelect?: (crumb: TrailCrumb, fromMenu?: boolean) => void;
  /** The selection's own call site when it is not among `crumbs`. */
  selectionSite?: SourcePoint | null;
  /** The page cut the chain from the outside; components above the first were never reported. */
  truncated?: boolean;
  /** `strip` sits in a 32px toolbar row, `drawer` in the identity's 20px trail row. */
  density?: "strip" | "drawer";
  /** A kind beside the selection's own crumb — "Component" when one was picked. */
  currentBadge?: string;
  className?: string;
}) {
  const navRef = useRef<HTMLElement | null>(null);
  const measureRef = useRef<HTMLOListElement | null>(null);
  const [hidden, setHidden] = useState(0);
  const shown = currentIndex >= 0 && currentIndex < crumbs.length;
  // The crumbs that can fold away: every one above the selection but the
  // nearest owner, which stays to say what the selection sits in.
  const foldable = Math.max(0, (shown ? currentIndex : crumbs.length) - 1);
  const measureKey = crumbs.map((crumb) => crumb.label).join("\u0000") + `|${currentIndex}`;

  useLayoutEffect(() => {
    const nav = navRef.current;
    const measure = measureRef.current;
    if (!nav || !measure) return;
    const fit = () => {
      const available = nav.clientWidth;
      const widths = Array.from(measure.children, (child) =>
        child instanceof HTMLElement ? child.offsetWidth : 0
      );
      // The last measured child is the overflow control; the rest are crumbs.
      const overflow = widths.pop() ?? OVERFLOW_FALLBACK_PX;
      const gap = 4;
      const total = widths.reduce((sum, width) => sum + width + gap, 0);
      if (total <= available && !truncated) {
        setHidden(0);
        return;
      }
      // Innermost first: the selection, then each owner outward, while it fits.
      let used = overflow + gap;
      let kept = 0;
      for (let index = widths.length - 1; index >= 0; index--) {
        const next = used + widths[index]! + gap;
        // The selection and the nearest owner are kept whatever their width;
        // past them, a crumb only stays if the whole of it fits.
        const mandatory = index >= widths.length - (shown ? 2 : 1);
        if (!mandatory && next > available) break;
        used = next;
        kept++;
      }
      const totalCrumbs = widths.length;
      setHidden(Math.min(foldable, Math.max(0, totalCrumbs - kept)));
    };
    fit();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(fit);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [measureKey, truncated, shown, foldable]);

  // Inside a roving toolbar the row has one tab stop, and the toolbar only
  // re-applies it when it renders itself; a re-fit is this trail's own render.
  // Buttons the fold just mounted join untabbable, and if the stop went with
  // the ones it unmounted, the row gets one back at its start.
  useEffect(() => {
    const toolbar = navRef.current?.closest<HTMLElement>('[role="toolbar"]');
    if (!toolbar || !navRef.current) return;
    for (const button of navRef.current.querySelectorAll<HTMLElement>("button")) {
      if (!button.hasAttribute("tabindex")) button.tabIndex = -1;
    }
    if (toolbar.querySelector('button[tabindex="0"]') === null) {
      toolbar.querySelector<HTMLElement>("button:not([disabled])")?.setAttribute("tabindex", "0");
    }
  }, [hidden, measureKey]);

  if (crumbs.length === 0 && !currentLabel) return null;
  const folded = crumbs.slice(0, hidden);
  const visibleFrom = hidden;
  const strip = density === "strip";
  const showOverflow = folded.length > 0 || truncated;
  const canSelect = onSelect !== undefined;

  return (
    <nav ref={navRef} aria-label="Breadcrumb" className={cn("relative min-w-0", className)}>
      {/* The crumbs at their natural width, never seen, so the fold is measured
          against what each name really takes rather than guessed from its
          length. The last child stands in for the overflow control. */}
      <ol
        ref={measureRef}
        aria-hidden="true"
        className={cn(
          "pointer-events-none invisible absolute left-0 top-0 flex items-center gap-1 whitespace-nowrap",
          strip ? "text-xs" : "text-2xs"
        )}
      >
        {crumbs.map((crumb, index) => (
          <li key={`${crumb.label}-${index}`} className="flex shrink-0 items-center gap-1">
            {index > 0 ? <ChevronRight className="h-3 w-3" /> : null}
            <span className={cn(CRUMB_PAD, index === currentIndex && "font-medium")}>
              {crumb.label}
            </span>
            {index === currentIndex && currentBadge ? (
              <Badge size="xs" tone="outline">
                {currentBadge}
              </Badge>
            ) : null}
          </li>
        ))}
        <li className="flex shrink-0 items-center gap-1">
          <span className={cn("inline-flex", strip ? "h-6 w-6" : "h-5 w-5")} />
          <ChevronRight className="h-3 w-3" />
        </li>
      </ol>
      <ol className="flex min-w-0 items-center gap-1">
        {showOverflow ? (
          <li className="flex shrink-0 items-center gap-1">
            <TrailOverflow
              folded={folded}
              truncated={truncated}
              strip={strip}
              crumbs={crumbs}
              selectionSite={selectionSite}
              onSelect={onSelect}
            />
          </li>
        ) : null}
        {crumbs.slice(visibleFrom).map((crumb, offset) => {
          const index = visibleFrom + offset;
          const last = shown && index === currentIndex;
          const nearest = index === (shown ? currentIndex - 1 : crumbs.length - 1);
          const can = last ? "no" : selectability(crumbs, index, selectionSite, canSelect);
          return (
            <li
              key={`${crumb.label}-${index}`}
              className={cn(
                "flex items-center gap-1",
                // Only the two that are kept whatever their width may shrink.
                last || nearest ? "min-w-0 shrink" : "shrink-0"
              )}
            >
              {index > 0 || showOverflow ? (
                <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0 text-text-secondary" />
              ) : null}
              {last ? (
                <>
                  {/* A control that does nothing, so the full name of a cut
                      selection is a focus away inside the strip's roving
                      order as well as a hover away. */}
                  <TruncatedTooltip content={crumb.label}>
                    <button
                      type="button"
                      aria-disabled="true"
                      aria-current="true"
                      className={cn(
                        "min-w-0 cursor-default truncate rounded-[var(--radius-sm)] text-left font-medium text-text-primary",
                        CRUMB_FOCUS,
                        strip ? "h-6 leading-6" : "h-5 leading-5"
                      )}
                    >
                      {crumb.label}
                    </button>
                  </TruncatedTooltip>
                  {currentBadge ? (
                    <Badge size="xs" tone="outline" className="shrink-0">
                      {currentBadge}
                    </Badge>
                  ) : null}
                </>
              ) : (
                <CrumbDisclosure crumb={crumb} selectable={can}>
                  {/* Every crumb is a control, so its name and file are a focus
                      away for the keyboard; only the pickable ones act. */}
                  <button
                    type="button"
                    {...(can === "yes" ? {} : { "aria-disabled": "true" as const })}
                    className={cn(
                      CRUMB_PAD,
                      "min-w-0 truncate rounded-[var(--radius-sm)] text-left text-text-secondary",
                      CRUMB_FOCUS,
                      strip ? "h-6 leading-6" : "h-5 leading-5",
                      can === "yes"
                        ? // A quiet chip: the step reads as pickable at rest,
                          // without the underline that made the trail a row of
                          // links. The hover lifts both fill and ink.
                          "cursor-pointer bg-overlay-subtle transition-colors duration-150 ease-out hover:bg-overlay-medium hover:text-text-primary"
                        : "cursor-default"
                    )}
                    onClick={() => {
                      if (can === "yes") onSelect?.(crumb);
                    }}
                  >
                    {crumb.label}
                  </button>
                </CrumbDisclosure>
              )}
            </li>
          );
        })}
        {shown ? null : (
          <li className="sr-only" aria-current="true">
            {currentLabel}
          </li>
        )}
      </ol>
    </nav>
  );
}

/** Horizontal padding every crumb carries, chip or not, so the measured width is the rendered one. */
const CRUMB_PAD = "px-1";
const CRUMB_FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary";

/**
 * The outer crumbs the trail had no room for, as a menu: outermost first, the
 * way the trail reads, each one pickable when it could be picked in place. A
 * chain the page cut from the outside says so at the top, so a trail that
 * starts mid-app is never mistaken for one that starts at the root.
 */
function TrailOverflow({
  folded,
  truncated,
  strip,
  crumbs,
  selectionSite,
  onSelect,
}: {
  folded: readonly TrailCrumb[];
  truncated: boolean;
  strip: boolean;
  crumbs: readonly TrailCrumb[];
  selectionSite: SourcePoint | null;
  onSelect: ((crumb: TrailCrumb, fromMenu?: boolean) => void) | undefined;
}) {
  const label =
    folded.length > 0
      ? `${folded.length} more ${folded.length === 1 ? "component" : "components"}`
      : "Earlier components weren't reported";
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={label}
              className={cn(
                "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-text-secondary transition-colors duration-150 ease-out hover:bg-overlay-medium hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary data-[state=open]:bg-overlay-medium data-[state=open]:text-text-primary",
                strip ? "h-6 w-6" : "h-5 w-5"
              )}
            >
              <Ellipsis className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start">
          {label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="min-w-[200px] max-w-[22rem]">
        {truncated ? (
          <DropdownMenuLabel className="font-normal text-text-secondary">
            Earlier components weren&apos;t reported
          </DropdownMenuLabel>
        ) : null}
        {truncated && folded.length > 0 ? <DropdownMenuSeparator /> : null}
        {folded.map((crumb, index) => {
          const can = selectability(crumbs, index, selectionSite, onSelect !== undefined);
          return (
            <DropdownMenuItem
              key={`${crumb.label}-${index}`}
              disabled={can !== "yes"}
              onSelect={() => onSelect?.(crumb, true)}
              className="flex-col items-start gap-0"
            >
              {/* Wrapped, never cut: the menu is where a folded name is read in full. */}
              <span className="max-w-full break-words">{crumb.label}</span>
              <span className="max-w-full font-mono text-3xs text-text-secondary wrap-anywhere">
                {crumb.file ?? "Source file unavailable"}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A crumb's full name and the file its component is written in, on hover and
 * — for a crumb that is a button — on keyboard focus. The name leads: a crumb
 * cut short by a narrow column is unreadable without it, whether or not its
 * file was found.
 */
function CrumbDisclosure({
  crumb,
  selectable,
  children,
}: {
  crumb: TrailCrumb;
  selectable: "yes" | "no" | "recursive";
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">{crumb.label}</span>
          <span className="font-mono text-3xs">{crumb.file ?? "Source file unavailable"}</span>
          {selectable === "recursive" ? (
            <span className="text-3xs">
              Can&apos;t be selected here: a component inside it shares its call site
            </span>
          ) : null}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
