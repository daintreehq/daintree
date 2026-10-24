import { nonEmpty, pickRootProps } from "./kitProps";
import { reportPluginFault, runPluginAction } from "./kitDiagnostics";

/** Only the `aria-*` attributes, for a control inside a root that takes the rest. */
export function pickAria(props: object): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(pickRootProps(props, { aria: true }))) {
    if (key.startsWith("aria-")) out[key] = value;
  }
  return out;
}

/** Space-separated ids for `aria-describedby`, or nothing when there are none. */
export function joinIds(ids: readonly (string | undefined)[]): string | undefined {
  const joined = ids.filter((id) => id !== undefined && id !== "").join(" ");
  return joined === "" ? undefined : joined;
}

/** Calls a plugin callback, reporting a throw or rejection instead of letting it reach React. */
export function safely<A extends unknown[]>(
  label: string,
  callback: ((...args: A) => unknown) | undefined,
  ...args: A
): void {
  if (callback) runPluginAction(label, () => callback(...args));
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

/** Runs a plugin callback without letting its throw reach React. */
export function attempt(run: () => unknown): Outcome {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * A validator's verdict: a non-empty message refuses, anything else accepts.
 * A validator that throws refuses with `onThrow`, so a broken check never
 * lets a value through; a warning lookup passes `null` to show nothing.
 */
export function verdict(
  check: ((value: string) => unknown) | undefined,
  value: string,
  onThrow: string | null = "Couldn't check this value"
): string | null {
  if (!check) return null;
  const outcome = attempt(() => check(value));
  if (!outcome.ok) {
    reportPluginFault("validator threw", outcome.error);
    return onThrow;
  }
  return nonEmpty(outcome.value)?.trim() || null;
}

export const REMOVE_ROW_CLASS =
  "h-6 w-6 shrink-0 text-text-secondary hover:text-text-primary [&_svg]:size-3.5";
