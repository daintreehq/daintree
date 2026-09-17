import { ChevronRight } from "lucide-react";
import type { AncestryEntry, SelectedNode } from "../shared/model.js";
import { cn } from "@/lib/utils";

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
  /** Components carry a file; the element itself does not. */
  readonly file: string | null;
  /**
   * Where the component was invoked — the identity a picked component is
   * matched on. Two nested components can share a label; they cannot share a
   * call site.
   */
  readonly usedAt: { file: string; line: number; column: number } | null;
}

/** The component picked on the page, when the selection is one. */
export interface PickedCrumb {
  readonly label: string;
  readonly usedAt: { file: string; line: number; column: number } | null;
}

/**
 * The route to a selection: the components it was reached through, outermost
 * first, and then the selection itself — the component when one was picked,
 * the element otherwise.
 *
 * A picked component is matched by its call site, never by label, since two
 * nested components can share a name; innermost first, which is the order the
 * page itself matches a call site in, so a recursive component invoked from
 * the same line twice names the same invocation here and there. The crumbs
 * inside it are the route the selection was reached THROUGH, not where it is,
 * so they are dropped. A picked call site that is not on the chain at all is
 * still what the user picked — but the chain was trimmed from the outside to
 * fit, so every frame that survived is inside it; none of them is above.
 *
 * Split in two because the callers sit differently: the strip has no header,
 * so it shows both to say what is selected at all; the drawer names the
 * selection in its identity block two lines up and shows only what is above.
 */
export function trailFor(
  node: SelectedNode,
  picked: PickedCrumb | null = null
): { above: TrailCrumb[]; current: TrailCrumb } {
  // Innermost first, as the page reports it. Only a component frame can be
  // the pick, as on the page: a block whose location collides with a call
  // site is control flow, not an invocation.
  const ancestry = node.ancestry;
  const site = picked?.usedAt ?? null;
  const pickedAt =
    site === null
      ? -1
      : ancestry.findIndex(
          (entry) =>
            entry.kind === "component" &&
            entry.location.file === site.file &&
            entry.location.line === site.line &&
            entry.location.column === site.column
        );
  const outerFrom = picked === null ? 0 : pickedAt === -1 ? ancestry.length : pickedAt + 1;
  const above: TrailCrumb[] = [];
  for (const entry of ancestry.slice(outerFrom)) {
    if (isNamedComponent(entry)) above.push(crumbFor(entry));
  }
  above.reverse();
  if (picked === null) {
    return { above, current: { label: elementLabel(node), file: null, usedAt: null } };
  }
  const found = pickedAt === -1 ? undefined : ancestry[pickedAt];
  const current =
    found !== undefined && isNamedComponent(found)
      ? crumbFor(found)
      : { label: picked.label, file: null, usedAt: site };
  return { above, current };
}

function crumbFor(entry: AncestryEntry & { kind: "component"; componentTag: string }): TrailCrumb {
  return {
    label: entry.componentTag,
    file: entry.location.file,
    usedAt: {
      file: entry.location.file,
      line: entry.location.line,
      column: entry.location.column,
    },
  };
}

/** `each`, `if` and `await` frames are control flow; generated frames are not the user's. */
function isNamedComponent(
  entry: AncestryEntry
): entry is AncestryEntry & { kind: "component"; componentTag: string } {
  return entry.kind === "component" && !entry.generated && typeof entry.componentTag === "string";
}

function elementLabel(node: SelectedNode): string {
  return node.label || node.definition?.tagName || "element";
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
  selectionSite?: { file: string; line: number; column: number } | null;
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
              {selectable ? (
                <button
                  type="button"
                  title={crumb.file ?? undefined}
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
                  title={crumb.file ?? undefined}
                  className={cn("truncate", last && "font-medium text-text-primary")}
                >
                  {crumb.label}
                </span>
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
