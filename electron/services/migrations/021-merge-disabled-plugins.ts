import type { Migration } from "../StoreMigrations.js";

interface PluginsStateLike {
  disabled?: unknown;
  disabledBuiltins?: unknown;
  [key: string]: unknown;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

/**
 * Unify plugin disable state on a single `plugins.disabled` list covering both
 * built-in and user-installed plugins (issue #9284). The legacy field
 * `plugins.disabledBuiltins` only ever tracked built-ins; merge its ids into
 * `disabled` (deduped) and drop the legacy key. The schema keeps
 * `disabledBuiltins` as an optional `@deprecated` field so `clearInvalidConfig`
 * doesn't strip a persisted value before this migration runs — without that, a
 * user's existing built-in disable preferences would silently vanish.
 */
export const migration021: Migration = {
  version: 21,
  description: "Merge plugins.disabledBuiltins into unified plugins.disabled list (issue #9284)",
  up: (store) => {
    const plugins = store.get("plugins") as PluginsStateLike | undefined;
    if (!plugins || typeof plugins !== "object") return;

    const legacy = toStringArray(plugins.disabledBuiltins);
    const current = toStringArray(plugins.disabled);

    // Nothing to migrate and no legacy key to strip — leave the store untouched.
    if (legacy.length === 0 && plugins.disabledBuiltins === undefined) return;

    const merged = Array.from(new Set([...current, ...legacy]));

    // Rebuild without the legacy key so it's dropped from the persisted object.
    const { disabledBuiltins: _legacy, ...rest } = plugins;
    void _legacy;
    store.set("plugins", { ...rest, disabled: merged } as never);
  },
};
