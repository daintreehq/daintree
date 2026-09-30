import { useRef, useState, type MouseEvent } from "react";
import type {
  PluginSelectionGesture,
  PluginSelectionItemProps,
  PluginSelectionKey,
  UseSelectionOptions,
  UseSelectionResult,
} from "@shared/types/plugin-sdk-react";
import { isMac } from "@/lib/platform";

/**
 * A selection and the two facts range selection needs besides it: the row a
 * Shift-click extends from, and what was selected before that range began, so
 * a second Shift-click replaces the first range instead of adding to it.
 */
export interface SelectionState<K> {
  selected: readonly K[];
  anchor: K | null;
  base: readonly K[];
}

export interface SelectionContext<K> {
  ids: readonly K[];
  single: boolean;
  blocked: (id: K) => boolean;
}

export type SelectionCommand<K> =
  | { type: "toggle"; id: K }
  | { type: "select"; ids: readonly K[] }
  | { type: "range"; id: K; additive: boolean }
  | { type: "all" }
  | { type: "clear" };

const EMPTY: readonly never[] = [];

function union<K>(a: readonly K[], b: readonly K[]): K[] {
  const seen = new Set(a);
  const out = [...a];
  for (const id of b) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** The selectable ids from `from` to `to` in row order, either way round. */
function rangeBetween<K>(ctx: SelectionContext<K>, from: K, to: K): K[] {
  const start = ctx.ids.indexOf(from);
  const end = ctx.ids.indexOf(to);
  if (start < 0 || end < 0) return ctx.blocked(to) ? [] : [to];
  const [low, high] = start <= end ? [start, end] : [end, start];
  return ctx.ids.slice(low, high + 1).filter((id) => !ctx.blocked(id));
}

/** One selection change, as a pure step so every gesture can be tested alone. */
export function reduceSelection<K>(
  state: SelectionState<K>,
  command: SelectionCommand<K>,
  ctx: SelectionContext<K>
): SelectionState<K> {
  switch (command.type) {
    case "toggle": {
      if (ctx.blocked(command.id)) return state;
      const on = state.selected.includes(command.id);
      if (ctx.single) {
        return on
          ? { selected: EMPTY, anchor: null, base: EMPTY }
          : { selected: [command.id], anchor: command.id, base: EMPTY };
      }
      const selected = on
        ? state.selected.filter((id) => id !== command.id)
        : [...state.selected, command.id];
      // The range a Shift-click makes next starts here and keeps everything
      // else that is selected now.
      return {
        selected,
        anchor: command.id,
        base: selected.filter((id) => id !== command.id),
      };
    }
    case "select": {
      const wanted = command.ids.filter((id) => !ctx.blocked(id));
      const selected = ctx.single ? wanted.slice(0, 1) : [...new Set(wanted)];
      return { selected, anchor: selected[0] ?? null, base: EMPTY };
    }
    case "range": {
      if (ctx.blocked(command.id)) return state;
      if (ctx.single || state.anchor === null || !ctx.ids.includes(state.anchor)) {
        return reduceSelection(state, { type: "select", ids: [command.id] }, ctx);
      }
      const range = rangeBetween(ctx, state.anchor, command.id);
      if (command.additive) {
        const selected = union(state.selected, range);
        return { selected, anchor: state.anchor, base: selected };
      }
      return { selected: union(state.base, range), anchor: state.anchor, base: state.base };
    }
    case "all": {
      if (ctx.single) return state;
      const selected = ctx.ids.filter((id) => !ctx.blocked(id));
      return { selected, anchor: state.anchor, base: EMPTY };
    }
    case "clear":
      return { selected: EMPTY, anchor: null, base: EMPTY };
  }
}

/** What a click or key does, read the platform way. */
export function gestureCommand<K>(
  id: K,
  gesture: PluginSelectionGesture | undefined,
  mac: boolean
): SelectionCommand<K> {
  const primary = mac ? gesture?.metaKey === true : gesture?.ctrlKey === true;
  if (gesture?.shiftKey === true) return { type: "range", id, additive: primary };
  if (primary || gesture?.key === " ") return { type: "toggle", id };
  return { type: "select", ids: [id] };
}

function readIds<K extends PluginSelectionKey>(value: unknown): K[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (id): id is K => typeof id === "string" || (typeof id === "number" && Number.isFinite(id))
  );
}

