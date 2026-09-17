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
}

/**
 * The components this element was reached through, outermost first.
 *
 * `includeSelf` because the two callers sit differently: the strip has no
 * header, so its trail has to end at the element to say what is selected at
 * all; the drawer names the element in its identity block two lines above, and
 * repeating it as the terminal crumb just says the same thing twice.
 */
export function trailFor(node: SelectedNode, { includeSelf = true } = {}): TrailCrumb[] {
  const components: TrailCrumb[] = [];
  for (const entry of node.ancestry) {
    if (!isNamedComponent(entry)) continue;
    components.push({ label: entry.componentTag, file: entry.location.file });
  }
  components.reverse();
  return includeSelf ? [...components, { label: elementLabel(node), file: null }] : components;
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
 * selected. Crumbs are not links here — the trail reports where the selection
 * sits, and walking it is the page's job (`⌥↑`), not a click target that would
 * silently retarget a half-written request.
 */
export function SelectionTrail({
  crumbs,
  currentIndex,
  currentLabel,
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
          return (
            <li
              key={`${crumb.label}-${index}`}
              className={cn("flex min-w-0 shrink items-center gap-1", itemClassName)}
            >
              {index > 0 ? (
                <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0 text-text-secondary" />
              ) : null}
              <span
                {...(last ? { "aria-current": "true" as const } : {})}
                title={crumb.file ?? undefined}
                className={cn("truncate", last && "font-medium text-text-primary")}
              >
                {crumb.label}
              </span>
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
