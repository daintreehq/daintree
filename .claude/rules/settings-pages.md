---
paths:
  - "src/components/Settings/**/*.tsx"
  - "src/components/Project/**/*.tsx"
---

# Settings pages

Every settings page, global or project, is built from one grammar. Per-page design is welcome on top of it; a page that invents its own section header, card or row is not.

## The grammar

**Page → `SettingsSection` → `SettingsGroup` → rows.** Primitives live in `src/components/Settings/` (`SettingsSection.tsx`, `SettingsGroup.tsx`).

- **Page** — sections stacked with `space-y-8`. The dialog header already names the page; never open a page with a section that repeats that name.
- **`SettingsSection`** — sentence-case `title`, optional one-line `description`, optional `action` (a wizard or "Add" button) on the right. No icon, not sticky. The description says what the section is for; omit it rather than restate the title.
- **`SettingsGroup`** — one surface (`settings-card` background, `border-default`, `radius-lg`) holding related rows split by `border-subtle` hairlines. Related settings share one group. Never a bordered card per setting, never a card inside a card. A section with two clusters gets two groups, optionally `label`led.
- **Rows** — `SettingsRow`, or an adapter that renders one inside a group: `SettingsSwitchCard`, `SettingsSelect`, `SettingsInput`, `SettingsNumberInput`, `SettingsTextarea`, `SettingsCheckbox`.
  - Label `text-sm font-medium text-text-primary`, description `text-xs text-text-secondary`. Never `text-muted` for anything the user must read.
  - `inline` rows put the control on the right rail: switches, selects (`w-52`, `wide` = `w-72`), numbers (`w-24`, unit via `suffix`). `stacked` rows put the control full width under the label: paths, commands, patterns, code, lists.
  - A full-width field holding a short value is a defect.
- **`SettingsDependents`** — rows that only matter while a parent is on sit directly under the parent inside the same group, indented. Pass `disabled` + `reason` when the parent is off; the reason renders next to the rows and `disabled` reaches every control. Never an `opacity-50 pointer-events-none` wrapper, and never the reason in a warning line further down the page.

## Rules

1. **One heading per concept.** A section whose only row carries the section's own title is one heading too many: drop the section description, or fold the row into a broader section.
2. **Descriptions add information** — consequence, scope, default, requirement. A description that restates its label is deleted.
3. **Control choice**: switch for an instant boolean; checkbox for "which of these" lists and explicit-save forms; `SettingsPresetGroup` / `SegmentedRadioGroup` for 2–5 short exclusive options; `SettingsSelect` for longer lists; descriptive choices as a radio list. One radio contract: one tab stop, arrows move *and* select.
4. **Icons** only as identity (an agent, a forge, an editor) — never decoration on a section or a switch row.
5. **Modified from default** = the `state-modified` bar at the row's left edge + a `RotateCcw` reset on the rail. Never accent.
6. **Sentence case** for page titles, section titles, labels, options and buttons. Proper nouns keep their case (GitLab, MCP, Claude).
7. **Instant apply** is the norm. An explicit Save is an exception that needs a reason, lives at the end of its group, and is disabled while nothing is dirty.
8. **Actions** are content-width, neutral, and belong to the row or section they act on. Destructive actions go last on the page, keep their confirm tier, and are never mixed into a group of ordinary settings.
9. **Empty collections** say what to add and offer the add action — one compact block, not a dashed box plus a separate full-width button.
10. **Loading** renders the page structure immediately from defaults; errors sit on the affected group with a `Retry`.

## Components for recurring shapes

- **Short exclusive choice** (2–5 short options): `SettingsPresetGroup` inside a group — a segmented control on the rail. Never tiles or cards.
- **Descriptive exclusive choice**: a group of radio rows (`RadioChoice` bare rows, or `SettingsChoicebox`). One radio contract everywhere.
- **Explicit save**: `SettingsActions` as the group's last row — `contrast` Save, `outline` secondary actions, all `size="sm"`, Save disabled while nothing is dirty, status on the left.
- **Empty collection**: `SettingsEmptyRow` inside the group that will hold the items — the next step in words plus the add action.
- **Row actions**: `outline` `size="sm"` on the rail. Icon-only controls repeated on every item of a list (reorder, edit, export) are `ghost` `size="icon-sm"`, with delete as `ghost-danger` `Trash2` last — outlining each would put a border on every row. When more than one action, or one long one, would squeeze the label column, make the row `stacked` and put the actions in a wrapping row under the description instead. **Destructive**: `ghost-danger` `size="sm"`, last in its group or page.
- **Units**: pass `suffix` to `SettingsNumberInput`; it sits inside the field so the rail stays aligned. Say the unit in the label or description too.
- **Custom controls** in a `SettingsRow` take `labelId`, `descriptionId` (already the full described-by list: error, description, disabled reason) and `disabled` from the `control` render-prop — never ignore `disabled`.

## Dependents: hide or disable

A few dependent preferences (a threshold, a sound, a sub-option) stay visible under their parent and are disabled with a reason when it is off. A whole feature's configuration (MCP server details, a voice provider's fields) may collapse behind its enable switch. Options that do not exist for the current choice (another provider's key) are not rendered.

## Copy

Checkboxes only for "which of these" lists and explicit-save forms; every instant boolean is a switch. A description is one sentence without a trailing period, or several sentences with them. Effective defaults and inherited values go in the description ("Using global default · On", "Default: 10 MB"), never only in a placeholder. Long explanations and inventories keep the consequence visible and move the rest behind a disclosure: an inventory (detected agents, detected editors, paths) shows a summary, the current selection and anything that needs action, and discloses the healthy remainder.

## Accent

The subtab underline and the sidebar's active marker are this dialog's accents. Nothing on a page body is accent at rest — not enabled switches, not selected options, not icons. A primary Save is the neutral high-contrast button.

## Verify

`e2e/screenshots/settings-pages-review.spec.ts` captures every tab and subtab top to bottom. Check a dark theme **and** a light theme (`bondi`; `bali` for the inverted-card edge case) — `DAINTREE_SHOT_THEME=<id>`.
