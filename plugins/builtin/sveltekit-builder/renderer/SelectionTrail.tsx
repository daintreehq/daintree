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
  current,
  className,
  itemClassName,
}: {
  crumbs: readonly TrailCrumb[];
  /**
   * What is actually selected. Required, and deliberately not defaulted to the
   * last crumb: the drawer hides the terminal crumb because its header already
   * names the element, and marking whatever is left as `aria-current` told
   * screen readers the parent component was the selection. When the selected
   * crumb is not displayed it is carried as visually-hidden text, so the
   * accessibility tree and the visible identity always agree.
   */
  current: string;
  className?: string;
  itemClassName?: string;
}) {
  const shown = crumbs.some((crumb) => crumb.label === current);
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="Selection" className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 items-center gap-1">
        {crumbs.map((crumb, index) => {
          const last = shown && crumb.label === current;
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
            {current}
          </li>
        )}
      </ol>
    </nav>
  );
}
