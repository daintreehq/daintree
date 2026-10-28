import { ChevronRight } from "lucide-react";
import type { ReactElement } from "react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
 */
export function trailFor(selection: PickedSelection): { above: TrailCrumb[]; current: TrailCrumb } {
  // Innermost first, as the page reports it.
  const components = componentsOf(selection);
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
    };
  }
  return { above, current: crumbFor(pickedAt === -1 ? picked : components[pickedAt]!) };
}

function crumbFor(component: ComponentView): TrailCrumb {
  return {
    label: component.name ?? "component",
    file: component.definedIn?.path ?? null,
    usedAt: component.usedAt,
  };
}

/**
 * A real breadcrumb: a named `nav` around an `<ol>`, separators hidden from
 * assistive technology, and `aria-current` on the crumb that is actually
 * selected.
 *
 * Given `onSelect`, each crumb above the selection is a button that selects
 * that component — the same move as `⌥↑`, aimed. Clicking the page lands on
 * the innermost thing under the pointer, and the component a request should
 * be about is usually a step or two up; the trail already names those steps,
 * so it is the place to pick one. The selection itself is text: it is where
 * you already are. So is a crumb that shares its call site with one inside it
 * (a recursive component): the page can only select the innermost of those,
 * which is not the one the crumb names. The drawer hides its current crumb,
 * so it passes that call site as `selectionSite` for the same check.
 */
export function SelectionTrail({
  crumbs,
  currentIndex,
  currentLabel,
  onSelect,
  selectionSite = null,
  className,
  itemClassName,
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
  /** Select the component a crumb names. Without it the trail is read-only. */
  onSelect?: (crumb: TrailCrumb) => void;
  /** The selection's own call site when it is not among `crumbs`. */
  selectionSite?: SourcePoint | null;
  className?: string;
  itemClassName?: string;
}) {
  if (crumbs.length === 0 && !currentLabel) return null;
  const shown = currentIndex >= 0 && currentIndex < crumbs.length;
  return (
    <nav aria-label="Breadcrumb" className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 items-center gap-1">
        {crumbs.map((crumb, index) => {
          const last = shown && index === currentIndex;
          const site = crumb.usedAt;
          const selectable =
            !last &&
            onSelect !== undefined &&
            site !== null &&
            ![...crumbs.slice(index + 1).map((inner) => inner.usedAt), selectionSite].some(
              (inner) =>
                inner !== null &&
                inner !== undefined &&
                inner.file === site.file &&
                inner.line === site.line &&
                inner.column === site.column
            );
          return (
            <li
              key={`${crumb.label}-${index}`}
              className={cn("flex min-w-0 shrink items-center gap-1", itemClassName)}
            >
              {index > 0 ? (
                <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0 text-text-secondary" />
              ) : null}
              <CrumbFile file={crumb.file}>
                {selectable ? (
                  <button
                    type="button"
                    // Reads as the text it replaces until pointed at: the trail is
                    // a sentence first and a row of controls second. A hover lift
                    // to the primary ink is the whole affordance — an underline
                    // on every step made the strip read as a row of links.
                    className="min-w-0 cursor-pointer truncate rounded-xs text-left transition-colors duration-150 ease-out hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
                    onClick={() => onSelect(crumb)}
                  >
                    {crumb.label}
                  </button>
                ) : (
                  <span
                    {...(last ? { "aria-current": "true" as const } : {})}
                    className={cn("truncate", last && "font-medium text-text-primary")}
                  >
                    {crumb.label}
                  </span>
                )}
              </CrumbFile>
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

/**
 * Names the file a crumb's component is written in. The shared tooltip rather
 * than a native title, so it opens on keyboard focus for a crumb that is a
 * button and matches every other disclosure in the drawer.
 */
function CrumbFile({ file, children }: { file: string | null; children: ReactElement }) {
  if (!file) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        {file}
      </TooltipContent>
    </Tooltip>
  );
}
