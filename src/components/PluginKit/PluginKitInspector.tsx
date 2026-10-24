import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";
import type {
  PluginInspectorProps,
  PluginInspectorSectionProps,
  PluginPropertyRowProps,
} from "@shared/types/plugin-sdk-react";
import { Field, FieldLabel } from "@/components/ui/field";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { cn } from "@/lib/utils";
import { fn, hasContent, node, nonEmpty, oneOf, pickRootProps, positive, str } from "./kitProps";

const INSPECTOR_LABEL_DEFAULT_PX = 88;

// The label column is a luxury of a wide inspector: below 240px it costs the
// control most of its room, so the label goes above its value instead.
export function KitInspector({
  children,
  "aria-label": ariaLabel,
  labelWidth,
  className,
  ...rest
}: PluginInspectorProps) {
  const label = nonEmpty(ariaLabel);
  const labelPx = positive(labelWidth, 400) ?? INSPECTOR_LABEL_DEFAULT_PX;
  const style: CSSProperties & Record<`--${string}`, string> = {
    "--kit-inspector-label": `${labelPx}px`,
  };
  return (
    <div
      {...pickRootProps(rest, { aria: true })}
      {...(label ? { role: "region", "aria-label": label } : {})}
      data-inspector=""
      style={style}
      className={cn("@container/inspector flex min-w-0 flex-col", str(className))}
    >
      {node(children)}
    </div>
  );
}

export function KitInspectorSection({
  title,
  children,
  collapsible,
  open,
  defaultOpen,
  onOpenChange,
  actions,
  className,
  ...rest
}: PluginInspectorSectionProps) {
  const baseId = useId();
  const canFold = collapsible !== false;
  const [ownOpen, setOwnOpen] = useState(defaultOpen !== false);
  const isOpen = !canFold || (typeof open === "boolean" ? open : ownOpen);
  const change = fn(onOpenChange);
  const heading = str(title) ?? "";
  const bodyId = `${baseId}body`;
  const headingId = `${baseId}heading`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Folded from outside (a controlled `open`) while a field in it had focus:
  // the hidden field keeps focus until the browser's fixup, so move it to the
  // heading that brings the rows back.
  useLayoutEffect(() => {
    if (isOpen) return;
    const active = document.activeElement;
    if (active !== null && (bodyRef.current?.contains(active) ?? false)) {
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, [isOpen]);
  return (
    <section
      {...pickRootProps(rest)}
      aria-labelledby={headingId}
      data-state={isOpen ? "open" : "closed"}
      className={cn(
        "flex min-w-0 flex-col border-t border-divider first:border-t-0",
        str(className)
      )}
    >
      <div className="flex h-7 shrink-0 items-center gap-1 pr-1.5 pl-3">
        <h3 id={headingId} className="m-0 flex min-w-0 flex-1">
          {canFold ? (
            <button
              ref={triggerRef}
              type="button"
              aria-expanded={isOpen}
              aria-controls={bodyId}
              onClick={() => {
                setOwnOpen(!isOpen);
                change?.(!isOpen);
              }}
              className={cn(
                "-ml-1.5 flex h-6 min-w-0 flex-1 items-center gap-1 rounded-[var(--radius-sm)] pl-1.5 text-left",
                "transition-[background-color] duration-150 ease-out hover:bg-overlay-subtle",
                "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
              )}
            >
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  "h-3 w-3 shrink-0 text-text-secondary transition-transform duration-150 ease-out motion-reduce:transition-none",
                  isOpen && "rotate-90"
                )}
              />
              <span className={cn(SECTION_LABEL_CLASS, "min-w-0 truncate")}>{heading}</span>
            </button>
          ) : (
            <span className={cn(SECTION_LABEL_CLASS, "min-w-0 truncate")}>{heading}</span>
          )}
        </h3>
        {hasContent(actions) ? (
          <div className="flex shrink-0 items-center gap-0.5">{node(actions)}</div>
        ) : null}
      </div>
      {/* Folded, the rows stay mounted and hidden: the heading's control
          target always exists, and a half-edited field keeps its value. */}
      <div
        ref={bodyRef}
        id={bodyId}
        hidden={!isOpen}
        className={cn("min-w-0 flex-col px-3 pb-2", isOpen ? "flex" : "hidden")}
      >
        {node(children)}
      </div>
    </section>
  );
}

// Wide, the label sits in a fixed column beside the value at a 28px row the
// eye can count; narrow (or outside an Inspector), above it.
const PROPERTY_ROW_GRID =
  "grid min-h-7 grid-cols-1 gap-x-2 gap-y-0.5 py-0.5 @[240px]/inspector:grid-cols-[var(--kit-inspector-label,88px)_minmax(0,1fr)] @[240px]/inspector:gap-y-0";

export function KitPropertyRow({
  label,
  children,
  htmlFor,
  hint,
  align,
  className,
  ...rest
}: PluginPropertyRowProps) {
  const top = oneOf(align, ["center", "start"] as const) === "start";
  const text = str(label) ?? "";
  const plain = typeof children === "string" || typeof children === "number";
  const note = hasContent(hint) ? (
    <span className="shrink-0 text-2xs text-text-secondary">{node(hint)}</span>
  ) : null;
  const valueClass = cn(
    "flex min-h-6 min-w-0 items-center gap-1.5 text-xs text-text-primary",
    top && "@[240px]/inspector:items-start"
  );
  const rowClass = cn(PROPERTY_ROW_GRID, top ? "items-start" : "items-center", str(className));
  const labelCell = (labelNode: ReactNode) => (
    <div className={cn("flex min-w-0 items-center gap-1", top && "@[240px]/inspector:min-h-6")}>
      {labelNode}
      {note}
    </div>
  );
  // Read-only text has no control to label: the pair is a term and its value.
  if (plain || !hasContent(children)) {
    return (
      <div {...pickRootProps(rest)} data-property-row="" className={rowClass}>
        {labelCell(<span className="min-w-0 truncate text-xs text-text-secondary">{text}</span>)}
        <div className={cn(valueClass, "select-text")}>
          {hasContent(children) ? (
            <span className="min-w-0 break-words">{node(children)}</span>
          ) : (
            <>
              <span aria-hidden="true" className="text-text-secondary">
                —
              </span>
              <span className="sr-only">None</span>
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <Field
      {...pickRootProps(rest)}
      data-property-row=""
      controlId={nonEmpty(htmlFor)}
      className={rowClass}
    >
      <FieldLabel accessory={note} className="min-w-0 truncate text-xs text-text-secondary">
        {text}
      </FieldLabel>
      <div data-field-control="" className={valueClass}>
        {node(children)}
      </div>
    </Field>
  );
}
