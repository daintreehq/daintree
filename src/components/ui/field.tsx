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
 */

type FieldOrientation = "vertical" | "horizontal";

interface FieldContextValue {
  controlId: string;
  labelId: string | undefined;
  descriptionId: string | undefined;
  errorId: string | undefined;
  describedBy: string | undefined;
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

/**
 * Everything a control needs to join the enclosing field, already merged with
 * whatever ARIA the caller passed. Returns `invalid: false` and a bare
 * passthrough outside a field — controls stay usable standalone.
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

  // A caller that named the control itself keeps that name.
  const namedByCaller = own["aria-label"] !== undefined || own["aria-labelledby"] !== undefined;

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
      "aria-describedby":
        [own["aria-describedby"], field.describedBy].filter(Boolean).join(" ") || undefined,
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

// Render-time scan rather than effect-based registration: an effect would leave
// the first paint pointing `aria-describedby` at an id that does not exist yet.
function hasSlot(children: React.ReactNode, type: React.ElementType): boolean {
  let found = false;
  React.Children.forEach(children, (child) => {
    if (found || !React.isValidElement(child)) return;
    if (child.type === type) {
      found = true;
      return;
    }
    if (child.type === React.Fragment) {
      found = hasSlot((child.props as { children?: React.ReactNode }).children, type);
    }
  });
  return found;
}

const fieldVariants = cva("min-w-0", {
  variants: {
    orientation: {
      vertical: "grid gap-2",
      // The control sits in column one and everything else stacks in column
      // two. `col-start-2` on the text slots is what pins that: auto-placement
      // then flows label, description and error down the second column while
      // the control keeps the single cell it was placed in.
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
  },
  compoundVariants: [
    // The whole horizontal row is the click target, so it advertises that —
    // but only while the control can actually take the click.
    { orientation: "horizontal", disabled: false, class: "cursor-pointer" },
  ],
  defaultVariants: {
    orientation: "vertical",
    disabled: false,
  },
});

export interface FieldProps extends Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  children: React.ReactNode;
  orientation?: FieldOrientation;
  /** Adopt an existing control id instead of the generated one. */
  controlId?: string;
  /** Defaults to whether a `FieldError` is currently rendered. */
  invalid?: boolean;
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

  const hasLabel = hasSlot(children, FieldLabel);
  const hasDescription = hasSlot(children, FieldDescription);
  const hasError = hasSlot(children, FieldError);
  // A caller that holds an untouched error keeps the field clean by simply not
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
      // Error first: a screen reader should reach the problem before the hint.
      describedBy: [errorId, descriptionId].filter(Boolean).join(" ") || undefined,
      invalid: resolvedInvalid,
      disabled,
      orientation,
    }),
    [resolvedControlId, labelId, descriptionId, errorId, resolvedInvalid, disabled, orientation]
  );

  const classes = cn(fieldVariants({ orientation, disabled }), className);

  return (
    <FieldContext.Provider value={value}>
      {orientation === "horizontal" ? (
        // A label root makes the entire row clickable. The named text lives in
        // `FieldLabel`, so the description and error stay out of the accessible
        // name instead of being read as one run-on string.
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

export interface FieldLabelProps extends React.HTMLAttributes<HTMLElement> {
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
    <div data-slot="field-label" className="flex min-w-0 items-center gap-2">
      {orientation === "horizontal" ? (
        // Already inside the row's <label> — a nested one would be invalid.
        <span id={labelId} className={labelClasses} {...props}>
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

export type FieldDescriptionProps = React.HTMLAttributes<HTMLParagraphElement>;

function FieldDescription({ className, ...props }: FieldDescriptionProps) {
  const { descriptionId } = useFieldContext("FieldDescription");
  return (
    <p
      data-slot="field-description"
      id={descriptionId}
      className={cn("text-xs text-text-muted select-text", className)}
      {...props}
    />
  );
}

export type FieldErrorProps = React.HTMLAttributes<HTMLParagraphElement>;

/**
 * No `role="alert"`: settings validation renders on every keystroke, and a live
 * region would interrupt the user mid-word. The control's `aria-invalid` plus
 * the described-by association is what announces it, on focus.
 */
function FieldError({ className, ...props }: FieldErrorProps) {
  const { errorId } = useFieldContext("FieldError");
  return (
    <p
      data-slot="field-error"
      id={errorId}
      className={cn("text-xs text-status-error", className)}
      {...props}
    />
  );
}

export { Field, FieldLabel, FieldDescription, FieldError, fieldVariants, fieldLabelVariants };
