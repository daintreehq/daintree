import * as React from "react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Label / description / error wiring for a single control.
 *
 * The ARIA is the point, not the layout: every call site that assembles a label
 * and a hint by hand has to remember that `aria-describedby` lists the error
 * before the description, that a hidden error must not leave a dangling id, and
 * that `aria-invalid` is only set once the field has been touched. `Field` owns
 * all three and the controls read them out of context, so a consumer wires
 * nothing.
 *
 * Compound rather than `label`/`description`/`error` props because the two
 * orientations put the control in different places: above the description for a
 * text field, beside it for a checkbox row. Props would need a render slot to
 * express that; children already do.
 *
 * `disabled` is presentation only — it dims the label and sets the row's cursor.
 * The control still takes its own `disabled`, so one prop can never leave a
 * field looking inert while it is still operable.
 */

type FieldOrientation = "vertical" | "horizontal";

interface FieldContextValue {
  controlId: string;
  labelId: string | undefined;
  descriptionId: string | undefined;
  errorId: string | undefined;
  invalid: boolean;
  disabled: boolean;
  orientation: FieldOrientation;
}

const FieldContext = React.createContext<FieldContextValue | null>(null);

interface ControlAria {
  "aria-describedby"?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling";
}

// A blank or whitespace-only name is no name at all — the accessible-name
// algorithm falls straight through it — so it must not suppress the field's own
// label, which would leave a horizontal row naming itself from every scrap of
// text the wrapping <label> encloses.
function isNamed(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function idList(...sources: Array<string | undefined>): string | undefined {
  const ids = sources
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .flatMap((value) => value.split(/\s+/))
    .filter((value) => value.length > 0);
  // A repeated IDREF is announced twice; dedupe, keeping first position.
  const unique = [...new Set(ids)];
  return unique.length > 0 ? unique.join(" ") : undefined;
}

/**
 * Everything a control needs to join the enclosing field, already merged with
 * whatever ARIA the caller passed. Outside a field it degrades to a passthrough,
 * so controls stay usable standalone.
 *
 * Spread the result AFTER the caller's own props: the field owns the id its
 * label points at, so a stray `id` at the call site cannot orphan the label.
 */
export function useFieldControl(own: ControlAria, invalidOverride?: boolean) {
  const field = React.useContext(FieldContext);
  const invalid = invalidOverride ?? field?.invalid ?? false;

  if (field === null) {
    return {
      invalid,
      controlProps: {
        "aria-invalid": invalid ? (true as const) : own["aria-invalid"],
      },
    };
  }

  const namedByCaller = isNamed(own["aria-label"]) || isNamed(own["aria-labelledby"]);

  return {
    invalid,
    controlProps: {
      id: field.controlId,
      "data-field-control": "",
      // Horizontal rows wrap the control in a <label> so the whole row is
      // clickable, which would otherwise fold the description and error into
      // the accessible name as one run-on string. Naming the label element
      // explicitly keeps the name to the label text alone.
      "aria-labelledby": namedByCaller ? own["aria-labelledby"] : field.labelId,
      // Error first, then the field's own hint, then anything the caller added:
      // a screen reader should reach the problem before the explanation.
      "aria-describedby": idList(field.errorId, field.descriptionId, own["aria-describedby"]),
      "aria-invalid": invalid ? (true as const) : own["aria-invalid"],
    },
  };
}

function useFieldContext(slot: string): FieldContextValue {
  const field = React.useContext(FieldContext);
  if (field === null) {
    throw new Error(`${slot} must be rendered inside a <Field>`);
  }
  return field;
}

/**
 * Slots are matched by element type while `Field` renders, so one nested behind
 * a wrapper component is invisible to the scan and would render with no id —
 * the silently unassociated description this primitive exists to prevent. Fail
 * loudly rather than ship a field that only looks wired up.
 */
function assertAllocated(slot: string, id: string | undefined): string {
  if (id === undefined) {
    throw new Error(
      `${slot} must be a direct child of <Field> (inside a fragment or array is fine) for the field to associate it`
    );
  }
  return id;
}

// Render-time scan rather than effect-based registration: an effect would leave
// the first paint pointing `aria-describedby` at an id that does not exist yet.
function countSlot(children: React.ReactNode, type: React.ElementType): number {
  let count = 0;
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    if (child.type === type) {
      count += 1;
      return;
    }
    if (child.type === React.Fragment) {
      count += countSlot((child.props as { children?: React.ReactNode }).children, type);
    }
  });
  return count;
}

