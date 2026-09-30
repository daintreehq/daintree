import { useLayoutEffect, useRef, useState } from "react";
import type {
  PluginFormFieldBinding,
  PluginFormStatus,
  UseFormOptions,
  UseFormResult,
} from "@shared/types/plugin-sdk-react";

type Row = Record<string, unknown>;
type Errors = ReadonlyMap<string, string>;

const NO_ERRORS: Errors = new Map();

function isPlainObject(value: unknown): value is Row {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Structural equality for form values: primitives, arrays and plain objects.
 * A pair already being compared counts as equal when met again, so a cyclic
 * value ends rather than recursing forever, and a child shared twice still
 * compares by content.
 */
export function sameFormValue(
  a: unknown,
  b: unknown,
  seen = new WeakMap<object, WeakSet<object>>()
): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const partners = seen.get(a);
  if (partners?.has(b)) return true;
  if (partners) partners.add(b);
  else seen.set(a, new WeakSet([b]));
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => sameFormValue(entry, b[index], seen));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return (
    keysA.length === keysB.length &&
    keysA.every((key) => Object.hasOwn(b, key) && sameFormValue(a[key], b[key], seen))
  );
}

function message(error: unknown): string | undefined {
  return typeof error === "string" && error !== "" ? error : undefined;
}

function errorText(error: unknown): string | undefined {
  if (error instanceof Error && error.message !== "") return error.message;
  return message(error);
}

/** A row's own entry, never one inherited from `Object.prototype`. */
function own(row: object, name: string): unknown {
  return Object.hasOwn(row, name) ? Reflect.get(row, name) : undefined;
}

/** The whole-form check's error, under a key no field can have. */
const FORM_KEY = "";

/** Every field's check and the form's own check, merged: a field's message wins. */
async function runChecks(values: Row, validators: object, validate: unknown): Promise<Errors> {
  const out = new Map<string, string>();
  const names = Object.keys(validators);
  const results = await Promise.all(
    names.map(async (name) => {
      const check = own(validators, name);
      if (typeof check !== "function") return undefined;
      try {
        return message(await Reflect.apply(check, undefined, [own(values, name), values]));
      } catch (error) {
        return errorText(error) ?? "Couldn't check this field";
      }
    })
  );
  names.forEach((name, index) => {
    const result = results[index];
    if (result !== undefined) out.set(name, result);
  });
  if (typeof validate === "function") {
    try {
      const whole: unknown = await Reflect.apply(validate, undefined, [values]);
      if (typeof whole === "object" && whole !== null) {
        for (const [name, value] of Object.entries(whole)) {
          const text = message(value);
          if (text !== undefined && name !== FORM_KEY && !out.has(name)) out.set(name, text);
        }
      }
    } catch (error) {
      out.set(FORM_KEY, errorText(error) ?? "Couldn't check the form");
    }
  }
  return out;
}

function countLabel(count: number): string {
  return count === 1 ? "Fix 1 field" : `Fix ${count} fields`;
}

interface FormState<T extends Row> {
  baseline: T;
  values: T;
  /** Every check's latest result, shown or not. */
  found: Errors;
  /** Errors set by hand, shown until the field changes. */
  manual: Errors;
  /** Fields whose check has started, so their errors show. */
  checked: ReadonlySet<string>;
  /** A submit was tried since the last reset: every error shows. */
  attempted: boolean;
  /** From the moment a submit starts checking until it settles. */
  submitting: boolean;
  validating: number;
  outcome: "none" | "saved" | "error";
  submitError: string | undefined;
}

function initialState<T extends Row>(values: T): FormState<T> {
  return {
    baseline: values,
    values,
    found: NO_ERRORS,
    manual: NO_ERRORS,
    checked: new Set(),
    attempted: false,
    submitting: false,
    validating: 0,
    outcome: "none",
    submitError: undefined,
  };
}

/**
 * A copy of the plugin's row; anything but a plain object reads as an empty
 * one. Spread, not `Object.assign`, so a field named `__proto__` is copied as
 * a field rather than setting the copy's prototype.
 */
function copyRow<T extends Row>(value: T | undefined): T {
  const copy: Row = isPlainObject(value) ? { ...value } : {};
  if (!isRowOf<T>(copy)) throw new Error("unreachable");
  return copy;
}

/**
 * A copy of the plugin's own row as the row's type. The plugin typed the
 * values it handed in; a copy of them, or no values at all, is that row.
 */
function isRowOf<T extends Row>(_row: Row): _row is T {
  return true;
}

function withEntry(map: Errors, name: string, text: string | undefined): Errors {
  if (text === undefined ? !map.has(name) : map.get(name) === text) return map;
  const next = new Map(map);
  if (text === undefined) next.delete(name);
  else next.set(name, text);
  return next;
}

/**
 * A field name as the row's key type. Errors and checks are only ever keyed
 * by field names, so every name the form holds is one of the row's.
 */
