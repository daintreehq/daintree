import { useContext, useId, type FocusEvent } from "react";
import { useFieldControl } from "@/components/ui/field";
import { oneOf, str } from "./kitProps";
import { KIT_FOCUS_SCOPE_ATTRIBUTE, KitFocusScopeContext } from "./kitScope";

// The one bridge from a kit control to the host field: every input family
// resolves ARIA and invalid state here, so a FormField treats them alike.

export interface KitAriaInput {
  "aria-label"?: unknown;
  "aria-labelledby"?: unknown;
  "aria-describedby"?: unknown;
  "aria-invalid"?: unknown;
}

type AriaInvalid = boolean | "true" | "false" | "grammar" | "spelling";

/** Every value `aria-invalid` takes, from untyped input; anything else is unset. */
export function kitAriaInvalid(value: unknown): AriaInvalid | undefined {
  if (value === true || value === "true") return true;
  if (value === false) return false;
  return oneOf(value, ["false", "grammar", "spelling"] as const);
}

/**
 * A plugin's `invalid` prop. Omitted stays `undefined`, so the control takes
 * its FormField's state; an explicit boolean overrides it either way.
 */
export function invalidProp(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * The enclosing `FormField`'s ids, merged with whatever ARIA the plugin
 * passed. `invalid` is the control's own verdict (`undefined` defers to the
 * field); `labelable` is `false` for a composite a `<label for>` can't name.
 */
export function useKitFieldControl(props: KitAriaInput, invalid?: boolean, labelable = true) {
  return useFieldControl(
    {
      "aria-label": str(props["aria-label"]),
      "aria-labelledby": str(props["aria-labelledby"]),
      "aria-describedby": str(props["aria-describedby"]),
      "aria-invalid": kitAriaInvalid(props["aria-invalid"]),
    },
    invalid,
    { labelable }
  );
}

/**
 * A composite control's logical focus scope: its root plus the surfaces it
 * portals out. Provide `scopes` through `KitFocusScopeContext` around the
 * control's parts and spread `attributes` on a surface it renders itself.
 */
export function useKitFocusScope() {
  const parent = useContext(KitFocusScopeContext);
  const id = useId();
  const scopes = parent ? `${parent} ${id}` : id;
  return { id, scopes, attributes: { [KIT_FOCUS_SCOPE_ATTRIBUTE]: scopes } };
}

/**
 * Whether focus left the composite whose scope is `scopeId`: to somewhere
 * outside its root and outside the surfaces it opened. Another control's
 * popover, even the same plugin's, is outside.
 */
export function focusLeft(event: FocusEvent<HTMLElement>, scopeId: string): boolean {
  const next = event.relatedTarget;
  if (!(next instanceof Element)) return true;
  if (event.currentTarget.contains(next)) return false;
  for (let at: Element | null = next; at !== null; at = at.parentElement) {
    const scopes = at.getAttribute(KIT_FOCUS_SCOPE_ATTRIBUTE);
    if (scopes !== null) return !scopes.split(" ").includes(scopeId);
  }
  return true;
}