/**
 * One of each: every slot of a kind shares a single generated id, so a second
 * one would emit a duplicate id and leave the control described by whichever the
 * document happened to reach first.
 */
function hasSlot(children: React.ReactNode, type: React.ElementType, name: string): boolean {
  const count = countSlot(children, type);
  if (count > 1) {
    throw new Error(`<Field> takes at most one ${name}, found ${count}`);
  }
  return count === 1;
}

const fieldVariants = cva("min-w-0", {
  variants: {
    orientation: {
      vertical: "grid gap-2",
      // The control sits in column one and everything else stacks in column
      // two. `col-start-2` on the text slots is what pins that: auto-placement
      // then flows label, description and error down the second column while
      // the control keeps the single cell it was placed in. That only holds
      // while the control is the FIRST child — the layout test pins the order.
      horizontal:
        "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-0.5 " +
        "[&>[data-field-control]]:mt-0.5 " +
        "[&>[data-slot=field-label]]:col-start-2 " +
        "[&>[data-slot=field-description]]:col-start-2 " +
        "[&>[data-slot=field-error]]:col-start-2",
    },
    disabled: {
      true: "cursor-not-allowed",
      false: "",
    },
    /** Only a labelled row gets a `<label>` root, so only it takes a row click. */
    clickable: {
      true: "",
      false: "",
    },
  },
  compoundVariants: [
    // The whole horizontal row is the click target, so it advertises that —
    // but only while the control can actually take the click.
    { orientation: "horizontal", disabled: false, clickable: true, class: "cursor-pointer" },
  ],
  defaultVariants: {
    orientation: "vertical",
    disabled: false,
    clickable: true,
  },
});

export interface FieldProps extends Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  children: React.ReactNode;
  orientation?: FieldOrientation;
  /** Adopt an existing control id instead of the generated one. */
  controlId?: string;
  /** Defaults to whether a `FieldError` is currently rendered. */
  invalid?: boolean;
  /** Presentation only — pass `disabled` to the control as well. */
  disabled?: boolean;
}

function Field({
  orientation = "vertical",
  controlId,
  invalid,
  disabled = false,
  className,
  children,
  ...props
}: FieldProps) {
  const generatedId = React.useId();
  const resolvedControlId = controlId ?? `${generatedId}control`;

  const hasLabel = hasSlot(children, FieldLabel, "FieldLabel");
  const hasDescription = hasSlot(children, FieldDescription, "FieldDescription");
  const hasError = hasSlot(children, FieldError, "FieldError");
  // A caller holding an untouched error keeps the field clean by simply not
  // rendering `FieldError` — presence of the slot is the signal.
  const resolvedInvalid = invalid ?? hasError;

  const descriptionId = hasDescription ? `${generatedId}description` : undefined;
  const errorId = hasError ? `${generatedId}error` : undefined;
  // Vertical fields name the control through `htmlFor`, which already scopes
  // the name to the label's own text — only the wrapped row needs this.
  const labelId = orientation === "horizontal" && hasLabel ? `${generatedId}label` : undefined;

  const value = React.useMemo<FieldContextValue>(
    () => ({
      controlId: resolvedControlId,
      labelId,
      descriptionId,
      errorId,
      invalid: resolvedInvalid,
      disabled,
      orientation,
    }),
    [resolvedControlId, labelId, descriptionId, errorId, resolvedInvalid, disabled, orientation]
  );

  // A label root makes the entire row clickable, and the named text living in
  // `FieldLabel` is what keeps the description and error out of the accessible
  // name. Without a `FieldLabel` there is no `labelId` to scope that name, so a
  // `<label>` root would hand the control every scrap of text it wraps as one
  // run-on string — the exact failure this primitive exists to prevent. Fall
  // back to a plain `<div>`: the row loses its click target, nothing else.
  const labelRoot = orientation === "horizontal" && hasLabel;

  const classes = cn(fieldVariants({ orientation, disabled, clickable: labelRoot }), className);

  return (
    <FieldContext.Provider value={value}>
      {labelRoot ? (
        <label htmlFor={resolvedControlId} className={classes} {...props}>
          {children}
        </label>
      ) : (
        <div className={classes} {...props}>
          {children}
        </div>
      )}
    </FieldContext.Provider>
  );
}

