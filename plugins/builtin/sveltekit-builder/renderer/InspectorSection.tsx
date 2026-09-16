import { useId, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The drawer's one section grammar.
 *
 * Before this the drawer was a stack of differently-framed things: the composer
 * in a bordered card, the identity bare, "Edit directly" a native `summary`
 * with a browser triangle, and "Text" and "Classes" plain paragraphs. Four
 * treatments for four peers reads as assembled rather than designed, and it
 * left the two routes a user actually chooses between — edit it yourself, or
 * ask an agent — looking like a card and a footnote.
 *
 * So every block in the drawer is one of these: a header row at a fixed height,
 * an optional right-aligned action, and the body. Collapsible sections use the
 * disclosure contract rather than `details`/`summary`, because the chevron has
 * to be a Lucide glyph on the left like everywhere else in the app, and because
 * the open state is owned by the drawer (it survives picking the next element)
 * rather than by the DOM node.
 */
export function InspectorSection({
  title,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section aria-label={title} className={cn("flex flex-col", className)}>
      <SectionHeader title={title} action={action} />
      <div className={cn("flex flex-col gap-2", bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * A section the user opens and closes. `open` is controlled by the drawer so
 * that picking the next element does not fold away the editor just opened.
 */
export function InspectorDisclosure({
  title,
  open,
  onOpenChange,
  action,
  children,
  className,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const bodyId = useId();
  return (
    <section className={cn("flex flex-col", className)}>
      <div className="flex h-8 shrink-0 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => onOpenChange(!open)}
          className="-ml-1 flex min-w-0 flex-1 items-center gap-1 rounded-[var(--radius-sm)] px-1 py-0.5 text-left text-2xs font-medium tracking-[0.04em] text-text-secondary transition-colors duration-150 ease-out hover:text-text-primary"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "h-3 w-3 shrink-0 transition-transform duration-150 ease-out",
              open && "rotate-90"
            )}
          />
          <span className="truncate uppercase">{title}</span>
        </button>
        {action}
      </div>
      <div id={bodyId} hidden={!open} className="flex flex-col gap-3 pb-1">
        {children}
      </div>
    </section>
  );
}

/**
 * The non-collapsible header. Separate export so `Text` and `Classes` inside an
 * open disclosure can carry the same label treatment without nesting a second
 * disclosure inside the first.
 */
export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex h-7 shrink-0 items-center justify-between gap-2">
      <h3 className="min-w-0 truncate text-2xs font-medium uppercase tracking-[0.04em] text-text-secondary">
        {title}
      </h3>
      {action}
    </div>
  );
}
