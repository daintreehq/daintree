import { cn } from "@/lib/utils";

interface TitleEntityProps {
  /** The verb phrase the title opens with, e.g. `Delete`. */
  action: string;
  /** The entity the action names — the only part allowed to shrink. */
  name: string;
  /** Punctuation after the closing quote. Confirm titles are questions. */
  punctuation?: string;
  className?: string;
}

/**
 * A confirm-dialog title of the form `Delete 'foo'?` where `foo` is a name the
 * app doesn't control — a branch, a path, a project. Long names wrapped the
 * title onto a second line and dragged the header's close button down with it,
 * so the name truncates on its own while the verb and the closing `'?` stay
 * whole: the sentence still reads as a question at every width.
 *
 * Truncation is CSS, not a character budget, so the visible length follows the
 * dialog's actual width, and the full name stays in the DOM — `aria-labelledby`
 * still reads the whole title. Nothing reveals the tail on hover, so use this
 * only where the body names the entity in full; a confirm dialog owes that
 * anyway.
 */
export function TitleEntity({ action, name, punctuation = "?", className }: TitleEntityProps) {
  return (
    // items-center, not items-baseline: an `overflow: hidden` flex item
    // synthesises its baseline from the margin box, which would drop the name
    // below the quotes flanking it. Every part shares one font size here, so
    // centring lands where a baseline would.
    <span className={cn("flex min-w-0 items-center", className)}>
      <span className="shrink-0">{`${action} '`}</span>
      <span className="truncate">{name}</span>
      <span className="shrink-0">{`'${punctuation}`}</span>
    </span>
  );
}
