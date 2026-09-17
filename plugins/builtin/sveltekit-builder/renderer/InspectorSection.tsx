import { type ComponentType, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The drawer's one section grammar.
 *
 * Before this the drawer was a stack of differently-framed things: the composer
 * in a bordered card, the identity bare, and the project-level reports as plain
 * paragraphs. Different treatments for peers reads as assembled rather than
 * designed.
 *
 * So every block that is not the composer is one of these: a header row at a
 * fixed height, an optional right-aligned action, and the body. The composer
 * itself has no header — it is what the drawer is, not a section of it.
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
 * A section header.
 *
 * There is no collapsible variant. The drawer had one, and it was how the panel
 * came to let the user fold away the only thing it does — see the composer's
 * own note in `SiteBuilderSurfaces`. What is left in here is either a
 * project-level report ("Site source") the user reads and acts on, or nothing.
 */
export function SectionHeader({
  title,
  icon: Icon,
  action,
}: {
  title: string;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-7 shrink-0 items-center justify-between gap-2">
      <h3 className="flex min-w-0 items-center gap-1 text-2xs font-medium uppercase tracking-wide text-text-secondary">
        {Icon ? <Icon className="h-3 w-3 shrink-0" aria-hidden="true" /> : null}
        <span className="truncate">{title}</span>
      </h3>
      {action}
    </div>
  );
}

/**
 * A property row: the inspector's unit of density.
 *
 * Text and Classes were each spending a section header ABOVE their value, so
 * two properties cost four rows and the drawer read as a stacked form. The
 * reference class puts the label in a fixed column beside the control, at a
 * height the eye can count — 28px here — so a dozen properties fit where four
 * did. The label column is 64px: wide enough for "Classes", narrow enough that
 * the control still gets most of a 360px drawer.
 *
 * `align="start"` for a control that grows (a chip wrap, a multi-line field);
 * the label stays pinned to the first line rather than floating mid-block.
 */
export function PropertyRow({
  label,
  htmlFor,
  hint,
  align = "center",
  children,
  className,
}: {
  label: string;
  /** The control's id, when the label names a real form control. */
  htmlFor?: string;
  /** A trailing badge or note beside the label — a capability, a count. */
  hint?: ReactNode;
  align?: "center" | "start";
  children: ReactNode;
  className?: string;
}) {
  const Label = htmlFor ? "label" : "span";
  return (
    <div
      className={cn(
        "grid min-h-7 grid-cols-[64px_minmax(0,1fr)] gap-x-2",
        align === "center" ? "items-center" : "items-start",
        className
      )}
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-1 text-xs text-text-secondary",
          align === "start" && "min-h-7"
        )}
      >
        <Label {...(htmlFor ? { htmlFor } : {})} className="min-w-0 truncate">
          {label}
        </Label>
        {hint}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
    </div>
  );
}