/**
 * Single, multi and range selection for a list or table, keyed by row id.
 * Clicks and keys are read the way the platform reads them; see
 * `handleSelect`. Controlled with `selected` + `onSelectedChange`, or
 * uncontrolled from `defaultSelected`.
 */
export function useSelection<K extends PluginSelectionKey = string>(
  rawOptions: UseSelectionOptions<K>
): UseSelectionResult<K> {
  const options: Partial<UseSelectionOptions<K>> =
    typeof rawOptions === "object" && rawOptions !== null ? rawOptions : {};
  const ids = readIds<K>(options.ids) ?? [];
  const single = options.mode === "single";
  const onChange =
    typeof options.onSelectedChange === "function" ? options.onSelectedChange : undefined;
  const isDisabledOption =
    typeof options.isDisabled === "function" ? options.isDisabled : undefined;
  const blocked = (id: K): boolean => {
    if (!isDisabledOption) return false;
    try {
      return isDisabledOption(id) === true;
    } catch {
      return false;
    }
  };
  const controlled = readIds<K>(options.selected);

  const [inner, setInner] = useState<SelectionState<K>>(() => ({
    selected: readIds<K>(options.defaultSelected) ?? EMPTY,
    anchor: null,
    base: EMPTY,
  }));
  // Two gestures in one handler must see each other's result rather than both
  // starting from this render's. Stamped with what this render read, so the
  // next render (or a new controlled value) takes over again.
  const latest = useRef<{
    from: SelectionState<K>;
    controlledFrom: unknown;
    state: SelectionState<K>;
  } | null>(null);
  const given = controlled ?? inner.selected;
  // Single mode holds one row however the selection arrived: a default, a
  // controlled value or a switch from multiple.
  const raw = single && given.length > 1 ? given.slice(0, 1) : given;
  const rendered: SelectionState<K> = raw === inner.selected ? inner : { ...inner, selected: raw };

  const present = new Set(ids);
  const rawSet = new Set(raw);
  // Only ids still shown, in row order: a row filtered away drops out of view
  // without being forgotten.
  const selected = ids.filter((id) => rawSet.has(id));
  const anchor = inner.anchor !== null && present.has(inner.anchor) ? inner.anchor : null;
  const selectable = ids.filter((id) => !blocked(id));

  const ctx: SelectionContext<K> = { ids, single, blocked };

  const run = (command: SelectionCommand<K>) => {
    const pending = latest.current;
    const before =
      pending && pending.from === inner && pending.controlledFrom === options.selected
        ? pending.state
        : rendered;
    const next = reduceSelection(before, command, ctx);
    if (next === before) return;
    latest.current = { from: inner, controlledFrom: options.selected, state: next };
    setInner(next);
    const beforeSet = new Set(before.selected);
    const changed =
      next.selected.length !== before.selected.length ||
      next.selected.some((id) => !beforeSet.has(id));
    if (changed) onChange?.(ids.filter((id) => next.selected.includes(id)));
  };

  const handleSelect = (id: K, gesture?: PluginSelectionGesture) => {
    // A click on a disabled row does nothing, rather than clearing the rest.
    if (blocked(id)) return;
    run(gestureCommand(id, gesture, isMac()));
  };

  return {
    selected,
    count: selected.length,
    anchor,
    isSelected: (id: K) => rawSet.has(id) && present.has(id),
    allSelected: selectable.length > 0 && selectable.every((id) => rawSet.has(id)),
    toggle: (id: K) => run({ type: "toggle", id }),
    select: (next: K | readonly K[]) => {
      const list: readonly K[] = Array.isArray(next) ? next : [next];
      run({ type: "select", ids: readIds<K>(list) ?? [] });
    },
    selectRange: (id: K, rangeOptions?: { additive?: boolean }) =>
      run({ type: "range", id, additive: rangeOptions?.additive === true }),
    selectAll: () => run({ type: "all" }),
    clear: () => run({ type: "clear" }),
    handleSelect,
    handleNavigate: (id: K, gesture?: PluginSelectionGesture) => {
      if (gesture?.shiftKey === true) run({ type: "range", id, additive: false });
    },
    getItemProps: (id: K): PluginSelectionItemProps => ({
      "aria-selected": rawSet.has(id) && present.has(id),
      onClick: (event: MouseEvent<HTMLElement>) => handleSelect(id, event),
    }),
  };
}
