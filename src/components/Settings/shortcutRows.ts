import type { KeyScope } from "@shared/types/keybinding";
import { combosFieldsEqual, type RegisteredKeybindingConfig } from "@/services/keybindingUtils";

export const SCOPE_NOTES: Record<KeyScope, string> = {
  global: "Across the app",
  worktreeGrid: "In an expanded worktree card",
  portal: "In the portal",
  "dev-preview": "In dev preview",
};

/** A registration as the settings list reads it: its own config plus the keys that trigger it now. */
export type ShortcutRowSource = RegisteredKeybindingConfig & { effectiveCombos: string[] };

export interface ShortcutRowWidening {
  /** A key saved from this row applies more widely than the row's own scope. */
  self: boolean;
  /** The action's other keys that an edit here leaves in place, applying more widely. */
  keys: string[];
  /** Where they would apply, as it reads mid-sentence ("across the app"). */
  where: string;
}

export interface ShortcutRowModel {
  rowId: string;
  actionId: string;
  description?: string;
  category?: string;
  /** The one key this row shows and edits; `""` when it has none. */
  key: string;
  /** The action's other keys, which an edit from this row leaves alone. */
  otherKeys: string[];
  isOverridden: boolean;
  /** Where the key applies, shown only when the action has more than one row. */
  scopeNote?: string;
  /**
   * The scope to check conflicts in. An override rebinds the action in every
   * scope it is registered in, so an action registered in more than one scope
   * is checked everywhere.
   */
  editScope: KeyScope;
  /**
   * Set while the action still has its defaults and they apply in different
   * scopes: the first edit stores one key list for the whole action, which then
   * applies in every scope the action is registered in.
   */
  widening?: ShortcutRowWidening;
}

/** Every scope an override on the action applies in; "global" alone once any of them is global. */
export function overrideScopes(scopes: Iterable<KeyScope>): KeyScope[] {
  const distinct = new Set(scopes);
  return distinct.has("global") ? ["global"] : Array.from(distinct);
}

export function scopeNote(scopes: readonly KeyScope[]): string {
  const notes = scopes.map((scope, index) => {
    const note = SCOPE_NOTES[scope];
    return index === 0 ? note : lowerFirst(note);
  });
  if (notes.length <= 1) return notes[0] ?? "";
  return `${notes.slice(0, -1).join(", ")} and ${notes.at(-1)}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Non-empty combos with platform-equivalent repeats dropped, keeping the first spelling and the order. */
export function distinctCombos(combos: readonly string[], mac: boolean): string[] {
  const kept: string[] = [];
  for (const combo of combos) {
    if (!combo.trim()) continue;
    if (kept.some((existing) => combosFieldsEqual(existing, combo, mac))) continue;
    kept.push(combo);
  }
  return kept;
}

/**
 * The action's keys after one row's edit: `current` (the row's key, `""` for a
 * row with none) replaced in place by `next`, or dropped when `next` is `""`.
 * Every other key stays. A `current` the action no longer holds removes nothing.
 */
export function replaceCombo(
  combos: readonly string[],
  current: string,
  next: string,
  mac: boolean
): string[] {
  const kept = distinctCombos(combos, mac);
  const at = current ? kept.findIndex((combo) => combosFieldsEqual(combo, current, mac)) : -1;
  if (at === -1) return next ? distinctCombos([...kept, next], mac) : kept;
  const edited = [...kept];
  if (next) edited.splice(at, 1, next);
  else edited.splice(at, 1);
  return distinctCombos(edited, mac);
}

/**
 * The settings list's rows. An action on its defaults keeps one row per
 * registration, each with its own key and scope. An override is one key list
 * for the whole action, so an overridden action shows one row per key it holds
 * (one keyless row when it holds none), at the place of its first registration
 * and with that registration's wording: a second registration's description
 * can name a scope ("grid only") the override no longer keeps.
 */
export function buildShortcutRows(
  sources: readonly ShortcutRowSource[],
  isOverridden: (actionId: string) => boolean,
  mac: boolean
): ShortcutRowModel[] {
  const groups = new Map<string, ShortcutRowSource[]>();
  for (const source of sources) {
    const group = groups.get(source.actionId);
    if (group) group.push(source);
    else groups.set(source.actionId, [source]);
  }

  const rows: ShortcutRowModel[] = [];
  sources.forEach((source, index) => {
    const group = groups.get(source.actionId)!;
    const scopes = overrideScopes(group.map((member) => member.scope));
    const editScope = new Set(group.map((member) => member.scope)).size > 1 ? "global" : source.scope;
    const base = {
      actionId: source.actionId,
      description: source.description,
      category: source.category,
      editScope,
    };

    if (isOverridden(source.actionId)) {
      if (group[0] !== source) return;
      const keys = distinctCombos(source.effectiveCombos, mac);
      const note = keys.length > 1 ? scopeNote(scopes) : undefined;
      for (const key of keys.length > 0 ? keys : [""]) {
        rows.push({
          ...base,
          rowId: `${source.actionId}::custom::${key}`,
          key,
          otherKeys: keys.filter((other) => other !== key),
          isOverridden: true,
          scopeNote: note,
        });
      }
      return;
    }

    const key = source.effectiveCombos[0] ?? "";
    const sameKey = (combo: string) => key !== "" && combosFieldsEqual(combo, key, mac);
    const covers = (scope: KeyScope) => scopes.length === 1 && scopes[0] === scope;
    const self = !covers(source.scope);
    const widened = distinctCombos(
      group
        .filter((member) => member !== source && !covers(member.scope))
        .map((member) => member.effectiveCombos[0] ?? "")
        .filter((combo) => !sameKey(combo)),
      mac
    );
    rows.push({
      ...base,
      // The DEFAULT combo, so the id stays put while overrides come and go. The
      // index tells apart the registry's few legal exact duplicates (a plugin may
      // register the same action, scope and combo as a built-in).
      rowId: `${source.actionId}::${source.scope}::${source.combo}::${index}`,
      key,
      otherKeys: distinctCombos(
        group.map((member) => member.effectiveCombos[0] ?? ""),
        mac
      ).filter((combo) => !sameKey(combo)),
      isOverridden: false,
      scopeNote: group.length > 1 ? SCOPE_NOTES[source.scope] : undefined,
      widening:
        self || widened.length > 0
          ? { self, keys: widened, where: lowerFirst(scopeNote(scopes)) }
          : undefined,
    });
  });
  return rows;
}

/** The row holding `key` for the action, else the action's first row. */
export function findShortcutRow(
  rows: readonly ShortcutRowModel[],
  actionId: string,
  key: string,
  mac: boolean
): ShortcutRowModel | undefined {
  const actionRows = rows.filter((row) => row.actionId === actionId);
  return (
    actionRows.find((row) => (key ? combosFieldsEqual(row.key, key, mac) : row.key === "")) ??
    actionRows[0]
  );
}