const fieldLabelVariants = cva("text-sm", {
  variants: {
    orientation: {
      vertical: "text-text-secondary",
      horizontal: "block font-medium text-text-primary",
    },
    disabled: {
      true: "cursor-not-allowed opacity-50",
      false: "",
    },
    invalid: {
      true: "text-status-error",
      false: "",
    },
  },
  defaultVariants: {
    orientation: "vertical",
    disabled: false,
    invalid: false,
  },
});

export interface FieldLabelProps extends Omit<React.HTMLAttributes<HTMLElement>, "id"> {
  children: React.ReactNode;
  /**
   * Rendered beside the label text, never inside it — reset buttons, scope
   * chips and modified dots must not fold into the control's accessible name.
   */
  accessory?: React.ReactNode;
  /** Paint the label with the error tone. Off by default even when invalid. */
  tinted?: boolean;
}

function FieldLabel({ accessory, tinted = false, className, children, ...props }: FieldLabelProps) {
  const { controlId, labelId, orientation, disabled, invalid } = useFieldContext("FieldLabel");
  const labelClasses = cn(
    fieldLabelVariants({ orientation, disabled, invalid: tinted && invalid }),
    className
  );

  return (
    // The slot marker rides the wrapper, not the text: an accessory has to land
    // in the same grid cell as the label it annotates.
    <div className="flex min-w-0 items-center gap-2" data-slot="field-label">
      {orientation === "horizontal" ? (
        // Already inside the row's <label> — a nested one would be invalid.
        <span className={labelClasses} {...props} id={assertAllocated("FieldLabel", labelId)}>
          {children}
        </span>
      ) : (
        <label htmlFor={controlId} className={labelClasses} {...props}>
          {children}
        </label>
      )}
      {accessory}
    </div>
  );
}

export type FieldDescriptionProps = Omit<React.HTMLAttributes<HTMLParagraphElement>, "id">;

function FieldDescription({ className, ...props }: FieldDescriptionProps) {
  const { descriptionId } = useFieldContext("FieldDescription");
  return (
    <p
      className={cn("text-xs text-text-muted select-text", className)}
      {...props}
      // After the spread: the id is what the control's association points at and
      // the slot marker is what places this in the row's second column, so
      // neither is the caller's to override.
      id={assertAllocated("FieldDescription", descriptionId)}
      data-slot="field-description"
    />
  );
}

export type FieldErrorProps = Omit<React.HTMLAttributes<HTMLParagraphElement>, "id">;

/**
 * No `role="alert"`: settings validation renders on every keystroke, and a live
 * region would interrupt the user mid-word. The control's `aria-invalid` plus
 * the described-by association is what announces it, on focus.
 */
function FieldError({ className, ...props }: FieldErrorProps) {
  const { errorId } = useFieldContext("FieldError");
  return (
    <p
      className={cn("text-xs text-status-error", className)}
      {...props}
      id={assertAllocated("FieldError", errorId)}
      data-slot="field-error"
    />
  );
}

export { Field, FieldLabel, FieldDescription, FieldError, fieldVariants, fieldLabelVariants };
