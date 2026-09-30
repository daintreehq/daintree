/**
 * The docked-panel chip, shared by every chip kind on the rail (terminal and
 * agent, tab group, file/browser/plugin). One spelling so the three can never
 * drift apart again.
 *
 * Open is the dock's neutral lift, the same answer the status pills give
 * (`DOCK_STATUS_PILL_OPEN_CLASS`): accent is reserved for the focus ring, so an
 * open chip must not also carry an accent border and ring. The fill and
 * border come from `--dock-item-bg-active` / `--dock-item-border-active`, which
 * light themes lift to white. The open fill is repeated under `hover:` so
 * pointing at an open chip does not drop it back to the hover step.
 */
export const DOCK_CHIP_CLASS =
  "flex items-center gap-1.5 px-3 h-[var(--dock-item-height)] rounded-[var(--radius-md)] text-xs border transition duration-150 max-w-[280px] bg-[var(--dock-item-bg)] border-[var(--dock-item-border)] text-text-secondary hover:text-text-primary hover:bg-[var(--dock-item-bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-[-2px] cursor-grab active:cursor-grabbing";

export const DOCK_CHIP_OPEN_CLASS =
  "bg-[var(--dock-item-bg-active)] hover:bg-[var(--dock-item-bg-active)] border-[var(--dock-item-border-active)] text-text-primary";

/** An agent asking for input, while its chip is closed and highlights are on. */
export const DOCK_CHIP_WAITING_CLASS =
  "bg-[var(--dock-item-bg-waiting)] border-[var(--dock-item-border-waiting)]";

/**
 * The trailing agent-state glyph. 12px, as on every other surface that shows
 * it beside a panel's 14px kind icon (tab strip, panel header, sidebar
 * sessions): the kind icon names the panel, the smaller glyph qualifies it.
 */
export const DOCK_STATE_GLYPH_CLASS = "h-3 w-3";

/** The rule between a chip's title and its command text — a separator, so the separator colour. */
export const DOCK_CHIP_RULE_CLASS = "h-3 w-px shrink-0 bg-border-divider";