function isFieldName<T extends Row>(_name: string): _name is Extract<keyof T, string> {
  return true;
}

/**
 * Form state: values against a clean baseline, per-field and whole-form checks
 * (sync or async), a submit with a pending state, reset, and the status words
 * `SettingsActions` shows. Options are read the way component props are: a
 * field of the wrong type is ignored.
 */
export function useForm<T extends Record<string, unknown>>(
  rawOptions: UseFormOptions<T>
): UseFormResult<T> {
  const options: Partial<UseFormOptions<T>> =
    typeof rawOptions === "object" && rawOptions !== null ? rawOptions : {};
  const [state, setState] = useState<FormState<T>>(() =>
    initialState(copyRow(options.initialValues))
  );
  // What the handlers read, so several calls in one event see each other.
  const latest = useRef(state);
  const optionsRef = useRef(options);
  // Per field, the newest check; a result from an older one is dropped.
  const sequence = useRef(new Map<string, number>());
  // Bumped by reset: anything started before it settles into nothing.
  const generation = useRef(0);
  useLayoutEffect(() => {
    latest.current = state;
    optionsRef.current = options;
  });

  const update = (change: (current: FormState<T>) => FormState<T>) => {
    const next = change(latest.current);
    latest.current = next;
    setState(next);
  };

  const validators = (): object => {
    const raw: unknown = optionsRef.current.validators;
    return typeof raw === "object" && raw !== null ? raw : {};
  };
  const mode = (): "blur" | "change" | "submit" => {
    const raw = optionsRef.current.validateOn;
    return raw === "change" || raw === "submit" ? raw : "blur";
  };
  const bump = (name: string): number => {
    const seq = (sequence.current.get(name) ?? 0) + 1;
    sequence.current.set(name, seq);
    return seq;
  };

  /** Runs one field's check; an older run, or one from before a reset, finishing late is dropped. */
  const checkField = (name: string) => {
    const check = own(validators(), name);
    const seq = bump(name);
    const gen = generation.current;
    update((current) =>
      current.checked.has(name)
        ? current
        : { ...current, checked: new Set([...current.checked, name]) }
    );
    const settle = (result: string | undefined, async: boolean) => {
      if (generation.current !== gen) return;
      const stale = sequence.current.get(name) !== seq;
      update((current) => ({
        ...current,
        found: stale ? current.found : withEntry(current.found, name, result),
        validating: async ? current.validating - 1 : current.validating,
      }));
    };
    if (typeof check !== "function") {
      settle(undefined, false);
      return;
    }
    let result: unknown;
    try {
      result = Reflect.apply(check, undefined, [
        own(latest.current.values, name),
        latest.current.values,
      ]);
    } catch (error) {
      settle(errorText(error) ?? "Couldn't check this field", false);
      return;
    }
    // The check itself reset the form: its promise belongs to nothing now.
    if (generation.current !== gen) {
      if (result instanceof Promise) result.catch(() => {});
      return;
    }
    if (result instanceof Promise) {
      update((current) => ({ ...current, validating: current.validating + 1 }));
      result.then(
        (value: unknown) => settle(message(value), true),
        (error: unknown) => settle(errorText(error) ?? "Couldn't check this field", true)
      );
      return;
    }
    settle(message(result), false);
  };

  /** Writes several fields at once, then checks each that should be, against the whole new row. */
  const writeValues = (entries: [string, unknown][]) => {
    if (entries.length === 0) return;
    update((current) => {
      let manual = current.manual;
      const values = { ...current.values };
      for (const [name, value] of entries) {
        manual = withEntry(manual, name, undefined);
        Object.defineProperty(values, name, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return {
        ...current,
        values,
        manual,
        outcome: current.outcome === "saved" ? "none" : current.outcome,
      };
    });
    const current = latest.current;
    for (const [name] of entries) {
      // A check still running on the old value no longer describes the field.
      bump(name);
      const recheck =
        mode() === "change" ||
        (mode() === "blur" && (current.checked.has(name) || current.attempted));
      if (recheck) checkField(name);
    }
  };

  const submit = (): Promise<boolean> => {
    // Locked from the first moment, so a second submit during the checks is refused.
    if (latest.current.submitting) return Promise.resolve(false);
    const gen = generation.current;
    const values = latest.current.values;
    // Field checks already running describe what the submit is about to check again.
    for (const name of sequence.current.keys()) bump(name);
    update((current) => ({
      ...current,
      attempted: true,
      submitting: true,
      validating: current.validating + 1,
    }));
    const checks = runChecks(values, validators(), optionsRef.current.validate).catch(
      // Anything the checks threw outside a check of their own still ends the submit.
      (error: unknown): Errors =>
        new Map([[FORM_KEY, errorText(error) ?? "Couldn't check the form"]])
    );
    return checks.then((results) => {
      if (generation.current !== gen) return false;
      const now = latest.current.values;
      const unchanged = (name: string) => sameFormValue(own(now, name), own(values, name));
      const edited = fieldNames(values, now).some((name) => !unchanged(name));
      let found = latest.current.found;
      const names = new Set([
        ...Object.keys(validators()),
        ...results.keys(),
        ...latest.current.found.keys(),
      ]);
      for (const name of names) {
        if (name === FORM_KEY || unchanged(name)) found = withEntry(found, name, results.get(name));
      }
      found = withEntry(found, FORM_KEY, results.get(FORM_KEY));
      // Edited while the checks ran: what was checked is no longer the form, so nothing is sent.
      const failed = results.size > 0 || latest.current.manual.size > 0 || edited;
      update((current) => ({
        ...current,
        found,
        validating: current.validating - 1,
        submitting: !failed,
        outcome: failed ? "none" : current.outcome,
      }));
      if (failed) return false;
      const onSubmit = optionsRef.current.onSubmit;
      return Promise.resolve()
        .then(() => {
          // Reset between the checks and the send: nothing is sent.
          if (generation.current !== gen) return undefined;
          return typeof onSubmit === "function" ? onSubmit(values) : undefined;
        })
        .then(
          () => {
            if (generation.current !== gen) return false;
            update((current) => ({
              ...current,
              baseline: values,
              submitting: false,
              outcome: "saved",
              submitError: undefined,
            }));
            return true;
          },
          (error: unknown) => {
            if (generation.current !== gen) return false;
            update((current) => ({
              ...current,
              submitting: false,
              outcome: "error",
              submitError: errorText(error) ?? "Couldn't save",
            }));
            return false;
          }
        );
    });
  };

  const reset = (values?: T) => {
    generation.current += 1;
    const next = values === undefined ? latest.current.baseline : copyRow(values);
    update(() => initialState(next));
  };

  // A field's errors show once its check has started, and all of them after a submit.
  // No prototype, so a field named `constructor` reads as unset rather than inherited.
  const shown: Partial<Record<keyof T, string>> = {};
  Object.setPrototypeOf(shown, null);
  const errorNames = new Set([...state.found.keys(), ...state.manual.keys()]);
  for (const name of errorNames) {
    if (name === FORM_KEY || !isFieldName<T>(name)) continue;
    const found = state.attempted || state.checked.has(name) ? state.found.get(name) : undefined;
    const text = state.manual.get(name) ?? found;
    if (text !== undefined) shown[name] = text;
  }
  const formError = state.attempted ? state.found.get(FORM_KEY) : undefined;
  const dirtyFields = fieldNames(state.baseline, state.values).filter(
    (name) => !sameFormValue(state.baseline[name], state.values[name])
  );
  const errorCount = Object.keys(shown).length;
  const status: PluginFormStatus = state.submitting
    ? "submitting"
    : errorCount > 0 || formError !== undefined
      ? "invalid"
      : state.outcome === "error"
        ? "error"
        : dirtyFields.length > 0
          ? "dirty"
          : state.outcome === "saved"
            ? "saved"
            : "clean";
  const statusMessage =
    status === "submitting"
      ? "Saving…"
      : status === "invalid"
        ? errorCount > 0
          ? countLabel(errorCount)
          : formError
        : status === "error"
          ? state.submitError
          : status === "dirty"
            ? "Unsaved changes"
            : status === "saved"
              ? "Saved"
              : undefined;

  return {
    values: state.values,
    errors: shown,
    dirtyFields,
    isDirty: dirtyFields.length > 0,
    isSubmitting: state.submitting,
    isValidating: state.validating > 0,
    status,
    statusMessage,
    submitError: state.outcome === "error" ? state.submitError : undefined,
    setValue: (name, value) => writeValues([[String(name), value]]),
    setValues: (values) => {
      if (!isPlainObject(values)) return;
      writeValues(Object.entries(values));
    },
    setError: (name, error) => {
      update((current) => ({
        ...current,
        manual: withEntry(current.manual, String(name), message(error)),
      }));
    },
    reset,
    submit,
    field: <K extends keyof T & string>(name: K): PluginFormFieldBinding<T[K]> => ({
      name,
      value: state.values[name],
      onValueChange: (value: T[K]) => writeValues([[name, value]]),
      onBlur: () => {
        if (mode() === "blur") checkField(name);
      },
      invalid: shown[name] !== undefined,
    }),
  };
}

/** The field names in either row, typed as the row's own keys. */
function fieldNames<T extends Row>(a: T, b: T): Extract<keyof T, string>[] {
  const out: Extract<keyof T, string>[] = [];
  for (const name in a) if (Object.hasOwn(a, name)) out.push(name);
  for (const name in b) if (Object.hasOwn(b, name) && !Object.hasOwn(a, name)) out.push(name);
  return out;
}
