/**
 * Extra attributes a caller hangs on a component's root element — `id`,
 * `data-*`, `aria-*` — for a component that otherwise takes no DOM props (the
 * plugin kit forwards a plugin's `data-testid` through this). Spread before
 * the component's own attributes, so the component wins on a clash.
 */
export type RootAttributes = Readonly<Record<string, string | number | boolean>>;
