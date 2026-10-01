# UI kit — `@daintreehq/plugin-ui`

`@daintreehq/plugin-ui` is Daintree's own controls, served to plugin views through the host import map and themed with the app: the same buttons, fields, menus, dialogs, lists and pane chrome Daintree draws itself. A view that uses it looks and behaves like the rest of the app, follows the user's theme without a re-render, and pays nothing in bundle size.

There is no package behind the specifier. The implementation exists only inside the running app (compiled from `src/pluginUi`), `@daintreehq/plugin-vite` keeps the import external, and a raw `plugin://` view imports it directly. Types come from the SDK: add `"@daintreehq/plugin-sdk/plugin-ui"` to `compilerOptions.types` (the scaffold's tsconfig already does), or put `/// <reference types="@daintreehq/plugin-sdk/plugin-ui" />` in one file. `packages/plugin-sdk/plugin-ui.d.ts` declares the module; the prop interfaces live in `shared/types/plugin-sdk-react.ts` and are re-exported from `@daintreehq/plugin-sdk/react` as `Plugin*Props`. Those two files are the contract; this page is the readable form of them. The `plugin-ui` type entry: Not in the 0.1.0 release on npm; it ships in the next one.

```tsx
import { Button, Callout, PaneHeader, Toolbar, ToolbarButton } from "@daintreehq/plugin-ui";

export default function Panel() {
  return (
    <div className="flex h-full flex-col">
      <PaneHeader
        title="main · last 20 builds"
        actions={
          <Toolbar aria-label="Build actions">
            <ToolbarButton icon="refresh" aria-label="Refresh" onClick={refresh} />
          </Toolbar>
        }
      />
      <Callout
        severity="error"
        title="Build failed"
        action={<Button onClick={retry}>Retry</Button>}
      >
        The last build exited with code 1.
      </Callout>
    </div>
  );
}
```

## Versioning and stability

`PLUGIN_UI_VERSION` is the kit's contract version, a semver string — `"1.0.0"` for this release, the first. The rules:

- **Minors are additive.** A minor version adds components, optional props, accepted values, icon names and theme token keys. The only other change a minor may make is renaming an **extended** theme token (below), with the change in the release notes.
- **Nothing is removed or narrowed within a major.** No export, prop, accepted value or core token key goes away, and no prop's accepted values shrink, until the next major version.
- **Props are validated at runtime.** Props arrive from untyped JavaScript as often as from TypeScript, so every component checks each one and ignores a value outside its type rather than throwing. A wrong value degrades to the default; it never takes the view down.
- **The export list is pinned.** The host build checks the facade's runtime exports against `HOST_FACADE_REQUIRED_EXPORTS` in `vite.config.ts`, so an export dropped from the facade fails Daintree's own build. That list is maintained by hand beside `plugin-ui.d.ts`, and the two are kept aligned in review rather than derived from each other.

Theme tokens come in two tiers:

| Tier | Groups | Stability |
| --- | --- | --- |
| Core | `surface-*`, `text-*`, `border-*`, `accent-*`, `focus-ring`, `status-*` | Stable for the whole major version |
| Extended | `terminal-*` (including the 16 ANSI colours), `syntax-*`, `activity-*`, `category-*` | Best effort; may be renamed in a minor, with a note. Read them with a fallback |

**Feature detection.** A view built against a newer kit than the running Daintree serves can fail to link: a named import the host facade does not export is an ESM link error, and the whole view module fails to load. Import the namespace and branch on what is there, which never fails to link:

```ts
import * as kit from "@daintreehq/plugin-ui";

// Daintree 0.40 and earlier serve only `Markdown`, with no version at all.
const [major, minor] = (kit.PLUGIN_UI_VERSION ?? "0.0.0").split(".").map(Number);
const hasMinor1 = major > 1 || (major === 1 && minor >= 1); // something a 1.1 added
const Avatar = kit.Avatar ?? FallbackAvatar;
```

Everything below is in 1.0.0; an export or prop a later minor adds will say which minor beside it, here and in the declarations. Declaring [`engines.daintree`](./manifest.md#enginesdaintree) tells users which release the plugin expects, but the range is advisory — an unmet one is warned about and the plugin still loads — so it is no substitute for detection. Daintree 0.40 serves only `Markdown`; everything else here arrives in the first release after it, so a plugin that uses it declares `>=0.41.0`.

## Readiness and loading

Kit components are lazy. The facade that the import map serves is small, and the host adapters behind it load as one chunk, requested the moment a view imports the kit. Until that chunk is in, a component renders nothing, so the first time a view renders it, a control could paint a frame late. Fifteen render a fallback instead, so what they wrap is there from the first frame and only their own behaviour waits: `Popover`, `EmojiPicker`, `ConfirmPopover` and `AgentPicker` render their trigger; `Tooltip`, `TruncatedTooltip`, `HoverCard` and `ContextMenu` their child; `DragDropProvider`, `Drawer`, `RefreshOverlay` and `ContextDragSource` their content; `UnreadDot` and `CountIndicator` the wrapped child; and `Form` its fields.

The host's view load path closes that gap for panel views: it starts loading the kit alongside the plugin's activation and waits for it together with the view's styles, so once the kit has loaded, a view's first committed frame already has every kit control in it; a kit that fails to load is left to each control's own boundary rather than failing the view (see [Architecture → The plugin view load path](./architecture.md#the-plugin-view-load-path)). Two exports cover everything else:

| Export | Behaviour |
| --- | --- |
| `whenPluginUiReady(): Promise<void>` | Resolves once every component renders on its first frame with no placeholder. Await it in tests and in code that measures kit output or must not paint late. Rejects when the chunk fails to load; calling it again retries. |
| `preloadPluginUi(): void` | Starts loading without waiting. Every call shares one request. Call it when a view is about to open outside the host's load path. |

`Markdown` loads its renderer separately, on its first render, and is not covered by `whenPluginUiReady`.

## Overlays, portals and layers

Tooltip bodies, menus, select lists, popovers and dialogs open in host overlays that portal to the document body, outside the view's style root. Two consequences:

- **The overlay's own chrome takes no `className`.** Those props do not exist on `DropdownMenu`, `ContextMenu`, `Dialog`, `ConfirmDialog`, `Sheet`, `CommandPalette`, `Popover`, `ConfirmPopover`, `EmojiPicker`, `AgentPicker`, `Tooltip`, `TruncatedTooltip`, `HoverCard`, or the lists and calendars that `Select`, `Combobox`, `MultiSelect`, `DatePicker` and `DateRangePicker` open: the chrome is the host's. On those fields, `className` styles the trigger only.
- **What you put inside an overlay is still yours.** Content you pass into a tooltip, popover or dialog body is re-marked as a plugin style root and tagged with your plugin, so your view's Tailwind classes apply there too and diagnostics (the Styles check, long-frame attribution) know whose it is. For something of your own that has to float, render it in a `Portal`: it marks its container as your style root and tags it with your plugin for you. A bare `createPortal` does neither, so your classes do not reach what it renders (`daintree-plugin lint` reports it as `raw-portal`); if you must use one, spread `styleRootAttributes` from `PanelViewProps` onto its container ([Views](./views.md)).

Overlays stack at the popover tier. A dialog opened from inside another modal surface — Settings, another dialog — passes `layer="nested"`, and kit overlays opened inside that dialog lift themselves above it.

Menus and popovers are rendered through React portals, so React events still bubble to the trigger's ancestors: a menu on a clickable row would also click the row. `DropdownMenu`'s and `ContextMenu`'s `stopPropagation` stops that.

## Shared vocabulary

**Status.** `Badge`'s `tone`, `Callout`'s `severity` and `SeverityIcon` share one vocabulary: `error`, `danger`, `warning`, `success`, `info`, `neutral`. `error` and `danger` are the same colour (the `status-error` class aliases the `status-danger` theme token); a `Badge` draws them identically, while a `Callout` gives `danger` — a destructive caution — its own octagon glyph. `outline` is a Badge-only, uncoloured shape. Error banners are `Callout severity="error"` with a Retry `action`; a pane that failed as a whole is `PaneState kind="error"`. There is no separate banner component.

**DOM props.** Every control that renders in the view (not in an overlay) forwards `PluginDomProps` to its root: `id`, `title`, `tabIndex`, `role`, `style`, any `aria-*` or `data-*` attribute, DOM event handlers, and `ref`. That is also what lets a kit control be a `DropdownMenu` or `Popover` `trigger`, or a `Tooltip` child. Tables below mark these components "DOM props". Every other component that renders in the view still forwards an `id` and any `data-*` attribute (`data-testid`, say) to its root (`PluginRootAttributes`), so a test can find it without a wrapper `div`. The components whose root is the control itself take any `aria-*` attribute too (`PluginAriaRootAttributes`): `Select`, `Combobox`, `MultiSelect`, `SegmentedControl`, `ToggleGroup`, `NumberInput`, `Slider`, `RangeSlider`, `TagInput`, `DatePicker`, `DateRangePicker`, `TimePicker`, `DateTimePicker`, `ColorPicker`, `MentionTextarea`, `Composer`, `SecretInput`, `ShortcutRecorder`, `CopyButton`, `DismissButton`, `ActionButton`, `SendToAgentButton`, `Toolbar`, `OverflowToolbar`, `StatusBar`, `ProgressBar`, `Meter`, `LogView`, `TerminalOutput`, `FileTree`, `Inspector` and `WorktreePicker`. Two fields draw a wrapper round their input and send these to the input, the element a test types into, rather than to the wrapper: `SearchField`'s DOM props (`ref` included) land on its `input`, and `NumberInput`'s `id`, `aria-*` and `data-*` on its `spinbutton`. Where the component sets an attribute itself (its name, its role, its state), its own value wins. The types are `PluginRootAttributes` and `PluginAriaRootAttributes` in `@daintreehq/plugin-sdk/react`.

**Icons.** Most props that take an icon take a `PluginIconSource`: an icon name, or your own element (an inline `<svg>`); a string is always read as a name, never as text. A few take a name only (`PluginIconName`): `Select` options, `Callout`'s `icon`, `DropdownMenu` and `ContextMenu` entries (`action` entries included), `Tabs` items and `SpinningIcon`. Sides are `"top" | "right" | "bottom" | "left"`; alignments `"start" | "center" | "end"`.

**Density.** Controls that sit in toolbars and filter strips take `density: "compact"`; defaults suit forms.

## Components

Props are listed in full; `?` marks optional ones.

### Actions

| Export | Props | Notes |
| --- | --- | --- |
| `Button` | `children?`, `variant?: "default" \| "secondary" \| "outline" \| "ghost" \| "subtle" \| "contrast" \| "destructive" \| "ghost-danger" \| "link" \| "pill"`, `size?: "default" \| "sm" \| "xs" \| "lg"`, `icon?`, `loading?`, `pressed?`, `disabled?`, `type?`, `className?`; DOM props | `default` is the accent-filled primary: at most one per region. `loading` overlays a spinner and blocks activation while keeping focus and width. `pressed` makes it a toggle (`aria-pressed`). `pill` is a rounded, quiet chip for floating toolbars and status strips. A button is an action, never a status: once "Approve" has happened, say so with a `Badge` or `SeverityIcon` and leave the button to what can be done next, rather than turning it into a filled "Approved". |
| `IconButton` | `icon`, `"aria-label"`, `tooltip?: ReactNode \| false`, `tooltipSide?`, `variant?: "ghost" \| "outline" \| "subtle" \| "ghost-danger"`, `size?: "default" \| "sm" \| "xs"`, `loading?`, `pressed?`, `disabled?`, `type?`, `className?`; DOM props except `title` | Icon-only; the required `aria-label` doubles as its tooltip unless `tooltip` says otherwise (`false` for none). Sizes are 32, 28 and 24 px. |
| `CopyButton` | `text: string \| (() => string \| Promise<string>)`, `tooltip?`, `tooltipSide?`, `onCopied?`, `onCopyError?`, `announcement?`, `disabled?`, `className?`; then either `"aria-label"` and `size?: "xs" \| "sm"` (icon-only), or `label`, `"aria-label"?`, `variant?: "ghost" \| "outline" \| "subtle"`, `size?: "xs" \| "sm" \| "default"` | Confirms with a check and a spoken announcement ("Copied" by default). A function `text` is read at click time; a throw counts as a failed copy. With `onCopyError` the button stays quiet about failures. The labelled form keeps its width through "Copied" and "Couldn't copy", with the glyph beside the label and any spare width after it. |
| `DismissButton` | `"aria-label"`, `onClick`, `tooltip?`, `disabled?`, `className?` | The X on a card, banner or hint. Name what goes away ("Dismiss tip"). |
| `DropdownMenu` | `trigger: ReactElement`, `items`, `side?`, `align?`, `open?`, `onOpenChange?`, `"aria-label"?`, `onCloseAutoFocus?`, `stopPropagation?` | Built from an `items` array. The trigger must accept a ref and DOM props (a kit `Button` does). `onCloseAutoFocus` runs before focus returns to the trigger; `event.preventDefault()` keeps focus where your handler moved it. |
| `ContextMenu` | `children: ReactElement`, `items`, `onOpenChange?`, `"aria-label"?`, `disabled?`, `onCloseAutoFocus?`, `stopPropagation?` | The right-click menu of `children` (a row, a card), with the same `items` as `DropdownMenu`. Shift+F10 and the Menu key open it too while focus is anywhere inside `children`, which must accept a ref and DOM props. It opens only from a gesture, so there is no `open`. A right-click opens the innermost kit `ContextMenu` only. `disabled` renders `children` with no menu. |

`DropdownMenu` entries (`PluginDropdownMenuEntry`):

| `type` | Fields |
| --- | --- |
| `"item"` (or omitted) | `label`, `onSelect`, `icon?`, `shortcut?` (a canonical combo such as `"Cmd+Enter"`, drawn in the key column), `disabled?`, `destructive?`, `description?` |
| `"checkbox"` | `label`, `checked`, `onCheckedChange`, `disabled?`, `description?` |
| `"submenu"` | `label`, `items` (any entries, submenus included), `icon?`, `disabled?`, `description?` |
| `"radio-group"` | `value`, `onValueChange`, `items: { value, label, disabled? }[]` (values non-empty and unique), `label?` heading |
| `"label"` | `label` |
| `"separator"` | — |
| `"action"` | `actionId`, `args?`, `label?`, `icon?`, `description?`, `destructive?`, `whenUnavailable?: "disable" \| "hide"`, `onDispatched?` — a row that runs one of Daintree's actions, like [`ActionButton`](#daintree-native-actions-agents-terminals-and-keys) |

`description` is a quieter second line under the label, for a row whose effect the label alone does not say ("Out of the list, still searchable"). A `submenu` row draws the host's chevron and opens its `items` in the host's own nested menu: hovering or Right Arrow opens it, Left Arrow or Escape closes it back to its row, and typing jumps between rows by label, as in every menu. A submenu with no usable rows is left out, and nesting stops six levels down.

```js
createElement(ContextMenu, {
  items: [
    { label: "Duplicate", icon: "copy", onSelect: duplicate },
    {
      type: "submenu",
      label: "Move to",
      icon: "folder",
      items: folders.map((folder) => ({ label: folder.name, onSelect: () => move(folder.id) })),
    },
    { type: "separator" },
    { label: "Delete", destructive: true, description: "Undo from the toast", onSelect: remove },
  ],
  children: row,
});
```

### Form controls

| Export | Props | Notes |
| --- | --- | --- |
| `Input` | `type?: "text" \| "search" \| "email" \| "url" \| "password" \| "number" \| "tel" \| "date" \| "time" \| "datetime-local"`, `value?`, `defaultValue?`, `onValueChange?(value)`, `placeholder?`, `name?`, `disabled?`, `readOnly?`, `required?`, `autoFocus?`, `autoComplete?`, `spellCheck?`, `maxLength?`, `min?`, `max?`, `step?`, `invalid?`, `density?: "default" \| "compact"`, `className?`; DOM props | Single-line field. `date`, `time` and `datetime-local` use the platform picker in the theme's light or dark scheme, with ISO values (`"2026-09-30"`, `"14:05"`, `"2026-09-30T14:05"`); `DatePicker`, `TimePicker` and `DateTimePicker` take the same values and are drawn by the kit, so prefer them. `onValueChange` fires beside the native `onChange`. |
| `Textarea` | `value?`, `defaultValue?`, `onValueChange?`, `placeholder?`, `name?`, `rows?`, `disabled?`, `readOnly?`, `required?`, `autoFocus?`, `spellCheck?`, `maxLength?`, `invalid?`, `density?`, `variant?: "default" \| "code"`, `resize?: "vertical" \| "none"`, `className?`; DOM props | `code` for paths, prompts and JSON. |
| `Select` | `options: (SelectOption \| SelectOptionGroup)[]`, `value?: string \| null`, `defaultValue?`, `onValueChange?`, `placeholder?`, `disabled?`, `density?`, `name?`, `id?`, `"aria-label"?`, `"aria-labelledby"?`, `"aria-describedby"?`, `className?` (trigger) | Options are `{ value, label, description?, icon?, disabled? }`, values non-empty and unique; a group is `{ label, options }`. Passing `value` at all makes it controlled, and `""`, `null` or `undefined` then shows the placeholder again (a form reset); leave it out for an uncontrolled Select. `compact` is 28 px. |
| `SegmentedControl` | `options: { value, label, disabled?, "aria-label"?, tooltip? }[]`, `value`, `onValueChange`, `"aria-label"`, `"aria-describedby"?`, `disabled?`, `fullWidth?`, `density?`, `className?` | Exactly one of a few options, with radio-group keyboard behaviour. `compact` is 24 px, for a 32 px toolbar strip. |
| `Checkbox` | `checked?: boolean \| "indeterminate"`, `defaultChecked?`, `onCheckedChange?(checked)`, `disabled?`, `invalid?`, `required?`, `name?`, `value?`, `size?: "sm" \| "md"`, `className?`; DOM props | Pair with `<label htmlFor>` or an `aria-label`. An indeterminate box resolves to `true`. |
| `Switch` | `checked?`, `defaultChecked?`, `onCheckedChange?`, `disabled?`, `name?`, `size?` (deprecated, ignored), `className?`; DOM props | An instant on/off setting, neutral (never accent) when on. In a form with a Save, use `Checkbox`. |
| `SearchField` | `value`, `onValueChange?`, `onClear?`, `placeholder?`, `"aria-label"?`, `clearLabel?`, `size?: "compact" \| "dense" \| "palette"`, `autoFocus?`, `disabled?`, `invalid?`, `className?`; DOM props | Controlled only. `onClear` shows the clear button while there is text and makes Escape clear first. Sizes are 28 (default), 24 and 38 px. |
| `FilterChip` | `children?`, `selected?`, `defaultSelected?`, `onSelectedChange?(selected)`, `count?`, `onRemove?()`, `removeLabel?`, `disabled?`, `className?`; DOM props except `aria-pressed` | One value in a filter bar above a list or table: Daintree's own filter pill, never accent, since several can be on at once. A toggle chip is pressed while its filter is on; controlled with `selected`, uncontrolled with `defaultSelected`. `count` shows "(3)", exact and grouped ("(2,172)"), and `0` on an unselected chip drops it to a quiet edge without disabling it. With `onRemove` it is an applied filter ("Status: Open"): always pressed, drawn with a ×, and removed by a click, Backspace or Delete, with `removeLabel` ("Remove filter") as its tooltip; it shows no count. A chip never grows past its container: when the row is short of room a long label ellipsises while the count and × keep their size, and the full label heads the chip's tooltip. |
| `FormField` | `label`, `description?`, `error?`, `required?`, `htmlFor?`, `orientation?: "vertical" \| "horizontal"`, `disabled?`, `children: ReactNode \| ((control) => ReactNode)`, `className?` | Wires label, description and error to the control for assistive tech. Kit `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `RadioGroup`, `NumberInput`, `Slider`, `Combobox`, `MultiSelect`, `TagInput`, `FileDropzone`, `DatePicker`, `DateRangePicker`, `TimePicker`, `DateTimePicker`, `ColorPicker` and `RangeSlider` join on their own; for your own control, pass a function and spread the `{ id, "aria-labelledby"?, "aria-describedby"?, "aria-invalid"? }` it receives. `horizontal` puts a checkbox or switch before its label and makes the row clickable; a switch is centred on the label's first line. |
| `FormFieldGroup` | `label`, `description?`, `error?`, `required?`, `disabled?`, `layout?: "stack" \| "inline"`, `children?`, `className?` | One label over a set of controls that answer it together, such as a row of checkboxes, each its own horizontal `FormField`. The label is a `FormField` label's size and tone, so the group reads as one more field. A `fieldset` named by its label: `disabled` disables every control inside. `inline` wraps the controls in a row; `stack` (the default) puts one per line. |
| `RadioGroup` | `options: { value, label, description?, disabled? }[]`, `value?: string \| null`, `defaultValue?`, `onValueChange?`, `orientation?: "vertical" \| "horizontal"`, `variant?: "card" \| "plain"`, `name?`, `disabled?`, `required?`, `"aria-label"?`, `"aria-labelledby"?`, `"aria-describedby"?`, `className?` | Exactly one of a few options you want visible at once, each with its consequence as a description. Native radios in Daintree's choice cards, so the group is one tab stop, the arrow keys move the choice, forced colours still show which is chosen, and `required` holds a form's native validation until one is picked. `plain` drops the card for a dense form. Passing `value` at all makes it controlled. For two to four short, symmetric values use `SegmentedControl`; for more than about six, `Select`. |
| `NumberInput` | `value?: number \| null`, `defaultValue?`, `onValueChange?(value \| null)`, `min?`, `max?`, `step?` (1), `precision?`, `unit?`, `stepper?` (true), `placeholder?`, `name?`, `disabled?`, `readOnly?`, `required?`, `invalid?`, `autoFocus?`, `density?`, `"aria-label"?`, `"aria-labelledby"?`, `"aria-describedby"?`, `className?` | A `spinbutton` on the host `Input`. Typing is free and commits on blur or Enter, rounded to `precision` (by default the step's own decimals) and always within `min`/`max`; text that is not a number marks the field invalid while you type and reverts on commit, and Escape drops an edit. Up/Down and the stepper buttons step from the number in the field, typed or not; Shift or Page Up/Down step ten, Home/End jump to the bounds. `unit` is drawn inside the field beside the number, never over it (in a narrow column the unit ellipsises first, the number keeps room for four digits, and nothing is drawn past the field's edge; when the stepper buttons would no longer fit beside that, both hide together and come back once the field is wide enough for them, while the keys go on stepping), and spoken with the value; the stepper buttons stay out of the tab order, as a native spin button's do, and a `readOnly` field shows none. The spoken value follows the number in the field as it is typed, and there is none while the text is empty or not a number. An empty field commits `null`, or reverts when `required`. |
| `Slider` | `value?`, `defaultValue?`, `onValueChange?`, `onValueCommit?`, `min?` (0), `max?` (100), `step?` (1), `formatValue?(value)`, `showValue?`, `name?`, `disabled?`, `"aria-label"?`, `"aria-labelledby"?`, `"aria-describedby"?`, `className?` | A native range drawn in neutral inks: the track fills with the primary ink up to the thumb and is the input-edge ink past it, and the thumb is a field-coloured disc ringed in the primary ink, so it stands apart from both in either theme. The focus ring is its one accent; keyboard and assistive-tech behaviour are the native range's. A value off the step snaps to the nearest one from `min`, as the native range does, before it is shown or spoken. `formatValue` is spoken as `aria-valuetext` and shown by `showValue`. `onValueChange` fires on every move, `onValueCommit` when a drag or key press ends: save there. One thumb; for a low and a high value, use `RangeSlider`. |
| `Combobox` | `options` (as `Select`), `value?: string \| null`, `defaultValue?`, `onValueChange?`, `placeholder?`, `searchPlaceholder?`, `onSearchChange?(query)`, `filter?: "contains" \| "none"`, `loading?`, `emptyMessage?`, `allowCustomValue?`, `disabled?`, `density?`, `name?`, `id?`, `"aria-label"?`, `"aria-labelledby"?`, `"aria-describedby"?`, `className?` (trigger) | A `Select` with a search: the same trigger, opening the picker search strip over a virtualised list, so a thousand options cost what forty do. Typing filters by label and description; Up/Down/Home/End move the cursor, Enter picks, Escape clears the query and then closes. For options you fetch as the user types, pass `filter="none"`, load from `onSearchChange` and set `loading` while you do: the list says "Loading…" after 400 ms rather than "No matches". The trigger keeps the label of a pick your options no longer list. `allowCustomValue` offers the typed text as a value of its own. Disabling it closes an open list, and a disabled `name`d field submits nothing, as a disabled native one does. Inside a `FormField` with an `error` (or given `aria-invalid`) the trigger takes the error edge, as `Input` does. |
| `MultiSelect` | `options`, `value?: string[]`, `defaultValue?`, `onValueChange?(values)`, `max?`, `maxChips?` (3), and the rest of `Combobox`'s props except `allowCustomValue` | Labels, assignees: the `Combobox` list with a check box on each row, staying open while you toggle. The trigger shows as many of the first `maxChips` choices as chips as its width holds (at least one, truncating) and the rest as "+N", and is read as the whole list. The list is `aria-multiselectable`, each row's membership is its `aria-checked`, and the cursor is drawn apart from it. Once `max` is reached the unchecked rows are disabled. Values come back in the order they were chosen. |
| `TagInput` | `value?: string[]`, `defaultValue?`, `onValueChange?`, `validate?(tag, tags) => boolean`, `max?`, `placeholder?`, `disabled?`, `invalid?`, `"aria-label"?`, `"aria-labelledby"?`, `"aria-describedby"?`, `className?` | Free-text tags in one field: Enter or a comma adds, a pasted list splits on commas and new lines (replacing any selected text, as a plain paste would), Backspace in the empty field removes the last tag, and each chip has its own remove button, which hands focus to the next chip's or to the field. A tag already there, ignoring case, is not added twice. A tag `validate` refuses (or one past `max`) stays in the field, marked invalid, to be fixed or cleared. For choosing from known values use `MultiSelect`. |
| `FileDropzone` | `onFiles(files)`, `onReject?(files)`, `accept?`, `multiple?`, `disabled?`, `label?`, `description?`, `icon?` (`upload`), `browseLabel?`, `children?`, `className?` | A dashed drop target with a Choose file… button that opens the system file dialog; a click anywhere on the zone opens it too. The dashed edge is the strong border at rest and steps up to the secondary ink, with a light fill, while files are dragged over it. `accept` works as on `<input type="file">` (`.md`, `image/*`, `application/pdf`): the dialog offers only those, and dropped files it rules out go to `onReject`. Without `multiple`, a drop of several keeps the first. See [Files from the user](#files-from-the-user) for what a `File` gives you. |

### Files from the user

A view is part of Daintree's own window, so `FileDropzone` (or your own `<input type="file">`) hands you standard `File` objects: `name`, `size`, `type`, `lastModified`, and the contents through `file.text()`, `file.arrayBuffer()` or `file.stream()`. A view never gets the file's path on disk, and the host has no file-open dialog that returns paths. To act on the contents in your worker, read them in the view and send them over a channel (an `invoke`'s arguments may be up to 4 MiB); to work with files the user already has in the project, use [`host.fs`](./host-api.md#fs--host-mediated-scope-contained-filesystem) in the worker and a `FileTree` or `Combobox` in the view to pick among them. A drag from Daintree's own file browser carries paths rather than files, so a `FileDropzone` does not take it.

### Text inputs

Richer fields for views that talk to agents, APIs and forges: prompts with mentions and commands, names renamed in place, headers and environment variables, tokens and keyboard shortcuts.

| Export | Props | Notes |
| --- | --- | --- |
| `MentionTextarea` | `value?`, `defaultValue?`, `onValueChange?`, `triggers?: (string \| { char, title?, emptyMessage?, atStart? })[]`, `getSuggestions?(trigger, query) => MentionSuggestion[] \| Promise<…>`, `onSuggestionInsert?(suggestion, trigger)`, `onKeyDown?`, `onFocus?`, `onBlur?`, `placeholder?`, `name?`, `disabled?`, `readOnly?`, `autoFocus?`, `spellCheck?`, `maxLength?`, `invalid?`, `minRows?` (1), `maxRows?` (8), `variant?: "default" \| "code"`, `density?`, `ref?` (the textarea), `className?`; `id`, `data-*` and `aria-*` | A `Textarea` that grows with its text up to `maxRows`, then scrolls, and opens the host composer's own autocomplete menu when a trigger is typed at the start of the text or after a space (`atStart` holds a slash command to the very start). Suggestions are `{ id, label, insertText?, description?, badge?, disabled? }`, at most 50 shown. While an async reply is out the last rows stay up, dimmed, and a reply that lands after a newer query is dropped. Focus never leaves the text: Up and Down move the highlighted row (skipping disabled ones), Enter or Tab inserts it, Escape closes the menu (and keeps that trigger closed until you leave it) without reaching the pane. The inserted text is `insertText`, or the trigger and label (`@alice`), followed by one space, with the caret after it. Each row shows the token it inserts, as the host's own menu does, unless `insertText` says otherwise. The menu opens above the line unless there is plainly more room below, and stays within the field's width where it can. `onKeyDown` hears every key the menu did not take. |
| `Composer` | `value?`, `defaultValue?`, `onValueChange?`, `onSubmit?(text)`, `submitOn?: "mod+enter" \| "enter"`, `busy?`, `onStop?`, `disabled?`, `placeholder?`, `triggers?`, `getSuggestions?`, `onSuggestionInsert?`, `attachments?: { id, name, detail?, icon?, status? }[]` (as `AttachmentList`), `onRemoveAttachment?(id)`, `onAttach?(files)`, `accept?`, `maxLength?`, `toolbar?: ReactNode`, `submitLabel?` ("Send"), `minRows?` (2), `maxRows?` (10), `autoFocus?`, `ref?` (the textarea), `className?`; `id`, `data-*` and `aria-*` (the text) | The agent composer: a `MentionTextarea` in one field-coloured shell with the field's focus ring, attachment chips above the text and a footer below it with the attach button (only with `onAttach`), your `toolbar`, a character count once the text passes 80% of `maxLength`, and Send, a neutral high-contrast button since the ring already spends the accent. Cmd/Ctrl+Enter sends and Enter is a new line; with `submitOn="enter"`, Enter sends too and Shift+Enter is the new line. Enter while the suggestion menu is up inserts rather than sends, and while its rows are still loading it waits rather than sending the half-typed query. Send is held while the text is empty and there are no attachments. While `busy`, Send becomes Stop (and Escape anywhere in the composer stops too), sending is held and the text stays editable for the next message. The suggestion menu hangs above the whole shell rather than over its chips, and Send and Stop are one button, so focus stays on it when it changes. Files dropped on the shell or pasted into the text go to `onAttach`, filtered by `accept`; removing a chip hands focus to the next chip, or the text. Clearing the draft after a send is yours to do. |
| `InlineEdit` | `value`, `onCommit(value) => void \| Promise<void>`, `"aria-label"`, `validate?(value) => string \| null`, `allowEmpty?`, `placeholder?`, `blurAction?: "commit" \| "cancel"`, `activation?: "click" \| "doubleClick"`, `selectOnEdit?: "all" \| "stem" \| "end"`, `editing?`, `onEditingChange?`, `maxLength?`, `disabled?`, `size?: "sm" \| "md" \| "lg"`, `className?`; `id` and `data-*` | A name you rename in place, drawn and behaving like a pane title's rename: a click (or double-click with `activation`), F2 or Enter turns the text into the host's chrome-free rename field with the text selected (`stem` stops before a file extension). Enter commits the trimmed value and returns focus to the text, Escape cancels without the key reaching the pane, and leaving the field commits unless `blurAction="cancel"`. An unchanged value commits nothing; an emptied one reverts on blur and is refused on Enter, unless `allowEmpty`. A `validate` message keeps the field open with the message under it; a validator that throws refuses too. Escape does nothing while a commit is pending. When `onCommit` returns a promise the field holds read-only with a spinner until it settles; a rejection keeps it open with the error's message. |
| `KeyValueEditor` | `value?: { id?, key, value, secret? }[]`, `defaultValue?`, `onValueChange?(pairs)`, `"aria-label"`, `onValidityChange?(valid)`, `validateKey?(key) => string \| null`, `caseInsensitiveKeys?`, `allowDuplicateKeys?`, `reorderable?`, `keyLabel?`, `valueLabel?`, `keyPlaceholder?`, `valuePlaceholder?`, `addLabel?` ("Add"), `max?`, `allowSecretToggle?`, `disabled?`, `className?`; `id` and `data-*` | Environment variables, headers, mappings: a row of compact key and value fields per pair, a remove button on each and an Add button that puts focus in the new key. A value marked `secret` is a `SecretInput`; `allowSecretToggle` adds a lock toggle per row. A key that repeats another (ignoring case with `caseInsensitiveKeys`, as HTTP headers want) and a value with no key are marked on their row; a fresh empty row is not an error. `onValidityChange` tells you when that changes, to hold your Save. Pasting `KEY=value`, `export KEY=value` or `Key: value` lines into a key field adds a row per line (quotes and `#` comments dropped). Rows keep an `id`, added when missing, so give it back. `reorderable` draws a grip per row and reorders like `SortableList`. |
| `ListEditor` | `value?: string[]`, `defaultValue?`, `onValueChange?(items)`, `"aria-label"`, `onValidityChange?`, `validate?(item) => string \| null`, `allowDuplicates?`, `reorderable?`, `placeholder?`, `addLabel?`, `max?`, `variant?: "default" \| "code"`, `disabled?`, `className?`; `id` and `data-*` | `KeyValueEditor` for single values: hosts, globs, scopes. Pasting several lines adds a row per line; a repeated item is marked, and empty rows are ignored rather than refused. `code` sets the fields in the mono face. |
| `SecretInput` | `value?`, `defaultValue?`, `onValueChange?`, `stored?`, `storedHint?`, `onReplace?`, `onCancelReplace?`, `onClear?`, `onSubmit?(value)`, `allowCopy?`, `revealable?` (true), `placeholder?`, `name?`, `disabled?`, `invalid?`, `autoFocus?`, `density?`, `"aria-label"?`, `"aria-labelledby"?`, `"aria-describedby"?`, `className?`; `id`, `data-*` and `aria-*` | A token or API key: a masked mono field with an eye toggle inside it; a press on the toggle leaves focus in the field, so a save-on-blur around it is safe. Turning `revealable` off hides a shown value. Copying, cutting and dragging the value out are blocked unless `allowCopy`. With `stored`, a secret is saved that the view never holds: the field reads "Saved ••••••••" and the last few characters of `storedHint`, beside Replace and, with `onClear`, Clear (confirming is yours to do). Replace empties and focuses the field; Cancel or Escape goes back to the saved state with focus on Replace. Enter with `onSubmit` while replacing returns to the saved state once `onSubmit` returns, or once its promise resolves; while a promise is out the field holds read-only (a spinner after 400 ms) and Cancel stays available, and a rejection keeps the typed value to try again. The saved state also returns, with the draft dropped, when `stored` turns from false to true. Keep the secret in the worker's secret settings, never in view state. |
| `ShortcutRecorder` | `value?: string \| null`, `defaultValue?`, `onValueChange?(combo \| null)`, `allowChords?`, `requireModifier?` (true), `validate?(combo) => string \| null`, `getConflict?(combo) => string \| null`, `checkHostConflicts?` (true), `placeholder?` ("Not set"), `disabled?`, `density?: "default" \| "compact"`, `"aria-label"?`, `"aria-labelledby"?`, `"aria-describedby"?`, `className?`; `id`, `data-*` and `aria-*` | Focus it (or click it) and press a shortcut; it records in the app's combo notation (`"Cmd+Shift+K"`, Cmd being Ctrl off macOS), the notation `KbdChord` takes, and `useHotkeys` for a single-step combo. While it records, Daintree's own shortcuts stand down. Modifiers held so far show as you press them. `allowChords` records a second step pressed within a second ("Cmd+K Cmd+S"), with the host's draining bar under the field. Escape stops recording, Enter or Space starts it again, a plain Backspace or Delete clears, and a plain Tab or Shift+Tab always moves on. A first key that is bare or only Shift+key is refused unless `requireModifier` is false (F-keys pass), so a shortcut never types into a field. AltGr input is ignored, since the host never matches it. A combo Daintree already uses is flagged with the action's name, since Daintree's binding wins; `getConflict` adds your own warnings. While a new chord is under way the warnings follow its first step rather than the shortcut it would replace, and leaving the window ends recording with the old shortcut kept. `compact` matches a compact `Input`. |

```tsx
import { Composer, KeyValueEditor, SecretInput } from "@daintreehq/plugin-ui";

<Composer
  aria-label="Request for the agent"
  value={draft}
  onValueChange={setDraft}
  onSubmit={(text) => send(text).then(() => setDraft(""))}
  busy={running}
  onStop={cancel}
  triggers={[
    { char: "@", title: "Files" },
    { char: "/", title: "Commands", atStart: true },
  ]}
  getSuggestions={(trigger, query) => (trigger === "@" ? searchFiles(query) : commands(query))}
  attachments={attachments}
  onAttach={addFiles}
  onRemoveAttachment={removeAttachment}
/>;

<KeyValueEditor
  aria-label="Headers"
  value={headers}
  onValueChange={setHeaders}
  caseInsensitiveKeys
  addLabel="Add header"
  onValidityChange={setHeadersValid}
/>;

<SecretInput
  aria-label="API token"
  stored={tokenSaved}
  storedHint={tokenTail}
  value={token}
  onValueChange={setToken}
  onSubmit={saveToken}
  onClear={confirmClearToken}
/>;
```

### Status and feedback

| Export | Props | Notes |
| --- | --- | --- |
| `Badge` | `children?`, `tone?: "neutral" \| "outline" \| "error" \| "danger" \| "warning" \| "success" \| "info"`, `size?: "xs" \| "sm" \| "md"`, `shape?: "default" \| "pill"`, `className?`; DOM props | Presentation only; wrap it in a `Button` to make it clickable. |
| `Callout` | `severity`, `children?`, `title?`, `action?`, `actionPlacement?: "inline" \| "below"`, `onDismiss?`, `dismissLabel?`, `variant?: "box" \| "strip"`, `icon?`, `size?: "default" \| "compact"`, `className?`; DOM props except `title` | An inline message whose glyph and tint follow `severity`. `strip` is the full-width band across the top of a pane or popover: `title` is its headline and `children` one line under it; a strip never stands green (`success` draws neutral with the check glyph) and forwards `id`, `role`, `aria-*` and `data-*`, but not handlers, `style` or `ref`. `icon` replaces the info mark on `neutral` only. `role="alert"` or `role="status"` reaches the root for a message that should be announced. |
| `SeverityIcon` | `severity`, `size?` (16), `"aria-label"?`, `className?` | The one glyph per severity: error ✕-circle, warning triangle, danger octagon, success check, info and neutral `i`. Label it when the glyph is the only statement of the severity. |
| `Spinner` | `size?: "xs" \| "sm" \| "md" \| "lg" \| "xl" \| "2xl"`, `className?` | Decorative: say what is loading in text beside it. |
| `SpinningIcon` | `icon` (a name), `active`, `size?` (16), `className?` | Spins while `active` and always finishes at least one full turn before stopping. |
| `ProgressBar` | `value?: number \| null` (0–1), `indeterminate?`, `label`, `valueText?`, `size?: "default" \| "thin"`, `className?` | Always neutral. Omitted or `null` `value` is indeterminate. `thin` is 2 px. |
| `Meter` | `value`, `max?` (1), `label`, `showLabel?` (true), `valueText?`, `thresholds?: { warning?, danger? }` (fractions of `max`), `className?`; `aria-*`, `id` and `data-*` on the meter | How much of a limit is used: a quota, a disk, a rate limit. The quota meters' heavier track rather than `ProgressBar`'s, announced as a `meter`. Neutral below its thresholds, then the warning or danger fill with that severity's glyph beside the value and the tone in the spoken value, so colour is never the only signal; no thresholds, always neutral. The label sits over the bar with the value on its right (the percentage unless `valueText` says "812 of 1,000"); `showLabel={false}` drops the visible label and puts the value beside the bar, for a meter in a `SettingsRow` that already names it. |
| `Skeleton` | `children?`, `label?` ("Loading"), `className?` | The accessible loading region; put `SkeletonBone` and `SkeletonText` inside. |
| `SkeletonBone` | `className?`, `heightPx?`, `shimmer?`, `immediate?` | One placeholder shape. Appears after a short delay to avoid flicker; `immediate` skips it, for a placeholder that replaces content already on screen. |
| `SkeletonText` | `lines?` (3), `shimmer?`, `immediate?`, `className?` | Ragged placeholder lines. |
| `SkeletonHint` | `message?`, `onCancel?`, `onRetry?`, `firstThreshold?` (8000), `secondThreshold?` (13000), `actionThreshold?` (20000), `className?` | Invisible for 8 s, then "Still working…", then escalates, offering Cancel with the first hint and Retry once the wait is long. Place it beside the `Skeleton`, never inside it — both are live regions. |
| `EmptyState` | `title`, `variant?: "zero-data" \| "filtered-empty" \| "user-cleared"`, `scale?: "canvas" \| "sidebar" \| "popover"`, `description?` (canvas only), `icon?`, `action?`, `className?` | `zero-data` invites an action; `filtered-empty` has no icon; `user-cleared` has no description or action. A `canvas` state fills its container and centres in it, the way the host's own pane states do, so a detail pane's empty state sits in the middle of the pane rather than at its top; `sidebar` and `popover` keep their own height. |
| `PaneState` | `kind: "loading" \| "empty" \| "error"`, `title`, `description?`, `icon?` (empty only), `action?`, `onRetry?` (error only), `retryLabel?`, `onCancel?` (loading only), `className?` | A whole pane's state in Daintree's pane frame. `loading` stays blank for 400 ms, then shows a spinner and the title; `error` is announced and draws Retry when `onRetry` is given. For an error inside content that still renders, use `Callout`. |

### Text, keys and people

| Export | Props | Notes |
| --- | --- | --- |
| `Markdown` | `source`, `basePath?`, `rootPath?`, `className?`, `fontSize?: "2xs" \| "xs" \| "sm" \| "base" \| "lg" \| "xl" \| "2xl" \| "3xl"`, `align?: "center" \| "start"` | Daintree's own renderer: GFM, highlighted fences, the app's document typography. Raw HTML is dropped, never rendered, so untrusted text is safe. `http(s)` and `mailto` links open in the browser; relative links open in the file viewer and relative images load from disk while they stay inside `rootPath` (default: the directory `basePath` resolves to; a `basePath` ending in a Markdown extension is read as the document itself). The reading measure is centred like Daintree's document views; `align="start"` sets it against the leading edge, in line with the fields of a form or editor above it. |
| `Kbd` | `children`, `density?: "default" \| "compact"`, `className?` | One literal key cap. |
| `KbdChord` | `shortcut`, `density?: "default" \| "compact" \| "bare"`, `foreground?: "secondary" \| "primary" \| "inverse"`, `"aria-label"?`, `className?` | A combo such as `"Cmd+Shift+P"` or a two-step `"Cmd+K T"`, drawn with the platform's glyphs and spoken in words. `bare` drops the key boxes where every row has a binding. |
| `Tooltip` | `children: ReactElement`, `content`, `side?`, `align?`, `delayDuration?`, `disabled?` | A hover card on one child that accepts a ref and DOM props. Empty, `null` or `false` content renders the child alone. The child shows while the kit loads. |
| `TruncatedTooltip` | `children: ReactElement`, `content`, `side?`, `align?`, `focusable?` (true), `isTruncated?` | Opens only while the child's `truncate` text is cut off. `focusable={false}` inside a row that already owns the keyboard. `isTruncated` overrides the overflow check for text your code shortens itself. |
| `Avatar` | `name`, `src?`, `size?: "xs" \| "sm" \| "md" \| "lg"` (16/20/24/32 px, default `sm`), `shape?: "circle" \| "square"`, `tooltip?`, `decorative?`, `className?` | Falls back to initials when there is no `src` or it fails to load. `square` says "bot or app, not a person"; `decorative` hides it from assistive tech beside the name in text. |
| `AvatarGroup` | `avatars: { name, src?, shape? }[]`, `max?` (4), `size?: "xs" \| "sm" \| "md" \| "lg"`, `"aria-label"?`, `className?` | Overlapping `Avatar`s for the people on something, each with its name as a tooltip, cut out from each other with the pane's canvas colour and drawn with a hairline edge so the discs stay apart on a dark pane. They overlap only as far as every disc's initials stay whole at each size. Past `max` the rest fold into a "+N" that takes focus and lists them in its tooltip (ten names, then a count). `aria-label` ("Reviewers") makes it a named group. |
| `HighlightedText` | `text`, `query?`, `ranges?: [start, end][]`, `className?` | Text with its search matches on a neutral band, the host's search highlight: never accent and never bold, so a row does not reflow as the user types. `query` marks the first case-insensitive occurrence, which is what a substring filter tested; `ranges` are inclusive offsets you computed (fuse.js `indices` as they come), merged where they touch. |

### Type, inline elements and status marks

The app's type ramp, colour roles and small marks as components, so a view never spells a font size or a status colour by hand.

```tsx
import { CodeBlock, CountIndicator, Heading, IconButton, InlineCode, Link, PathLabel, StatusDot, Text } from "@daintreehq/plugin-ui";

<Heading level={2}>Flaky login test</Heading>
<Text as="p" tone="secondary">
  Fails on <InlineCode>main</InlineCode> about one run in ten. See{" "}
  <Link href="https://example.com/runs/812" externalIcon>run 812</Link> and{" "}
  <Link href="tests/login.spec.ts" rootPath={projectRoot}>the spec</Link>.
</Text>
<CodeBlock code={snippet} language="ts" lineNumbers highlightLines={[3]} maxHeight={240} />
<PathLabel path="src/components/Settings/AgentSettings.tsx" />
<StatusDot state="running" label="Running" pulse />
<CountIndicator count={unread} label={`${unread} unread`}>
  <IconButton icon="inbox" aria-label="Inbox" />
</CountIndicator>
```

| Export | Props | Notes |
| --- | --- | --- |
| `Text` | `children?`, `size?: "3xs" \| "2xs" \| "xs" \| "sm" \| "base" \| "lg" \| "inherit"`, `tone?: "primary" \| "secondary" \| "muted" \| "danger" \| "success" \| "warning" \| "accent" \| "inherit"`, `mono?`, `weight?: "normal" \| "medium" \| "semibold"` (inherited when omitted), `truncate?`, `as?: "span" \| "p" \| "div" \| "strong" \| "em" \| "small"`, `className?`; DOM props | The ramp the app draws with: `sm` (14px, the default) for reading text, `xs` (12px) for dense rows and secondary lines, `2xs` and `3xs` (11 and 10px) for labels and metadata, `base` and `lg` for emphasis. `primary` (the default) for body text, `secondary` for supporting text and icons, `muted` only for what nobody has to read (it has no contrast floor on some dark themes). The status tones state an outcome; `accent` is at most one signal per region. `inherit` takes the surrounding size or colour, for a run inside other text. `truncate` makes it a block cut with an ellipsis; wrap it in `TruncatedTooltip` to show the rest. |
| `Heading` | `children?`, `level?: 1 \| 2 \| 3 \| 4` (2), `as?: "h1" … "h6" \| "div"`, `tone?: "primary" \| "secondary"`, `truncate?`, `className?`; DOM props | The app's heading sizes, all semibold: 1 is 18px (a pane or dialog title), 2 is 16px (a page section), 3 is 14px (a group), 4 is 12px (a sub-group). `level` also picks the element; `as` keeps the size and changes the element, so the document outline stays right (`as="div"` is still a heading at that level to assistive tech). For the small uppercase label over a group, use `SectionLabel`. |
| `Link` | `href`, `children?`, `basePath?`, `rootPath?`, `externalIcon?`, `className?`; DOM props | An inline link in the app's link colour, underlined at rest so it reads as a link without its colour, the underline thickening on hover. A click is routed exactly as a `Markdown` link's: `http(s)` and `mailto` open in the browser, and a relative or absolute path opens in Daintree's file viewer while it resolves inside `rootPath` (`basePath` and `rootPath` mean what they mean on `Markdown`; with neither, a path opens nothing). Nothing ever navigates the view. An `onClick` that calls `preventDefault()` takes the click over. `externalIcon` draws a small arrow after a web link and tells assistive tech it opens in the browser. For an action, use `Button variant="link"`. |
| `InlineCode` | `children?`, `className?` | A code span in running text: the mono face a step smaller than its surroundings, on a recessed chip. |
| `CodeBlock` | `code`, `language?`, `lineNumbers?`, `highlightLines?: number[]`, `startLine?` (1), `maxHeight?` (px), `wrap?`, `copyable?` (true), `"aria-label"?`, `className?` | A read-only snippet highlighted with the grammars and token colours of Daintree's diffs and Markdown fences, with a Copy button. `language` takes a grammar or fence alias (`ts`, `tsx`, `json`, `bash`, `python`, `yaml`, `go`, `rust`, …); an unknown one shows plain text. The highlighter loads on the first block, so a block paints plain for a moment and then takes colour with nothing moving. Line numbers are never read or copied. `highlightLines` (numbered as the gutter counts, from `startLine`) marks lines with a tint and an edge and exposes them as marked text. Past `maxHeight` the block scrolls, and a scrolled block is reachable from the keyboard; `wrap` wraps long lines instead of scrolling sideways. |
| `PathLabel` | `path`, `mono?`, `focusable?` (true), `className?` | A file path on one line that gives way in the middle: the directory ellipsises from its start while the file name stays whole (`…/Settings/AgentSettings.tsx`), and only once the directory is gone does the name itself cut. While anything is cut, the full path shows in a tooltip, broken only between folders. `focusable={false}` inside a row that already owns the keyboard. |
| `VisuallyHidden` | `children?`, `as?: "span" \| "div"` | Read by assistive tech, not drawn: a label for a glyph-only cell, the rest of a sentence a visual layout abbreviates. |
| `LiveRegion` | `children?`, `politeness?: "polite" \| "assertive"`, `atomic?` (true), `visuallyHidden?`, `className?` | A mounted region whose changes are read out (`status`, or `alert` when assertive). Keep it mounted and change its children: a region that appears with its message already in it is often not read. `assertive` interrupts, so keep it for failures. |
| `useAnnounce()` | returns `(message, { politeness? }?) => void` | Speaks a one-off message ("Saved", "3 results") through the host's announcer, the one the kit's own `CopyButton` uses. It reaches VoiceOver even from under a modal dialog, where a live region of your own is not read. The function is stable across renders; empty messages are ignored. |
| `StatusDot` | `state: "running" \| "idle" \| "waiting" \| "error" \| "success" \| "neutral"`, `label?`, `pulse?`, `size?: "sm" \| "md"`, `className?` | The app's 6px activity dot (`md` is 8px). `running` and `waiting` wear the agent working and waiting hues, `error` and `success` the status colours, `neutral` the secondary ink, and `idle` is a hollow ring, so the state never rests on colour alone. `pulse` is the activity pulse, still under reduced motion. With `label` it is a named image; without, decorative, so say the state in text beside it. |
| `StateGlyph` | `state` (as `StatusDot`), `label?`, `size?` (16), `className?` | The same states as the app's glyphs, for a row that wants an icon-sized mark: `running` the agent working spinner, `waiting` the amber ring, `idle` a plain ring, `success` and `error` the severity glyphs, `neutral` a ring with a bar. The spinner stops under reduced motion. |
| `ColoredLabel` | `color` (`#rgb` or `#rrggbb`), `children?`, `size?: "xs" \| "sm" \| "md"`, `shape?: "default" \| "pill"`, `variant?: "tint" \| "dot"`, `className?`; DOM props | A label in a colour the user chose, like a GitHub or GitLab label, drawn as a `Badge`: a tint of the colour with a hairline edge, and the colour itself as the text, moved lighter or darker (keeping its hue) until it reads at 4.5:1 on that tint over the pane, a raised panel and a hovered row in the active theme. So `#ffffff` and `#000000` both stay legible in a light and a dark theme, and the label follows a theme switch. `variant="dot"` is the chip Daintree's own forge labels use, a neutral pill with the colour on a dot before the name, for a dense row where a run of tinted labels would be loud. A long name wraps to two lines and the chip shrinks with its row, as Daintree's forge labels do. A colour that is not hex draws a neutral badge. For your own fixed tones, use `Badge`. |
| `UnreadDot` | `children?`, `visible?` (true), `label?`, `placement?: "top-right" \| "top-left" \| "bottom-right" \| "bottom-left"`, `className?` | The app's neutral unread pip. Around `children` it sits on their corner, cut out from them; alone it is an inline dot. `label` ("Unread replies") becomes the description of a single element child such as an `IconButton`, so it is read when the button takes focus. Never accent: several can show at once. |
| `CountIndicator` | `count`, `children?`, `max?` (99), `showZero?`, `label?`, `placement?`, `className?` | A count capped at `max` ("99+"). Alone it is the count pill `NavList` and `Tabs` draw; around `children` it is a solid bubble overlapping their corner, inside their box, so it is never clipped by the header or toolbar it sits in. On a 24px toolbar button a three-character count covers most of the icon, and Daintree marks its own toolbar buttons with a dot rather than a number, so prefer `UnreadDot` there and keep numbers for larger anchors or inline. Zero draws nothing unless `showZero`. `label` ("12 unread") is spoken in place of the numeral, and describes a single element child as `UnreadDot`'s does. |
| `Portal` | `children?`, `container?: Element \| null` | Renders its children outside the view, into the document body or `container`, inside a box-less wrapper marked as your plugin's style root, so your classes apply there and diagnostics know whose it is. Position and layer what you put in it yourself. See [Overlays, portals and layers](#overlays-portals-and-layers). |

### Daintree-native: actions, agents, terminals and keys

Components that speak Daintree's own concepts, so a view that runs an action, names an agent or shows a terminal does it exactly as the app does: the same titles and key bindings, the same agent marks and state glyphs, the same wording. They read only what a view can already reach. Actions are the catalogue `host.actions` reads and `host.dispatch` runs, which need no capability; the dispatch runs with the plugin's source, so the same deny list and confirmation gate apply. Agent marks come from the static agent registry. Everything about live agents — which panes exist, their observed state — is what your worker gets from `host.agents.list()` (gated on `agent:read`) and hands the view, and drafting into an agent is your worker's `host.sendToAgent` (gated on `agent:input`). Nothing here reads a terminal on your behalf.

```tsx
import {
  ActionButton,
  AgentBadge,
  AgentPicker,
  AgentStateIndicator,
  ContextDragSource,
  DropdownMenu,
  KeyHints,
  SendToAgentButton,
  TerminalSnapshot,
} from "@daintreehq/plugin-ui";

// `panes` is what your worker's host.agents.list() resolved, handed over a channel.
<TerminalSnapshot title={pane.title} agentId={pane.agentId} state={pane.observedState} text={tail} />
<AgentBadge agentId="claude" state="waiting" />
<AgentStateIndicator state="completed" since={lastChange} /> {/* "Output stopped 2m ago" */}
<AgentPicker
  agents={panes}
  worktreeId={worktreeId}
  launchAgents={["claude", "codex"]}
  onSelect={(choice) => invoke(pluginId, "handOff", { choice, text: card.body })}
/>
<SendToAgentButton text={card.body} title={card.title} worktreeId={worktreeId} />
<ContextDragSource text={card.body} title={card.title} sourceLabel="Kanban" />
<ActionButton actionId="worktree.refresh" icon="refresh" iconOnly />
<DropdownMenu trigger={menuButton} items={[{ type: "action", actionId: "panel.close" }]} />
<KeyHints hints={[{ shortcut: "Enter", label: "Open" }, { shortcut: "Cmd+K", label: "Search" }, { shortcut: "Escape", label: "Close" }]} />
```

| Export | Props | Notes |
| --- | --- | --- |
| `ActionButton` | `actionId`, `args?`, `children?` (the label), `icon?`, `iconOnly?`, `variant?`, `size?`, `whenUnavailable?: "disable" \| "hide"`, `disabled?`, `disabledReason?`, `tooltipSide?`, `onDispatched?(outcome)`, `className?`; `id`, `aria-*` and `data-*` | Runs the action as `host.dispatch(actionId, args)` would. The label defaults to the action's own title, the tooltip carries the user's current binding for it (rebinding updates it) and `aria-keyshortcuts` says it too. Actions carry no icon of their own, so name one. An action a plugin may not run — on the plugin deny list, or one that asks for confirmation (`danger: "confirm"`, which a plugin can never complete) — and one disabled right now draw disabled, still focusable, with the reason in the tooltip and spoken with the button; `whenUnavailable="hide"` draws nothing instead. A `restricted` action is treated as unknown, as `host.actions.get` treats it. Availability is read as it renders and again on hover and focus. An action this Daintree does not know draws nothing unless you give it a label. Availability has no change event, so a hidden button shows again on its next render. `onDispatched` hears `{ ok, error?: { code, message } }`; without it a failed run is shown as a toast in your plugin's name, unless the action already reported the failure itself. Nothing is reported once the button has unmounted. `iconOnly` draws an `IconButton` named by the label. |
| `AgentAvatar` | `agentId`, `size?: "xs" \| "sm" \| "md" \| "lg"` (12/16/20/24 px, default `sm`), `state?`, `label?`, `decorative?`, `className?` | The agent CLI's mark from Daintree's registry, in its brand ink, as its tabs and toolbar draw it; an id the registry lacks draws the terminal glyph. `state` adds the toolbar's corner pip, by its rule: only `waiting` and `directing`, the states that want a human, draw one, in the hue of that state's glyph, so a pip always means "look here". Named "Claude" (with the state when it pips) unless `decorative`. |
| `AgentBadge` | `agentId`, `label?`, `size?: "sm" \| "md"`, `state?`, `className?` | The mark and the agent's name inline, 12 or 14 px. |
| `AgentStateIndicator` | `state: "idle" \| "working" \| "waiting" \| "directing" \| "completed" \| "exited"`, `since?` (epoch ms), `variant?: "label" \| "glyph"`, `size?: "sm" \| "md"`, `label?`, `className?` | The app's state glyph (the working spinner, the waiting ring, …) and what was seen on the terminal, worded as an observation and never as a conclusion: "Output active for 3m", "Prompt on screen", "Unsent draft", "Output stopped 2m ago", "Exited 1h ago". Agent state is read off terminal output and is often wrong, so a view should say what was seen rather than "Done". With `since` the age stays current. `glyph` draws the glyph alone, named by the wording. |
| `AgentPicker` | `agents` (the panes `host.agents.list()` resolves), `onSelect(choice)`, `launchAgents?: string[]`, `worktreeId?`, `trigger?`, `open?`, `defaultOpen?`, `onOpenChange?`, `"aria-label"?`, `searchPlaceholder?`, `emptyMessage?`, `side?`, `align?` | A popover with the host's Send to agent list: a search over title, agent and worktree, the panes grouped under their worktree when they span several, each with its agent and its last observed state ("Last seen waiting"). A pane that cannot take a draft (`canDraft: false`) is listed disabled with its reason. `worktreeId`'s group comes first and its agent is preselected. `launchAgents` adds "New Claude" rows after the panes, kept whatever the search. The choice is `{ kind: "agent", terminalId, agentId, worktreeId }` or `{ kind: "launch", agentId, worktreeId }`; what happens next is your worker's (`host.sendToAgent(text, { terminalId })`, say). Each row is named with its worktree and, when there is one, its last observed state. Up and Down move, Enter picks (never mid-IME composition), Escape closes. The default trigger is a "Choose agent…" button; a `trigger` you pass shows while the kit loads. |
| `SendToAgentButton` | `text`, `title?`, `worktreeId?`, `terminalId?`, `channel?` (`"sendToAgent"`), `send?(request)`, `onResult?(outcome)`, `onError?(error)`, `children?` ("Send to agent…"), `variant?`, `size?`, `iconOnly?`, `disabled?`, `disabledReason?`, `className?`; `id`, `aria-*` and `data-*` | The **Send to agent…** control. `host.sendToAgent` is your worker's alone, so the button invokes your worker's `channel` with `{ text, title?, worktreeId?, terminalId? }` — the handler in [Views → Sending work to an agent](./views.md#sending-work-to-an-agent-from-a-view) — or calls your own `send`. Without `onResult`, the three refusals only your plugin hears about (`project-unavailable`, `prompt-open`, `busy`) are shown as a toast; the user already saw the rest at their agent. Without `onError`, a failed call is a toast too. Text the host would refuse (blank once control characters are stripped, or over 32,768 characters) leaves it unavailable with the reason spoken, and a `title` over 120 characters is dropped. Nothing is reported once the button has unmounted. |
| `ContextDragSource` | `text`, `title?`, `sourceLabel?`, `children?`, `label?` ("Drag to an agent"), `disabled?`, `onDragStart?`, `className?`; `id` and `data-*` | Makes `children` draggable onto an agent's terminal or input bar, carrying the `daintree-context` payload and the text as `text/plain` for a drop anywhere else. Without children it draws a small grip chip. The payload is checked as the drop checks it, so text that would be refused (blank, too long) starts no drag rather than failing at the drop. A kit drag (`SortableList`, `Kanban`, `useDraggable`) never starts from inside it, so put it inside a kit card — a chip, a grip — rather than around one, and the card carries both. A drag has no keyboard route: pair it with a `SendToAgentButton`. |
| `TerminalSnapshot` | `text` (ANSI colours and all), `title?`, `agentId?`, `state?`, `since?`, `rows?` (12, at most 200), `scale?: "xs" \| "sm"`, `onClick?`, `selected?`, `"aria-label"?`, `className?` | A still preview of a terminal's last `rows` lines in the terminal theme's colours and face (`sm` is the terminal's own 12 px, `xs` 10 px), under a row with the agent's mark, the title and the observed state. SGR colours (the 16 theme colours, 256 and true colour), bold, dim, italic, underline and reverse are drawn, read as one stream so a colour set above the kept lines still applies; cursor moves, titles, device-control strings and other escapes are dropped, and a carriage return keeps the last redraw of its line. It takes no input; `onClick` makes the whole snapshot a button, e.g. to focus that terminal through an action. `selected` marks the current one of a set with the host's neutral current-thumbnail ring (the help panel's figure rail) and `aria-current`. Where the text comes from is yours: no host API reads a terminal for a plugin. |
| `ShortcutHint` | `actionId?`, `shortcut?`, `label?`, `variant?: "card" \| "inline"`, `className?` | A label and its keys, drawn as Daintree's shortcut hint card (`card`) or as the row alone (`inline`). With `actionId` it shows the action's title and the user's current binding, and nothing while the action has none. |
| `KeyHints` | `hints: { label, keys?, shortcut?, actionId? }[]`, `variant?: "inline" \| "footer"`, `"aria-label"?`, `className?` | A row of key hints as Daintree's palette footers draw them: compact key caps, then the label. Each hint takes literal `keys` (`["↑↓"]`), a `shortcut` combo, or an `actionId`'s binding (dropped while unbound). The first never hides; the rest drop from the end as the row narrows. `footer` adds the footer band and its top edge. |

### Overlays

| Export | Props | Notes |
| --- | --- | --- |
| `Dialog` | `open`, `onClose`, `title`, `icon?`, `description?`, `children?`, `size?: "sm" \| "md" \| "lg"`, `primaryAction?`, `secondaryAction?`, `hint?`, `footer?`, `dismissible?` (true), `layer?: "default" \| "nested"`, `"data-testid"?` | A modal with a title bar, scrolling body and footer. Actions are `{ label, onClick, disabled?, disabledReason?, loading?, intent?: "default" \| "destructive", icon? }`; a disabled action stays focusable and announced unavailable, and a disabled primary's `disabledReason` shows as the footer hint when the dialog has none. `footer` replaces the two actions with your own right-aligned kit `Button`s, the primary last and `contrast`. `dismissible={false}` blocks Escape, the backdrop and the close button. `icon` takes a name or your own element. |
| `ConfirmDialog` | `open`, `onClose`, `onConfirm: () => void \| Promise<void>`, `title`, `description?`, `children?`, `confirmLabel`, `cancelLabel?`, `variant?: "default" \| "destructive" \| "info"`, `icon?`, `loading?`, `confirmDisabled?`, `typedNameTarget?`, `hint?`, `layer?` | The one confirm-or-cancel shape. `confirmLabel` is a verb-noun ("Delete branch"), never "OK". `loading` puts a spinner on the confirm and locks the dialog. On a `destructive` dialog, `typedNameTarget` makes the user type that exact text to enable the confirm. |
| `Popover` | `trigger: ReactElement`, `children?`, `side?`, `align?`, `open?`, `defaultOpen?`, `onOpenChange?`, `width?: "sm" \| "md" \| "lg" \| "trigger" \| "auto"`, `padding?: "default" \| "none"`, `"aria-label"?`, `onCloseAutoFocus?` | A floating panel for a filter, picker or detail card. Focus moves in on open and back to the trigger on close; Escape and an outside click close it. Widths are 14, 18 (default) and 24 rem, the trigger's width, or the content's. The trigger shows while the kit loads. |
| `ConfirmPopover` | `trigger: ReactElement`, `message`, `onConfirm`, `description?`, `onCancel?`, `confirmLabel?` ("Confirm"), `cancelLabel?` ("Cancel"), `tone?: "default" \| "danger"`, `open?`, `defaultOpen?`, `onOpenChange?`, `side?`, `align?` | A small confirm anchored to its trigger, for an action that is cheap to undo or redo ("Clear all", "Reset filters"); for one that cannot be taken back, use `ConfirmDialog`. `message` is the question naming what it acts on, `description` the consequence. Focus moves to the confirm on open, or to Cancel when `tone="danger"`, which also draws the confirm destructive. Closing from the keyboard or with either button puts focus back on the trigger; a click elsewhere leaves it where you clicked, as with every popover. Escape and a click away count as Cancel. The trigger shows while the kit loads. |
| `PopoverSearchField` | `value`, `onValueChange?`, `onClear?`, `placeholder?`, `"aria-label"?`, `clearLabel?`, `autoFocus?`, `disabled?`; DOM props | The full-width search strip at the top of a filtering `Popover` with `padding="none"`. Controlled only. Anywhere else, use `SearchField`. |
| `Sheet` | `open`, `onOpenChange`, `title`, `icon?`, `description?`, `children?`, `side?: "right" \| "left"`, `size?: "sm" \| "md" \| "lg" \| "xl"`, `primaryAction?`, `secondaryAction?`, `hint?`, `footer?`, `dismissible?` (true), `layer?`, `"data-testid"?` | A full-height panel that slides in from the window's edge (`right` by default) over a scrim, for a record's detail or edit form beside the list it came from. It has `Dialog`'s parts and actions and behaves as one: focus moves in and is trapped, and returns to where it was on close. Escape, the scrim and the close button call `onOpenChange(false)`. Widths are 28, 36 (default), 42 and 56 rem, never wider than the window. |
| `CommandPalette` | `open`, `onOpenChange`, `items: { id, label, description?, icon?, keywords?, shortcut?, group?, disabled? }[]`, `onSelect(item)`, `title`, `placeholder?`, `shortcut?`, `onQueryChange?(query)`, `filter?` (true), `loading?`, `emptyText?`, `actionLabel?` | Daintree's search palette, for a quick switcher or "jump to…": a search field over a virtualised list. It fuzzy-matches `label`, `description` and `keywords` and marks the match; items sharing a `group` sit under its heading, groups in the order they first appear. A disabled item that matches the search ranks after the enabled matches in its group. Up/Down move (skipping disabled items), Enter selects, Escape clears the search and then closes. Selecting an item calls `onSelect` with your own object and closes the palette. For a search you run yourself, pass `filter={false}` and set `items` from `onQueryChange`, which hears `""` whenever the palette closes, however it was closed; `loading` shows the header's loading bar and holds back the empty state. `title` is the small heading over the field and the palette's name; `actionLabel` ("Open issue") names what Enter does in the footer. Opened inside a `layer="nested"` dialog or sheet, it stacks above it. |
| `EmojiPicker` | `trigger: ReactElement`, `onSelect(emoji)`, `value?`, `open?`, `defaultOpen?`, `onOpenChange?`, `side?`, `align?`, `"aria-label"?` ("Choose emoji") | Daintree's emoji picker (search, categories and the keyboard grid) in a popover from `trigger`; `value` is marked in the grid. Picking closes it and returns focus to the trigger. The trigger shows while the kit loads. |

### Lists and tables

| Export | Props | Notes |
| --- | --- | --- |
| `VirtualList<T>` | `items?` or `count?`, `renderItem(index, item)`, `itemKey?(index, item)`, `estimatedItemSize?` (28), `overscan?` (8), `onEndReached?(lastIndex)`, `activeIndex?`, `shadows?`, `"aria-label"`, `className?`; DOM props | Mounts only the rows in view, so ten thousand items cost what forty do. It fills its container's height, so give the container one. With `items`, `renderItem` and `itemKey` are handed each row's item typed `T` (`VirtualListItemsProps<T>`); with `count` alone they are handed `undefined` and read rows by index (`VirtualListCountProps`). `VirtualListProps<T>` is the general form, for a wrapper that forwards either. Without `itemKey` rows key by index and remount when the list reorders. DOM props land on the element that holds the rows, except `style` and `ref`, which the virtualiser owns there; spread `useListNavigation().containerProps` for a keyboard listbox, and the DOM props then land on its scroller (the size of the viewport), which takes focus, rather than the row element. Either way your `id` and `data-*` (`data-testid` included) are on the element with the role and name, never overwritten by the virtualiser's own. Without a `role` it is a plain list. `shadows` adds `ScrollShadow`'s edge fades. |
| `DataTable<T>` | `columns`, `rows`, `rowKey: ((row, index) => string \| number) \| string`, `sort?: { columnId, direction: "asc" \| "desc" } \| null`, `onSortChange?`, `onRowClick?(row, index)`, `rowMenu?(row, index)`, `selectedRowKey?`, `empty?`, `estimatedRowSize?` (28), `onEndReached?`, `"aria-label"`, `className?` | A sticky header over an always-virtualised body that fills its container. Columns are `{ id, header, width?, align?, sortable?, grow?, render?(row, index) }`; without `render` a cell shows `row[id]` when that is a string or number. Columns without a `width` share what the sized ones leave, up to 480 px each; the space beyond that stays at the trailing edge rather than stretching one column across the pane, and a table of sized columns keeps exactly the widths it asked for. `grow` gives one column everything left, for a message or a path that should run to the edge. Sorting is controlled: the table reports `onSortChange` (ascending first, then flipping) and you sort `rows`. With `onRowClick` or `rowMenu` it is a keyboard grid: one tab stop, Up/Down/Home/End, Enter. `rowMenu` returns a row's context menu in `DropdownMenu` entries (`null` or `[]` for none); a right-click on the row or Shift+F10 / the Menu key on the cursor row opens it, the row is outlined while it is open, and focus returns to the table on close. A right-click on the header or below the last row is left to an enclosing `ContextMenu`. Selection, groups, sub-rows, column sizing and editing are all opt-in props, below under [Richer tables](#richer-tables). |
| `FileTree` | `entries?: { path, type: "file" \| "dir" \| "directory" }[]` or `nodes?: { name, type?, children? }[]`, `"aria-label"`, `selectedPath?`, `defaultSelectedPath?`, `onSelect?(path, item)`, `expandedPaths?`, `defaultExpandedPaths?`, `onExpandedPathsChange?(paths)`, `onActivate?(path, item)`, `sort?: "natural" \| "none"`, `empty?`, `className?` | Daintree's file tree: the host browser's rows, chevron gutter (files keep it, so their icons line up under their folder's), file-type icons and keyboard model, virtualised so a ten-thousand-file walk mounts one screen of rows. It fills its container's height. `entries` takes what `host.fs.walk` returns and fills in any folder it only implies. `natural` (the default) sorts each folder folders first, then by name, numeric-aware and case-insensitive, so `churn-2` comes before `churn-10` whatever order `walk` returned. One tab stop: Up/Down/Home/End select, Right opens a folder or steps into it, Left closes it or steps out, Enter and double-click call `onActivate`, and typing jumps to a matching name. A row click selects and toggles a folder; the chevron toggles without selecting. Selection and expansion are each controlled when you pass `selectedPath` / `expandedPaths`, uncontrolled otherwise. `item` is `{ path, name, type: "file" \| "directory", depth }`. |
| `TreeView<T>` | `nodes`, `"aria-label"`, `getId?(node)` (`node.id`), `getLabel?(node)` (`label`, `name` or `title`), `getChildren?(node)` (`node.children`; an array or a promise), `hasChildren?(node)`, `renderNode?(node, state)`, `getIcon?(node, state)`, `selectionMode?: "single" \| "multiple"`, `selected?`, `defaultSelected?`, `onSelectedChange?(ids)`, `expanded?`, `defaultExpanded?`, `onExpandedChange?(ids)`, `checkable?`, `checked?`, `defaultChecked?`, `onCheckedChange?(ids)`, `onActivate?(node)`, `onMove?(move)`, `canDrop?(move)`, `canDrag?(node)`, `empty?`, `className?` | A tree of any nodes, drawn with `FileTree`'s rows, chevrons and indentation and virtualised the same way; it fills its container's height. Ids are unique across the whole tree. A promise from `getChildren` makes a lazy node: it loads once, when first expanded, with a loading row under it (shown past 200 ms) and Retry if it fails; give `hasChildren` with lazy nodes, or each one is loaded as it is drawn to learn whether it has any. The keyboard is `FileTree`'s, plus Space: it toggles the cursor row's checkbox with `checkable`, or its selection with `multiple`. Tabbing in puts the cursor on the first node without selecting it. In `single` mode (the default) moving the cursor moves the selection; in `multiple`, Cmd-click (Ctrl-click) toggles, Shift-click and Shift+arrows extend, Cmd+A selects all. `checkable` draws the host checkbox on every row and reports `aria-checked`: a parent is on when all its loaded children are, mixed when some are, and checking it checks them all, including children that load later. `onMove` lets nodes be dragged: onto a row's upper or lower quarter puts it before or after, onto its middle puts it inside, with the host's drop line and frame; Alt+Up/Down move the cursor node among its siblings, Alt+Left out a level, Alt+Right into the sibling above. The move is `{ id, parentId, index, fromParentId, fromIndex }` (`parentId: null` is the top level, `index` counted with the node removed); the tree announces it and does not apply it, so update `nodes`. A node is never dropped into itself or its own subtree, and `canDrop` refuses others. `state` is `{ depth, expanded, expandable, selected, checked, loading }`. |
| `ObjectInspector` | `value`, `"aria-label"`, `name?`, `expandDepth?` (1; `Infinity` opens all), `toolbar?` (true), `filter?`, `defaultFilter?`, `onFilterChange?(filter)`, `maxStringLength?` (200), `arrayChunkSize?` (100), `sortKeys?`, `className?` | A read-only, collapsible view of a JSON-like value (an API response, a tool result), in the host console's value colours: strings and numbers in the syntax colours `CodeBlock` uses, booleans in purple, `null` quiet, and each closed container summarised (`{3 keys}`, `Array(12)`). The toolbar holds a filter (rows whose key or value contains the text, with the way down to them opened) and Expand all / Collapse all. Each row's context menu (right-click, Shift+F10) copies its value or its path (`deployment.items[0].id`, starting at `name`); the button on hover and Cmd+C (Ctrl+C) copy the cursor row's value. A string copies as its text, anything else as JSON. Strings over `maxStringLength` are cut with a "more" button that shows the rest; Enter on any string row shows it whole, wrapped, and Enter again puts it back on one line, arrays longer than `arrayChunkSize` open into ranges (`[0 … 99]`, opened by Expand all), and a value inside itself shows as `[Circular]`. `Date`, `Map` and `Set` are shown as what they hold. Its rows are one tab stop with `FileTree`'s keyboard (the toolbar adds its own), virtualised, and it fills its container's height. While a filter is set, the way down to every match is open. |
| `LogView` | `lines: (string \| { text, severity? })[]`, `maxLines?` (5000), `follow?` (true), `monospace?` (true), `wrap?` (true), `"aria-label"`, `className?` | A bounded, virtualised log that stays pinned to the newest line while the reader is at the bottom. It bounds the DOM, not your array: append in batches (`useStreamBuffer`) and drop old lines yourself if you keep them in state. |
| `Timeline<T>` | `items: { id, title, icon?, description?, timestamp?, actor?, tone? }[]`, `"aria-label"`, `renderContent?(item, index)`, `groupByDay?`, `timeFormat?: "compact" \| "verbose"`, `now?`, `estimatedItemSize?` (44), `onEndReached?(lastIndex)`, `className?` | An activity feed or audit log: one entry per row on a connecting rail, the actor (a name, or `{ name, src }` with an avatar) before the title, and a relative time on the right with the exact time on hover. The marker is `icon`, else a `tone`'s severity glyph, else a dot; `tone` also tints an icon (`success` leaves it neutral) and is spoken before the title. `renderContent` adds anything under an entry, such as a comment body in `Markdown`; extend the item type with your own fields and read them there. `groupByDay` puts a Today, Yesterday or date header before each day, breaking the rail there; it does not sort, so give `items` in date order, newest first as a feed reads: a header starts wherever the day changes, and out-of-order items repeat a day's header. Virtualised with measured rows, so entries of any height mount one screen at a time. It is as tall as its entries up to its container's height, then scrolls, so a long feed needs a sized container; unsized, it grows to fit every entry. Times refresh on a shared minute tick; `now` fixes the clock. |
| `ListRow` | `title`, `subtitle?`, `icon?`, `meta?`, `selected?`, `active?`, `checked?`, `selecting?`, `onToggle?`, `onSelect?`, `disabled?`, `className?`; DOM props except `title` | A row with Daintree's highlight. Spread `getRowProps(index)` into it for a keyboard listbox; otherwise, with `onSelect`, it is a button, and without, a plain row. In a listbox, report disabled rows through `useListNavigation`'s `isDisabled` too. In a multi-select listbox (see [`useSelection`](#hooks)) the highlight follows `aria-selected`, so set that from the selection and `active={index === activeIndex}` for the cursor's focus outline. `checked` draws the app's membership mark, the host checkbox in the icon's slot, as the app's own multi-select lists do: on checked rows, on the row under the pointer or the cursor, and on every row while `selecting` (pass `selection.count > 0`); `onToggle` makes a click on the checkbox toggle just that row. A row whose context menu is open keeps a neutral ring while the menu is up. |
| `ScrollShadow` | `children`, `className?` (the frame; size it here), `scrollClassName?` (the scroller; pad it here), `compact?`, `ref?` (the scroller); DOM props | A vertical scroller with fades that show there is more. DOM props land on the scrolling element, so it can be a listbox. For a windowed list use `VirtualList` with `shadows`. |

`useListNavigation(options)` is the keyboard model of a list: one tab stop, Up/Down/Home/End move the cursor, Enter or Space selects, typing jumps when `getLabel` is given. Options are `count`, `onSelect?(index, event)` (the key or click that selected, so a multi-select list can read its modifiers), `onActiveIndexChange?(index, event)` (the cursor moved by keyboard; see [`useSelection`](#hooks)), `hasRowMenus?` (rows carry a kit `ContextMenu`: Shift+F10 and the Menu key open the cursor row's menu, since focus stays on the list), `loop?` (false), `initialIndex?` (0), `getLabel?(index)` and `isDisabled?(index)` (rows the cursor, typeahead, Enter, Space and clicks all skip). It returns `{ activeIndex, setActiveIndex, containerProps, getRowProps }`: `containerProps` is `{ role: "listbox", tabIndex: 0, "aria-activedescendant", onKeyDown }`, and `getRowProps(index)` is `{ id, role: "option", "aria-selected", "aria-disabled"?, onClick, onPointerMove }`. `activeIndex` is `-1` for an empty list.

#### Richer tables

Every prop below is optional, and a `DataTable` given none of them is the table above. All of them work together.

- **Selection.** `selectable` (or a function choosing rows) draws a checkbox column and makes the table multi-select: a box toggles its row, Shift-click selects a range, and the header box selects every selectable row shown, or clears them (it is mixed when some are). Shift- or Cmd-click (Ctrl-click) on a row works too; a plain click still calls `onRowClick`. From the keyboard Space toggles the cursor row, Shift+Up/Down extend, Cmd+A (Ctrl+A) selects all and Escape clears. `selectedRowKeys` with `onSelectedRowKeysChange(keys)` controls it (`defaultSelectedRowKeys` otherwise); keys come back in the order rows are drawn. Pair it with `BulkActionBar`: `count={keys.length}` and `onClear={() => setKeys([])}`.
- **Groups.** `groupBy` is a column id or field name, or `(row) => key`. Each group gets a header row with a disclosure, its label (`groupLabel?(key, rows)`, else the key, "None" for an empty one) and a count; with `selectable` the header's box (or Space on the header) selects the group's rows, folded or not, and a folded group's rows stay in "select all". Enter folds a header. Groups keep the order their first row has in `rows`. Folding is `collapsedGroups` / `defaultCollapsedGroups` / `onCollapsedGroupsChange(keys)`.
- **Expandable rows.** `getSubRows(row)` returns a row's children, drawn indented under it in the first column. For children you fetch, return nothing there and give `hasSubRows(row)` and `loadSubRows(row)` (a promise): expanding loads them once, with a loading row meanwhile (shown past 200 ms) and Retry if it fails; they are kept while the row is the same object. Row keys must be unique across every level. Expansion is `expandedRowKeys` / `defaultExpandedRowKeys` / `onExpandedRowKeysChange(keys)`. With groups or sub-rows the table is a `treegrid`: Right opens a row or group and steps in, Left closes it or steps out.
- **Column widths.** A column with `resizable` gets a drag edge on its header, which is also a keyboard separator: Left/Right step 8 px (Shift 32), Home/End go to its `minWidth` (48) and `maxWidth` (1200), and Enter, Space or a double-click go back to its `width`. Widths are `columnWidths` / `defaultColumnWidths` / `onColumnWidthsChange(widths)`, px by column id. Once the columns are wider than the pane, the table scrolls sideways, and `stickyFirstColumn` keeps the first column (after the checkboxes) in place.
- **Hidden columns.** `columnsMenu` draws a Columns button at the header's end: a menu of every column with a check to show or hide it. `hideable: false` keeps a column always shown (its menu row stays checked and disabled), `menuLabel` names a column whose `header` is not plain text, and the last shown column cannot be hidden; a default or restored layout that hides them all still shows the first. Hidden columns are `hiddenColumns` / `defaultHiddenColumns` / `onHiddenColumnsChange(ids)`.
- **Remembering the layout.** `viewStateKey` keeps widths, hidden columns, folded groups and expanded rows with [`usePersistentViewState`](#hooks) under that key, so they survive the view unmounting, a reload and a restart. Props you control yourself still win.
- **Editing.** A column with `editable` (`true`, or a function of the row) edits in place: double-click the cell, or Enter or F2 on its row for the row's first editable cell. With editable columns, Cmd+Enter (Ctrl+Enter) runs `onRowClick` from the keyboard. The editor is the kit `Input` (`editor: "text"`, the default, or `"number"`) or a `Select` over `editOptions` (`"select"`), starting from `editValue?(row)` or `row[id]`. Enter or leaving the cell commits, Escape cancels, Tab and Shift+Tab commit and move to the next or previous editable cell. `validate?(value, row)` returning a message (or throwing) refuses the draft and keeps the editor open with the message in a tooltip beside it. A commit calls `onCellEdit(row, columnId, value)`; return a promise and the cell shows the new value with a spinner until it settles, or reopens with the draft and the error's message if it rejects or throws (while another cell is being edited, the failure is announced instead, so that edit keeps its draft). A select editor commits as soon as a choice is made. Update `rows` yourself.

```tsx
const [selected, setSelected] = useState<string[]>([]);

<DataTable
  aria-label="Deployments"
  rows={deployments}
  rowKey="id"
  columns={[
    { id: "name", header: "Deployment", width: 200, resizable: true },
    { id: "status", header: "Status", width: 110, render: (d) => <Badge>{d.status}</Badge> },
    { id: "branch", header: "Branch", width: 160, resizable: true, editable: true },
    { id: "region", header: "Region", width: 100, hideable: true },
  ]}
  selectable
  selectedRowKeys={selected}
  onSelectedRowKeysChange={(keys) => setSelected(keys as string[])}
  groupBy="environment"
  getSubRows={(d) => d.instances}
  columnsMenu
  stickyFirstColumn
  viewStateKey="deployments"
  onCellEdit={(d, column, value) => api.update(d.id, { [column]: value })}
/>
<BulkActionBar count={selected.length} onClear={() => setSelected([])} noun="deployment" actions={actions} />
```

### Pane chrome

| Export | Props | Notes |
| --- | --- | --- |
| `PaneHeader` | `title`, `icon?`, `subtitle?`, `actions?`, `className?` | A pane's compact title bar. `subtitle` is one quiet line (a count, a path, a filter in effect); `actions` is usually a `Toolbar`. The host's panel chrome already shows your panel's title and icon, so don't repeat them here: `title` is the view's own context (the branch, the selection, "4,096 of 5,000"). With nothing of that kind to say, leave `PaneHeader` out and use a `Toolbar variant="bar"` for the actions. |
| `Toolbar` | `children?`, `"aria-label"`, `variant?: "inline" \| "bar"`, `className?` | A row of controls that is one tab stop, Left/Right between them. `bar` draws a pane's toolbar strip; `inline` (the default) is the bare group for inside a `PaneHeader`. |
| `ToolbarButton` | `icon?`, `label?`, `"aria-label"?`, `onClick?`, `pressed?`, `expanded?`, `disabled?`, `tooltip?: ReactNode \| false`, `tooltipSide?: "top" \| "bottom"`; DOM props | Icon-only (its `aria-label` doubles as the tooltip) or, with `label`, an icon and a word. `pressed` is a toggle, `expanded` a disclosure; never both. Disabled buttons stay in the arrow-key order and ignore clicks. |
| `Tabs` | `items: { value, label, icon?, badge? }[]`, `value`, `onValueChange`, `"aria-label"`, `children?: ReactNode \| ((value) => ReactNode)`, `content?: Record<string, ReactNode>`, `density?: "page" \| "strip"`, `className?`, `panelClassName?` | Switches between panes of content; for a value picker use `SegmentedControl`. Drawn as the app's document-tab cells: each tab a cell divided by a hairline, the selected one filled and underlined in the accent, as native tab groups are, with an optional icon; `density: "strip"` makes the cells shorter for a fixed chrome strip. A strip wider than its pane scrolls sideways and keeps the selected tab in view. Arrow keys and Home/End move and select. A number `badge` draws a count pill. |

### Layout

| Export | Props | Notes |
| --- | --- | --- |
| `Card` | `title?`, `description?`, `children?`, `footer?`, `variant?: "default" \| "inset"`, `padding?: "none" \| "sm" \| "md"`, `className?`; then either `actions?` (a static card) or `onClick`, `disabled?` (a clickable card); DOM props | The app's card surface: a hairline frame, a sentence-case title with a quiet description, trailing `actions` in the header row, the body, and a `footer` row set off by a hairline. Never accent. `inset` recedes, for a nested group or a read-only block inside another surface. `padding="none"` takes the body edge to edge, for a list or table. With `onClick` the whole card is one button, the host's choice card, outlined at rest and washed on hover: use it for a destination or a choice, and since controls cannot sit inside a button it takes no `actions`. The button is named by its `title` unless you pass your own `aria-label` or `aria-labelledby`, and an `aria-describedby` you pass is read after its `description`. |
| `Divider` | `orientation?: "horizontal" \| "vertical"`, `label?`, `className?` | A hairline between groups. A vertical one stretches to its flex row's height. `label` ("or", "Older") sits in the middle of a horizontal line and is read as text. |
| `SectionLabel` | `children?`, `variant?: "section" \| "list"`, `as?: "h2" \| "h3" \| "h4" \| "div"`, `className?` | The small quiet uppercase heading above a group: an `h3` by default. `list` is a step smaller, for a band of rows inside a list. Write the text in sentence case and let the style uppercase it; keep it to a word or two of your own vocabulary, never a branch, a path or anything the user typed. Not for settings views, which use `SettingsSection`. |
| `ResizableSplit` | `first`, `second`, `"aria-label"`, `orientation?: "horizontal" \| "vertical"`, `sizedPane?: "first" \| "second"`, `size?`, `defaultSize?` (280), `onSizeChange?(size)`, `minSize?` (160), `maxSize?` (640), `collapsible?`, `collapsed?`, `defaultCollapsed?`, `onCollapsedChange?(collapsed)`, `className?` | Two panes and the host's draggable divider. `horizontal` puts them side by side. The `sizedPane` holds a size in px and the other takes the rest; the sized pane never takes more than its container. The divider takes arrows (10 px), Shift+arrows (50 px), Home and End, and double-click resets it to `defaultSize`. A drag starts from the pane's drawn size, which a narrow container can hold below `size`, redraws at most once a frame, and `onSizeChange` runs once when it ends, so persist the size there. `collapsible` lets a drag below half of `minSize` collapse the pane, and Enter or Space toggles it; the divider stays at the edge to bring it back, and the pane stays mounted. It fills its container, so give that a height. |
| `Accordion` | `items: { value, title, content, trailing?, disabled? }[]`, `type?: "single" \| "multiple"`, `value?: string[]`, `defaultValue?`, `onValueChange?(value)`, `headingLevel?: 2..6`, `className?` | Stacked sections split by hairlines, each a heading button with a chevron. `single` (the default) keeps at most one open, and clicking the open one closes it; handed several values, it opens only the first that names a section. `value` is the open sections in both modes. Up, Down, Home and End move between headers. A closed section's content is not mounted. `trailing` is a count or a `Badge`, never a control. |
| `Disclosure` | `title`, `children?`, `open?`, `defaultOpen?`, `onOpenChange?(open)`, `trailing?`, `disabled?`, `headingLevel?`, `className?` | One heading button that shows or hides what is under it, such as an "Advanced" group. Content is mounted only while open. Its chevron sits on the content's edge and its content starts under the title, as an `Accordion`'s do, so the two line up when they stack in one column. |
| `DescriptionList` | `items?: { label, value?, hint?, copyText? }[]`, `children?`, `layout?: "inline" \| "stacked"`, `copyable?`, `className?` | The label and value rows of a record's detail page, as a `dl`. `inline` (the default) puts the labels in a column beside the values; `stacked` puts each label over its value, for a narrow pane. An empty value draws a quiet dash, read as "None". `copyable` adds a copy button after every text or number value; an item's `copyText` adds one that copies that text. Inline, the value column is as wide as the longest value (up to the room there is) and the copy buttons sit in one column straight after it, so they stay beside short values and line up with each other. Build the rows as `DescriptionListItem` children (the same fields as an item) when they need their own `data-*`. |

### Page structure

The layout a panel is built from, on the spacing scale Daintree's own panes use: `gap` and `padding` take `none`, `xs` (4 px), `sm` (8), `md` (12, a pane's inset), `lg` (16) and `xl` (24). Build a panel from these rather than from `div`s with hand-picked gaps, and its spacing and chrome heights match the rest of the app.

| Export | Props | Notes |
| --- | --- | --- |
| `Stack` | `children?`, `gap?` (`md`), `align?: "start" \| "center" \| "end" \| "stretch" \| "baseline"` (`stretch`), `justify?: "start" \| "center" \| "end" \| "between" \| "around" \| "evenly"`, `as?`, `className?`; DOM props | Children in a column. `as` is one of `div` (the default), `section`, `article`, `aside`, `header`, `footer`, `nav`, `main`, `form`, `fieldset`, `ul`, `ol`, `li`, `span`; a `ul` or `ol` drops its markers. |
| `Inline` | as `Stack`, plus `wrap?`; `gap?` (`sm`), `align?` (`center`) | Children in a row, vertically centred. It does not wrap unless `wrap` is set. |
| `Cluster` | as `Stack`; `gap?` (`sm`), `align?` (`center`) | A row that wraps, the same gap between rows as between items: chips, tags, badges. |
| `Grid` | `columns?: number \| string`, `gap?` (`md`), `align?`, `as?`, `className?`; DOM props | Explicit columns: a count (1 to 12, equal widths) or a `grid-template-columns` value (`"200px 1fr"`). |
| `AutoGrid` | `minColumnWidth?` (180), `maxColumns?`, `stretch?`, `gap?` (`md`), `align?`, `as?`, `className?`; DOM props | As many equal columns as fit, none narrower than `minColumnWidth` (up to 4096; anything else falls back to 180) unless the grid itself is narrower, when its one column takes the whole width, reflowing with the grid's own width, never the window's, so a `StatCard` row goes from four across to one as the pane narrows. `maxColumns` caps the count on a wide pane. A short row keeps full-row column widths; `stretch` spreads it across instead. |
| `PaneLayout` | `header?`, `toolbar?`, `children?`, `footer?`, `statusBar?`, `scroll?: "shadow" \| "plain" \| "none"`, `padding?`, `bodyClassName?`, `bodyRef?`, `bodyLabel?`, `className?` | A panel's shell. It fills the view's root; the header (a `PaneHeader`), toolbar (a `Toolbar` or `OverflowToolbar` with `variant="bar"`), footer and status bar keep their own heights, and the body between them is the only thing that scrolls. `shadow` (the default) fades the edge with more; `none` does not scroll, for a body holding its own scroller (a `VirtualList`, a `ResizableSplit`). `padding` insets the body's content; `bodyRef` is its scroller; `bodyLabel` names it as a region. |
| `StatusBar` | `left?`, `center?`, `right?`, `density?: "compact" \| "comfortable"`, `placement?: "bottom" \| "top"`, `className?` | The thin strip along a pane's edge: what the view shows on the left, a control or two on the right. A slot takes a node or an array of facts, drawn with a quiet dot between them. Text on the left truncates first when the strip runs short; the right never does. `compact` (the default) is the host's 24 px bottom status strip in 11 px text; `comfortable` is the 28 px metadata strip a file pane shows over its content, which fits an `xs` `Button`. `placement="top"` puts the hairline under it. It is not a live region: announce a result yourself. |
| `ScrollArea` | `children?`, `orientation?: "vertical" \| "horizontal" \| "both"`, `className?` (the frame), `scrollClassName?` (the scroller), `compact?`, `ref?` (the scroller); DOM props | A scroller on either axis or both, fading each edge that has more. Content along a scrolling axis keeps its own size, so a row of cards overflows sideways instead of squeezing. DOM props land on the scroller. With an `aria-label` or `aria-labelledby` and no `role` of your own it is a named `region`; Chromium already puts a scroller with nothing focusable inside it in the Tab order, and `tabIndex={0}` makes that explicit. For a vertical list, `ScrollShadow` is the same thing. |
| `OverflowToolbar` | `items: ({ id, label, icon?, onSelect?, showLabel?, pressed?, disabled?, tooltip?, shortcut?, destructive?, priority? } \| { type: "separator" })[]`, `"aria-label"`, `variant?: "inline" \| "bar"`, `leading?`, `trailing?`, `overflowLabel?` ("More actions"), `className?` | A `Toolbar` whose controls fold into a "More actions" menu when the strip is too narrow for them, measured as it resizes. Each control is a `ToolbarButton` in the strip (icon-only unless `showLabel`; `label` names it) and a menu row once folded: `pressed` makes it a toggle and a check row, `shortcut` fills the menu's key column. The last controls fold first; a higher `priority` stays longer. `leading` and `trailing` never fold. Still one tab stop, Left and Right reaching the menu button, and a focused control that folds hands focus to it. |

`useContainerSize(target)` and `useBreakpoint(target, breakpoints?)` make layout answer to the panel's width, never the window's. `target` is a ref or the element itself. A ref is re-read each time the calling component renders, so an element it mounts later is picked up; for an element a child mounts on its own schedule, keep the element in state from a callback ref (`ref={setElement}`) and pass that. `useContainerSize` returns `{ width, height }` in CSS px, re-read at most once a frame while it changes and `0` until measured. `useBreakpoint` returns the widest named step the width reaches — `{ sm: 360, md: 640, lg: 960 }` by default, or your own record — and `null` while the element is narrower than every step, not yet measured, or hidden (a zero width counts as unmeasured). Both stop observing on unmount.

```tsx
import { useRef } from "react";
import {
  AutoGrid,
  PaneHeader,
  PaneLayout,
  StatCard,
  StatusBar,
  useBreakpoint,
} from "@daintreehq/plugin-ui";

export default function Dashboard() {
  const root = useRef<HTMLDivElement>(null);
  const wide = useBreakpoint(root, { wide: 640 }) === "wide";
  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      <PaneLayout
        header={<PaneHeader title="main · 3 open PRs" />}
        padding="md"
        statusBar={<StatusBar left={["12 checks", "2 failing"]} right="Updated 1m ago" />}
      >
        <AutoGrid minColumnWidth={wide ? 180 : 140}>
          <StatCard label="Open PRs" value={3} />
          <StatCard label="Failing checks" value={2} />
        </AutoGrid>
      </PaneLayout>
    </div>
  );
}
```

### Panes

What a panel needs once it is more than one pane: a list beside its record, splits of three or more, an inspector, a drawer inside the pane, a long grouped list, a selection bar, the end of a paged list, a queue of jobs and the marks of data that is refreshing or old. All of it answers to the pane's own width, never the window's.

| Export | Props | Notes |
| --- | --- | --- |
| `MasterDetail` | `list`, `detail`, `selectedId?: string \| number \| null`, `onBack?()`, `listLabel?` ("List"), `detailLabel?` ("Details"), `backLabel?` ("Back"), `detailTitle?`, `collapseBelow?` (560), `defaultListSize?` (320), `minListSize?` (220), `maxListSize?` (560), `persistKey?`, `className?` | A list pane beside a detail pane, split by the host's divider (a `ResizableSplit`). Below `collapseBelow` px of its own width it is one pane: the list while `selectedId` is `null` or `undefined`, the detail under a 32 px Back strip (with `detailTitle`) once it is not; clear `selectedId` in `onBack`. Focus follows the swap: to Back when a record opens, and back to the row that opened it. Both panes stay mounted across the breakpoint, so a scrolled list or a half-written comment survives it. `persistKey` remembers the list width (see `usePersistentViewState`). It fills its container. |
| `SplitGroup` | `panes: { id, content, defaultSize?, fill?, minSize?, maxSize?, collapsible?, defaultCollapsed?, handleLabel? }[]`, `orientation?: "horizontal" \| "vertical"`, `persistKey?`, `collapsed?: string[]`, `onCollapsedChange?(ids)`, `onLayoutChange?({ sizes, collapsed })`, `className?` | Two or more panes in a row or column. One pane fills (the one marked `fill`, else the first without a `defaultSize`, else the last); every other pane holds a size in px (240 by default, `minSize` 120) and owns the one handle on its side facing the filling pane, so each boundary has exactly one handle and a drag moves only that pane. Handles are the host's: arrows (10 px), Shift+arrows (50), Home, End, double-click to reset, and a pane never grows past the room the others leave. `collapsible` panes fold on a drag below half their `minSize` or on Enter or Space, and stay mounted; `collapsed` makes that controlled, for a toolbar toggle. Nest a `SplitGroup` in a pane for a grid of splits. `persistKey` remembers sizes and folded panes. |
| `Inspector` | `children?`, `"aria-label"?`, `labelWidth?` (88), `className?` | A property panel's frame, for a side pane or a `Drawer`. Its `PropertyRow`s put the label in a `labelWidth` column beside the value while the inspector is at least 240 px wide, and above it when narrower. Named, it is a region. |
| `InspectorSection` | `title`, `children?`, `collapsible?` (true), `open?`, `defaultOpen?` (true), `onOpenChange?(open)`, `actions?`, `className?` | A 28 px heading row (the small uppercase label) over a group of rows, split from the one above by a hairline. The heading folds the section; folded, its rows stay mounted and hidden, so a half-edited field keeps its value, and focus inside them moves to the heading. `actions` is a button or two at the row's end. |
| `PropertyRow` | `label`, `children?`, `htmlFor?`, `hint?`, `align?: "center" \| "start"`, `className?` | One property at a height the eye can count: a 12 px label and its value, 28 px tall. A kit control in `children` (an `Input`, `Select`, `Switch`, …) is labelled by the row, as in a `FormField`; `htmlFor` names a control the row cannot find. Text or a number is a read-only value, and nothing draws a quiet dash read as "None". `hint` sits after the label and is never part of its name. `align="start"` pins the label to the first line of a tall control. Give controls their compact size. |
| `Drawer` | `open`, `onOpenChange?(open)`, `children?` (the pane's content), `panel` (the drawer's body), `title?`, `"aria-label"?`, `actions?`, `footer?`, `side?: "left" \| "right" \| "top" \| "bottom"` (`right`), `mode?: "overlay" \| "push"` (`overlay`), `modal?`, `size?` (320), `panelId?`, `className?` | A panel that slides in from an edge of its own pane: wrap the pane's content in it. `overlay` floats on the app's elevated surface and shadow over the content and, `modal` by default, dims it, makes it inert and holds focus in the drawer until it closes; `push` sits beside the content and narrows it, and is never modal. Opening moves focus in (the body's first control when modal, else the drawer), without a focus ring when it was opened with the pointer; a drawer that mounts already open (restored with its view) leaves focus where it is. A modal drawer is a `dialog` whose scope is its own pane, so it does not claim `aria-modal` and the pane's toolbar stays live; Escape, the header's close button and a click on the scrim close it, and focus goes back to what opened it. With `title` it draws a 32 px header with `actions` and a close button; `footer` is a strip for Apply and Reset. It is never wider than 90 % of the pane. For a record against the window's edge use `Sheet`. |
| `DrawerToggle` | `open`, `onOpenChange(open)`, `label`, `controls?` (the `Drawer`'s `panelId`), `icon?`, `side?`, `showLabel?`, `badge?`, `disabled?`, `className?` | The pane-toolbar button for a `Drawer`: a panel glyph facing `side`, `aria-expanded` for the state and `aria-controls` for the drawer. The name is the drawer ("Filters"), never the next action. `badge` counts what the drawer has in effect, as a quiet number. |
| `GroupedVirtualList<T>` | `groups: { id, label, items, count? }[]`, `renderItem(item, index, group)`, `itemKey?(item, group)`, `"aria-label"`, `collapsible?`, `collapsedGroups?`, `defaultCollapsedGroups?`, `onCollapsedGroupsChange?(ids)`, `footer?`, `empty?`, `estimatedItemSize?` (28), `overscan?`, `onEndReached?(lastIndex)`, `activeIndex?`, `shadows?`, `className?`; DOM props except `style` and `ref` | A `VirtualList` in groups, each under a 28 px header (the list label, then the count) that sticks to the top while its rows scroll past. `count` overrides the number shown (a total larger than the page loaded) and `false` hides it. `collapsible` headers fold their group; they carry `aria-expanded` but no `aria-controls` (optional in the disclosure pattern), because a virtualised group's rows have no container of their own to point at. Rows are indexed across the list as drawn, headers not counted and folded groups left out, so `renderItem`'s `index`, `activeIndex` and `useListNavigation`'s `count` agree; spread `containerProps` for a keyboard listbox as on `VirtualList`. `footer` sits after the last row inside the scroller, usually a `LoadMoreFooter`. `empty` replaces the list when every group is empty. It fills its container's height. |
| `BulkActionBar` | `count?` or `selection?` (a `useSelection` result), `noun?: string \| { one, other }`, `hiddenCount?`, `actions?: { id, label, icon?, onSelect?, disabled?, destructive?, priority? }[]`, `onClear?`, `"aria-label"?`, `className?` | "3 issues selected", the actions that apply to them, and a clear button, in a 36 px band with a hairline on top: render it in place of the list's footer, not under it. It renders nothing while the count is 0. Actions are text buttons that fold into a "More actions" menu when the band is too narrow (the lowest `priority` first). `hiddenCount` adds "· 2 not shown" for selected rows a filter or an unloaded page hides. Escape inside the bar clears the selection. |
| `LoadMoreFooter` | `status: "idle" \| "loading" \| "error" \| "done"`, `onLoadMore?()`, `loadedCount?`, `totalCount?`, `noun?`, `error?`, `autoLoad?`, `label?` ("Load more"), `className?` | The end of a paged list. `idle` is a Load more button with "50 of 212" when both counts are known; `loading` keeps the button in place with its spinner (and focus); `done` says "All 212 issues loaded"; `error` shows the reason and Retry. Each change is announced. `autoLoad` loads the next page as the footer scrolls into view, and again while it stays in view after each page, but never retries an error. When the focused button goes away, focus stays in the footer. |
| `TaskList` | `tasks: { id, title, status: "pending" \| "running" \| "done" \| "failed" \| "cancelled", progress?, detail?, startedAt?, finishedAt?, retryable?, cancellable? }[]`, `"aria-label"`, `title?`, `summary?` (true), `actions?`, `onRetry?(task)`, `onCancel?(task)`, `empty?`, `className?` | A queue of jobs: sync runs, exports, deliveries. Each row has its state's glyph (spoken as a word), its title, a `detail` line, a spinner while it runs with a thin bar under it once `progress` (0 to 1) is known, and its duration (live while running, from `startedAt`; fixed once `finishedAt` is set). Only a failure is coloured: finished work is neutral. With `onRetry`, failed and cancelled jobs offer Retry; with `onCancel`, pending and running ones offer Cancel; a job's `retryable` or `cancellable` opts it out. Each is an icon button in one reserved column, so every duration lines up; when a job's action goes away under focus, focus stays on its row. A job settling (finished, failed, cancelled) is announced; progress and ticking times are not. The header's summary reads "2 running · 1 failed · 5 done". |
| `RefreshOverlay` | `refreshing`, `children?`, `label?` ("Updating…"), `className?` | Content that is still valid while a fresh copy loads. Its content is `aria-busy` at once (the announcement of the note sits outside it, so it is not held back), and past the 400 ms gate draws a thin bar along its top edge and a small "Updating…" note in the corner, both on top of the content: nothing moves, nothing is dimmed, and the content stays usable. For a first load with nothing to show, use `PaneState` or `Skeleton`. |
| `StaleIndicator` | `updatedAt?`, `staleAfterMs?`, `stale?`, `disconnected?`, `refreshing?`, `onRefresh?()`, `refreshLabel?` ("Refresh"), `className?` | "Updated 5m ago" as a live `TimeAgo`, for a `StatusBar` or a `PaneHeader` subtitle. Older than `staleAfterMs` (a positive number of ms), or with `stale`, a clock glyph marks it out of date; `disconnected` leads with "Disconnected" and the last update after it. `onRefresh` adds a refresh button that spins while `refreshing`, and ignores presses until it stops. Dropping to `disconnected` and coming back are announced; the age ticking over is not. It takes the text size of where it sits. |

```tsx
import {
  BulkActionBar,
  Drawer,
  DrawerToggle,
  GroupedVirtualList,
  ListRow,
  LoadMoreFooter,
  MasterDetail,
  PaneLayout,
  StaleIndicator,
  StatusBar,
  Toolbar,
  useSelection,
} from "@daintreehq/plugin-ui";

const selection = useSelection({ ids: issues.map((issue) => issue.id) });

<PaneLayout
  scroll="none"
  toolbar={
    <Toolbar variant="bar" aria-label="Issues">
      <DrawerToggle
        label="Filters"
        controls="filters"
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
      />
    </Toolbar>
  }
  footer={
    <BulkActionBar
      selection={selection}
      noun="issue"
      actions={[{ id: "close", label: "Close", icon: "x", onSelect: closeSelected }]}
    />
  }
  statusBar={
    <StatusBar
      right={<StaleIndicator updatedAt={syncedAt} staleAfterMs={300_000} onRefresh={sync} />}
    />
  }
>
  <Drawer
    open={filtersOpen}
    onOpenChange={setFiltersOpen}
    panelId="filters"
    title="Filters"
    panel={<Filters />}
  >
    <MasterDetail
      persistKey="issues"
      selectedId={openId}
      onBack={() => setOpenId(null)}
      detailTitle={openIssue?.title}
      list={
        <GroupedVirtualList
          aria-label="Issues"
          groups={groups}
          collapsible
          renderItem={(issue) => (
            <ListRow title={issue.title} onSelect={() => setOpenId(issue.id)} />
          )}
          footer={<LoadMoreFooter status={pageStatus} onLoadMore={loadMore} autoLoad />}
        />
      }
      detail={<IssueDetail issue={openIssue} />}
    />
  </Drawer>
</PaneLayout>;
```

### Settings grammar

The same section → group → row grammar Daintree's own settings pages use. Which parts you draw depends on where the settings are:

- **Inside a panel** — a settings tab of your own app, say — draw all three: a stack of `SettingsSection`s, each holding `SettingsGroup`s of `SettingsRow`s, with a `SettingsActions` row where a group saves explicitly.
- **In a `location: "settings"` view**, draw rows only. The host draws the section heading and the one group around the view, so render `SettingsRow`s under a root with `divide-y divide-border-subtle` and no `SettingsSection`, `SettingsGroup` or `SettingsActions`: every change applies as it is made. See [Views → A settings section](./views.md#a-settings-section).

| Export | Props | Notes |
| --- | --- | --- |
| `SettingsSection` | `title`, `description?`, `action?`, `badge?`, `id?`, `children?` | Sentence-case title, no icon. `action` is one control on the heading's right; `badge` a short tag ("Beta"). |
| `SettingsGroup` | `label?`, `id?`, `children?` | One surface of related rows split by hairlines. `label` sits above it when a section has more than one group. |
| `SettingsRow` | `label`, `description?`, `control?: ReactNode \| ((ids) => ReactNode)`, `layout?: "inline" \| "stacked"`, `accessory?`, `disabled?`, `disabledReason?`, `error?`, `isModified?`, `onReset?`, `id?` | Words on the left, control on the rail. A function `control` receives `{ labelId, descriptionId, disabled }` to wire as `aria-labelledby` / `aria-describedby`. `stacked` for paths, code and lists. `isModified` draws the modified-from-default mark, and with `onReset` a reset button. |
| `SettingsActions` | `children?`, `status?` | The explicit-save row at the end of a group: actions right-aligned (`contrast` Save, `outline` others, all `size="sm"`), and a politely announced status on the left. |

### Data display

| Export | Props | Notes |
| --- | --- | --- |
| `StatCard` | `label`, `value`, `delta?`, `formatDelta?(magnitude)`, `tone?: Severity`, `hint?`, `children?`, `className?`; DOM props | One figure for a dashboard row: a sentence-case label (never an uppercase eyebrow), the figure in tabular numerals, and one quiet `hint` line. A number `delta` is signed and drawn with an up or down arrow, and stays neutral, since whether up is good depends on the figure. `formatDelta` gives a number delta its unit and keeps the sign and arrow: it is handed the magnitude and returns the text after the sign, so `(n) => n.toFixed(1) + "%"` draws ↑ +12.5%. A string `delta` is drawn as given, with no arrow. `tone` adds its severity glyph beside the label and leaves the figure neutral; `success` is for a recorded result, never standing health. Cards carry a hairline and no fill or accent, so a row of them stays quiet. `children` sits below, for a `Sparkline`. Format the value yourself (`formatCount`, `formatBytes`, `formatDuration`). |
| `Sparkline` | `values: number[]`, `"aria-label"`, `height?` (24), `tone?: Severity`, `min?`, `max?`, `className?` | A trend line with no axes, drawn in the secondary text colour or a status colour, never accent, with a dot on the newest value. It fills its container's width. `min`/`max` fix the scale; omitted, it is the values' own range. A non-finite value is a gap, and fewer than two values draw an empty box of the same height. `success` draws neutral: a trend is standing status. An empty `aria-label` hides it from assistive tech, for a line whose figure is already in text beside it. |
| `DiffStat` | `additions?`, `deletions?`, `className?` | Line churn in Daintree's one spelling, "+12 -3": additions in the success ink, deletions in the error ink, since here they are diff notation rather than status. A zero side is left out, and so is the whole stat when both are. It takes its size from the text around it. |

### Dates

Days are ISO `"YYYY-MM-DD"` strings and ranges are `{ start, end }` of them, both ends inclusive. A day is not an instant, so it carries no time or zone and names the same day for every user; never pass one through `new Date("2026-09-30")`, which reads it as UTC midnight and lands on the 29th west of Greenwich. Month and weekday names and the first day of the week follow the user's locale.

| Export | Props | Notes |
| --- | --- | --- |
| `Calendar` | `mode?: "single" \| "range"`, `value?`, `defaultValue?`, `onValueChange?`, `min?`, `max?`, `isDateDisabled?(date)`, `month?: "YYYY-MM"`, `defaultMonth?`, `onMonthChange?`, `numberOfMonths?: 1 \| 2`, `weekStartsOn?: 0–6`, `"aria-label"?`, `className?`, `id?`, `data-*` | An inline month grid, the building block of the pickers. In `single` mode the value is a day; in `range` mode it is a range, reported once both ends are pressed (in either order) and previewed between the two presses. One tab stop: arrows move by day and week, PageUp/PageDown by month and with Shift by year, Home/End to the week's ends, Enter or Space chooses. Today is marked and the selection is the neutral inverse fill, never accent. A disabled day, or one outside `min`/`max`, can take focus but not be chosen. |
| `DatePicker` | `value?: string \| null`, `defaultValue?`, `onValueChange?(value \| null)`, `min?`, `max?`, `isDateDisabled?`, `weekStartsOn?`, `placeholder?`, `clearable?` (true), `disabled?`, `required?`, `invalid?`, `name?`, `open?`, `onOpenChange?`, `density?: "default" \| "compact"`, `id?`, `"aria-label"?`, `"aria-labelledby"?`, `"aria-describedby"?`, `className?` | A field drawn like `Input` that shows the day as "Sep 30, 2026" (in the Gregorian calendar and Western digits whatever the locale, so what it shows can be typed back) and opens a `Calendar` from its calendar button (or Alt+Down) in a modal popover: it is announced as a modal dialog, Tab stays inside it, the page behind is inert, and Escape or a click away closes it and returns focus to the button (to the text, when Alt+Down opened it). Same height as `Input` and `Select` at either density, so it lines up in a form row. Typing is lenient: `2026-09-30`, `2026/9/30`, `Sep 30 2026`, `30 September`, or the locale's numeric order; it is checked on Enter or blur, and text that is not an allowed day marks the field invalid without touching the value. Escape puts the text back. `null` is empty; the clear button hides when `required`. `name` submits the ISO value in a native form. Joins a `FormField` on its own. |
| `DateRangePicker` | `value?: { start, end } \| null`, `defaultValue?`, `onValueChange?(range \| null)`, `presets?: { label, range }[]`, and the rest of `DatePicker`'s | Lays out for the room the popover actually has (the window less any panel open on the right edge; the panel floats over the app, so it is not held to the width of the view that opens it): two months side by side where they fit in a row with the presets (the month before and the month `max` falls in, when the month after it would be wholly past `max`, so a range ending today opens on last month and this one), one month where they do not, and where even the presets and one month do not fit in a row, the presets wrap above the month; `presets` ("Last 7 days") are otherwise listed beside the months; work a preset's range out when you render. A preset whose ends `min`, `max` or `isDateDisabled` rule out is shown disabled, as a typed range with those ends would be refused. Shows a range with the parts both ends share said once, in the locale's order ("Sep 24 – 30, 2026", "Sep 24 – Oct 3, 2026", "Dec 28, 2026 – Jan 3, 2027"), ending in an ellipsis when the field is too narrow; while the text has focus it reads in full ("Sep 24, 2026 – Sep 30, 2026"), so what you edit is what the parser reads back. Typed ranges take two dates with `–`, `-` or `to` between. `name` submits `start/end`. |
| `TimeAgo` | `value: number \| string \| Date`, `verbose?`, `prefix?`, `tooltip?` (true), `className?`, `id?`, `data-*` | A `<time dateTime>` reading `formatTimeAgo` ("5m ago"), or `formatRelativeTime` ("5 minutes ago") when `verbose`, that keeps itself current: every `TimeAgo` shares `useNow`'s clocks, ticking every 30 s for the first hour and then every 5 minutes and every hour (by the second only while a verbose age is under a minute), and none tick while the view is hidden. The full date and time is in a tooltip; `tooltip={false}` puts it in a native `title` instead, for an age inside a button or option. |

### Pickers and forms

Colours are lowercase `"#rrggbb"`. A time is `"HH:mm"` on a 24-hour clock whatever the user's locale shows, and a date-time is `"YYYY-MM-DDTHH:mm"`, a day and a wall time with no zone, as `<input type="datetime-local">` holds it.

| Export | Props | Notes |
| --- | --- | --- |
| `ColorSwatch` | `color`, `size?: "xs" \| "sm" \| "md" \| "lg"`, `shape?: "circle" \| "square"`, `selected?`, `"aria-label"?`, `disabled?`, `className?`; DOM props | A chip of one colour with a strong-border edge, so white and near-black keep their shape on either theme. Given an `onClick` (a `Popover` or `DropdownMenu` trigger hands it one) it is a button, named by its hex unless `aria-label` says otherwise; without, an image. A colour that is not hex draws the empty chip, a diagonal rule. `selected` rings it in the primary ink, never accent. |
| `ColorPicker` | `value?: string \| null`, `defaultValue?`, `onValueChange?(hex)`, `onBlur?()`, `swatches?: (string \| { value, label })[]`, `allowCustom?` (true), `variant?: "field" \| "swatch"`, `placeholder?`, `disabled?`, `invalid?`, `name?`, `open?`, `defaultOpen?`, `onOpenChange?`, `side?`, `align?`, `density?`, `id?`, `"aria-label"?`, `"aria-labelledby"?`, `"aria-describedby"?`, `className?` | For label and tag colours. The `field` trigger is a `Select`-sized field showing the chip, the hex and the swatch's name; `swatch` is the chip alone, for a dense row. The popover leads with the palette — by default the theme's twelve `category-*` colours, resolved in the active theme, each named for its hue — as one tab stop whose arrow keys move the choice in rows of six; a click picks and closes. Below it, with `allowCustom`, a saturation area and a hue strip (arrow keys move either), a hex field that also takes `#rgb`, `rgb()` and `hsl()` on Enter or blur (text it cannot read marks it invalid and Escape puts the colour back), the colour as HSL, and the eyedropper where the platform has one. `onValueChange` fires on every change, including each move across the area: save on close or with the form. Pair with `ColoredLabel` for the preview. |
| `TimePicker` | `value?: string \| null`, `defaultValue?`, `onValueChange?(time \| null)`, `onBlur?()`, `min?`, `max?`, `step?` (1), `hourCycle?: 12 \| 24`, `clearable?` (true), `disabled?`, `required?`, `invalid?`, `name?`, `open?`, `onOpenChange?`, `density?`, `id?`, `"aria-label"?`, `"aria-labelledby"?`, `"aria-describedby"?`, `className?` | Drawn like `DatePicker`: hour and minute segments, and AM/PM where the locale (or `hourCycle`) uses a 12-hour clock. Each segment is a spin button and a tab stop: Up/Down step it (the minute by `step`), digits type into it and move on once no further digit could fit, Left/Right and `:` move between segments, Backspace clears one. The value commits once every segment is filled; a time outside `min`/`max` marks the field invalid and leaves the value alone, and leaving the field half-typed puts the time back. The clock button (or Alt+Down) opens a list of times, spaced by the smallest multiple of `step` that is at least 15 minutes and held to `min`/`max`, with the arrow keys, Page Up/Down, Home/End and Enter. |
| `DateTimePicker` | `value?: string \| null`, `defaultValue?`, `onValueChange?(value \| null)`, `onBlur?()`, `min?`, `max?`, `isDateDisabled?`, `weekStartsOn?`, `step?`, `hourCycle?`, `timeZone?`, `showTimeZone?` (true), `clearable?`, `disabled?`, `required?`, `invalid?`, `name?`, `density?`, `id?`, `"aria-label"?`, `"aria-labelledby"?`, `"aria-describedby"?`, `className?` | A `DatePicker` and a `TimePicker` as one value, wrapping to two lines in a narrow pane, with the zone's short name ("GMT+10") after them and its IANA id in the tooltip. `timeZone` only names the zone: the value is the wall time as typed. Picking a day with no time yet fills the earliest time allowed that day (midnight unless `min` says later); a time with no day yet fills today; clearing the day clears the value. `min` and `max` bound the days, and the time on their first and last day. |
| `RangeSlider` | `value?: [low, high]`, `defaultValue?`, `onValueChange?([low, high])`, `onValueCommit?`, `onBlur?()`, `invalid?`, `min?` (0), `max?` (100), `step?` (1), `minDistance?` (0), `formatValue?(value)`, `showValue?`, `marks?: (number \| { value, label })[]`, `tooltip?: "auto" \| "never"`, `thumbLabels?: [string, string]`, `name?`, `disabled?`, `"aria-label"?`, `"aria-labelledby"?`, `"aria-describedby"?`, `className?` | `Slider` with two thumbs, drawn exactly like it: the primary ink fills the span between them. Each thumb is its own `slider` with its own keys — arrows step, Page Up/Down step ten times, Home/End go as far as the other thumb allows — and the thumbs never cross or come closer than `minDistance`, which is rounded up to whole steps. A press on the track moves the nearer thumb and drags it. While a thumb is dragged or has keyboard focus, its value floats over it in the tooltip card. `marks` draws ticks under the track, labelled where given one. `showValue` shows "low – high" beside it; `formatValue` words both, and is spoken. `name` submits two fields, low first. |
| `ToggleGroup` | `items: { value, label?, icon?, "aria-label"?, tooltip?, disabled? }[]`, `type?: "multiple" \| "single"`, `value?: string[]`, `defaultValue?`, `onValueChange?(values)`, `onBlur?()`, `invalid?`, `"aria-label"`, `disabled?`, `density?: "default" \| "compact"`, `className?` | Subtle toggle buttons, as Daintree's own weekday picker in Notification settings draws them; an "on" button wears the kit `Button`'s `pressed` look (the filter chip's selected fill with a secondary-ink edge that holds 3:1 in either theme), never accent. Sizes are a small `Button`'s 28 px, or 24 px `compact`. `multiple` (the default) turns any number on — weekdays, text styles; `single` turns at most one on and lets it go again. For exactly one, always, use `SegmentedControl`. One tab stop: arrows, Home and End move between the buttons, Space or Enter toggles. Inside a `Toolbar`, the toolbar's own arrow keys run through the buttons instead. An icon-only item needs `aria-label`, which is also its tooltip. `onValueChange` receives the values in the items' order. |
| `SplitButton` | `children`, `onClick?`, `items` (as `DropdownMenu`), `variant?`, `size?`, `icon?`, `loading?`, `disabled?`, `menuDisabled?`, `type?: "button" \| "submit"`, `menuLabel?` ("More options"), `side?`, `align?` ("end"), `className?` | A primary action and, on a chevron that is its own tab stop, a `DropdownMenu` of the alternatives — every entry type, submenus and descriptions included. Both halves share one shape in any `Button` variant but `link` and `pill`, and every size; the seam is the variant's own ink. `loading` spins the primary half and disables both. In a settings group, `variant="contrast"` and `size="sm"`, as `SettingsActions` asks. |
| `Form` | `form` (a `useForm` result), `children?`, `"aria-label"?`, `"aria-labelledby"?`, `className?`, `id?`, `data-*` | A native `<form noValidate>`: Enter in a text field or a time segment, or a `type="submit"` button, runs `form.submit()` (a second submit while one is running is refused), a `type="reset"` button runs `form.reset()`, and a submit that fails a check moves focus to the first invalid control. Its fields show while the kit loads. |
| `FormStatus` | `form`, `id?`, `data-*` | The form's status for `SettingsActions`' `status`: "Unsaved changes", "Saving…" with a spinner, "Saved" with a check, or a failed check ("Fix 2 fields") or submit (its message) in the error ink with its glyph. Nothing while the form is clean. `SettingsActions` announces it politely; anywhere else, put it in a `LiveRegion`. |
| `SchemaForm` | `schema`, `value?`, `defaultValue?`, `onValueChange?(value)`, `errors?: Record<string, string>`, `label?`, `disabled?`, `id?`, `data-*` | A `SettingsGroup` generated from a JSON Schema by the same generator as your plugin's [settings](./contribution-points.md#settings-schema--shipped), so it reads and behaves like the form in your settings home. One row per property of a root `object`: `string` is a text field (`format: "password"` or `writeOnly` masks it), `number` and `integer` a number field held to `minimum` and `maximum` (an `integer` refuses a fraction), `boolean` a switch, a string `enum` a segmented control (up to five short options) or a select, and `object` or `array` a JSON text area. `title`, `description`, `default` and the root's `required` are read; any other keyword is ignored, with a console warning in development (the annotations `$schema`, `$id`, `$comment` and `examples` quietly). Text commits as the field is left or on Enter, choices at once, and a field left empty is removed from the value, except a required one with no `default`, which keeps the edit and says "Enter a value". |

`useForm(options)` holds a form's state; spread `form.field(name)` onto a kit control and hand `form.errors[name]` to its `FormField`.

| Option | Notes |
| --- | --- |
| `initialValues` | The values the form starts from and what "dirty" compares against, structurally (arrays and plain objects by content). |
| `validators?: { [name]: (value, values) => message \| undefined \| Promise<…> }` | Per-field checks. With `validateOn` `blur` (the default) a field is checked once it is left and on every change after that; `change` checks on every change; `submit` only on submit. An async check shows `isValidating`, and one that finishes after a newer one is dropped. |
| `validate?: (values) => { [name]: message } \| Promise<…>` | A whole-form check, run on submit, for rules across fields. |
| `onSubmit(values)` | Called once every check passes. On success the values become the new clean state and the status reads "Saved"; a throw or rejection keeps the form dirty and shows its message. |

It returns `{ values, errors, dirtyFields, isDirty, isSubmitting, isValidating, status, statusMessage, submitError, setValue(name, value), setValues(partial), setError(name, message), reset(values?), submit(), field(name) }`. `errors` holds what should show: a field's once it has been checked, every field's after a submit. `status` is `clean`, `dirty`, `invalid`, `submitting`, `saved` or `error`, and `statusMessage` says it in words. `field(name)` is `{ name, value, onValueChange, onBlur, invalid }`.

```jsx
const form = useForm({
  initialValues: { name: "", color: "#2f81f7", window: [2, 4] },
  validators: {
    name: async (name) =>
      !name.trim() ? "Enter a name" : (await exists(name)) ? "That name is taken" : undefined,
  },
  onSubmit: (values) => saveLabel(values), // your own save, e.g. through useHostChannel
});

<Form form={form} aria-label="New label">
  <SettingsGroup>
    <SettingsRow
      label="Name"
      error={form.errors.name}
      control={(ids) => (
        <Input
          {...form.field("name")}
          aria-labelledby={ids.labelId}
          aria-describedby={ids.descriptionId}
          disabled={ids.disabled}
        />
      )}
    />
    <SettingsRow
      label="Colour"
      control={<ColorPicker {...form.field("color")} aria-label="Colour" />}
    />
    <SettingsRow
      label="Priority"
      layout="stacked"
      control={
        <RangeSlider
          {...form.field("window")}
          min={0}
          max={5}
          minDistance={1}
          aria-label="Priority range"
        />
      }
    />
    <SettingsActions status={<FormStatus form={form} />}>
      <Button variant="outline" size="sm" type="reset" disabled={!form.isDirty}>
        Discard
      </Button>
      <SplitButton
        variant="contrast"
        size="sm"
        type="submit"
        disabled={!form.isDirty}
        loading={form.isSubmitting}
        items={[{ label: "Save as template", onSelect: () => saveTemplate(form.values) }]}
      >
        Save
      </SplitButton>
    </SettingsActions>
  </SettingsGroup>
</Form>;
```

### Navigation

| Export | Props | Notes |
| --- | --- | --- |
| `Breadcrumbs` | `items: { label, onSelect?, icon? }[]`, `maxItems?` (4), `"aria-label"?` ("Breadcrumb"), `className?`, `id?`, `data-*` | The path to the current page. A crumb with `onSelect` is a link back to that level; the last is the current page (`aria-current="page"`) and never a link. Past `maxItems` the first crumb and the last `maxItems - 1` stay and the ones between fold into a menu. The trail also fits its width: ancestors truncate first, then fold into that menu from the middle out (the root last) until the row holds, and the current page stays on screen, truncating only once every ancestor is folded. |
| `NavList` | `sections?: { label?, items }[]` or `items?`, items `{ id, label, icon?, count?, badge?, disabled?, children? }`, `value?: string \| null`, `defaultValue?`, `onValueChange?(id)`, `"aria-label"`, `className?`, `id?`, `data-*` | The left rail of an app, drawn with Daintree's sidebar rows: the selected destination takes the neutral highlight, never the accent. One tab stop: Up/Down/Home/End move the cursor, Enter or Space selects, typing jumps to a matching label, and disabled rows are skipped. `children` nests one level, indented under its parent. A positive `count` draws a count pill (compacted past 999); `badge` takes a short node such as a kit `Badge`. Controlled when you pass `value`. It mounts every row, as a rail of destinations should be short; for a list of records, use `VirtualList`. |
| `Stepper` | `steps: { id, label, description?, state? }[]`, `current`, `orientation?: "horizontal" \| "vertical"`, `onStepSelect?(id)`, `"aria-label"?` ("Progress"), `className?`, `id?`, `data-*` | A wizard's progress. Steps before `current` are complete (a check), `current` is the high-contrast numbered marker (`aria-current="step"`), later ones are upcoming; a step's own `state` overrides that, `error` drawing the error glyph. Neutral throughout. With `onStepSelect`, complete and error steps are buttons that go back to them. `horizontal` runs across the top of a wizard, `vertical` down its side with descriptions wrapping. A horizontal stepper too narrow for every label keeps every marker and connector but names only the current step, with "Step 3 of 4" under it; the other names stay available to assistive tech. |

### Charts

Small SVG charts, deliberately opinionated: data in, chart out, no styling beyond a few safe choices. They share one data shape — `data` is an array of plain row objects, `x` names the key that holds each row's category or x value, and `series` lists `{ key, label, color? }` for the row keys that hold numbers — so the same rows feed a table and a chart. A value that is not a finite number is a gap, never a zero. Each fills its container's width (measured with `ResizeObserver`, never a layout read) at the `height` you give the plot, 200 px by default.

Series take the categorical colours in one fixed order — `blue`, `amber`, `indigo`, `orange`, `violet`, `teal` — read from the theme's `category-*` tokens with a fallback, and painted through CSS variables, so a theme switch repaints them with no re-render. The order keeps every pair of neighbours apart under colour-vision deficiency, in the default themes and in the colour-vision themes. The hues share one lightness, so a seventh could not be told from its neighbours: a chart draws at most six series. The rest are not drawn but not hidden either: the legend ends with a quiet "+N more not shown", the visually hidden table keeps their columns and names them in its caption, and development builds warn. Fold the tail into an "Other" series yourself. Colour is never a line's only signal: series take a stroke by position as well — solid, dashed, dotted, long dash, dash-dot, dash-dot-dot — which the legend and tooltip swatches repeat; bar charts key with squares. Pin `color` on a series so it keeps its colour when a filter removes the one before it; `neutral` is a quiet grey for a comparison such as the previous period.

Hovering a bar, part or x position, or focusing the chart (one tab stop) and pressing the arrow keys, shows one tooltip anchored to that point: the x value, then each series' value, figure first. It sits to the right of the point, clear of its bars, and flips left only when it would run past the chart's edge, so the values just before it stay in view; on a column or line chart it rides at the top of the plot rather than over the marks. Home, End, Page Up and Page Down jump; Escape hides it. Keyboard moves are announced. Behind every chart is a visually hidden table of its numbers, which the chart's `aria-describedby` points at, or past 250 rows a one-paragraph summary of the range and each series' low and high. Nothing animates, so reduced motion needs no special case, and nothing runs while the chart is idle.

| Export | Props | Notes |
| --- | --- | --- |
| `BarChart` | `data`, `x`, `series`, `"aria-label"`, `mode?: "grouped" \| "stacked"`, `orientation?: "vertical" \| "horizontal"`, `height?` (200), `formatValue?(value)`, `formatX?(value)`, `xLabel?`, `loading?`, `empty?`, `className?` | A value per category. `grouped` (the default) sets a category's bars side by side; `stacked` piles them, positives up from zero and negatives down, with a two-pixel gap between segments. `horizontal` lays the bars across, for long category names; labels that do not fit are ellipsised and read in full in the tooltip and table. Bars are at most 24 px thick with a rounded data end and a square base. The axis starts at zero, with round-number ticks and hairline gridlines spaced by the room they have: about one per 100 px across and 50 px up, never fewer than three. Up to 1,000 categories; past that, use a `LineChart`. |
| `LineChart` | `data`, `x`, `series`, `"aria-label"`, `xType?: "number" \| "time"`, `area?`, `curve?: "linear" \| "monotone"`, `height?` (200), `formatValue?(value)`, `formatX?(value)`, `xLabel?`, `loading?`, `empty?`, `className?` | Series over a numeric or time x. `x` may hold numbers, `Date`s, epoch ms or ISO strings; `time` (inferred from a `Date` or string) ticks on calendar steps — hours, days, months, years — in local time; a time x outside what a `Date` can hold drops its row. Rows need not be sorted. `area` fills a faint wash of the first series' colour down to zero (only the first: several washes would blend into a colour no line has); `monotone` smooths without overshooting a value. A crosshair snaps to the nearest x. A series longer than twice the plot's width in pixels is thinned to the first, lowest, highest and last point of each pixel column, so a hundred thousand points draw the same silhouette as a few thousand; the tooltip still reads every row. |
| `DonutChart` | `data`, `x` (the part's name key), `value` (its size key), `"aria-label"`, `centerValue?` (the formatted total), `centerLabel?`, `otherLabel?` ("Other"), `height?` (200), `formatValue?(value)`, `loading?`, `empty?`, `className?` | Parts of a whole around a centre figure, with a legend beside it that lists every part's value and share; the legend is also what the chart's `aria-describedby` points at. Zero, negative and non-finite parts are left out. Past six parts, the first five keep their colours and the rest fold into one neutral `otherLabel` part. The ring is `height` across. |
| `StackedAreaChart` | `data`, `x`, `series`, `"aria-label"`, `xType?`, `normalize?`, `height?` (200), `formatValue?(value)`, `formatX?(value)`, `xLabel?`, `loading?`, `empty?`, `className?` | `LineChart`'s rows and x axis with the series piled bottom to top in their order, so the top edge is the total; a 2px surface gap parts the layers. Edges are straight between points: smoothing each edge on its own would let a layer's edges cross. `normalize` stacks each x to 100% for shares. A gap or a negative value counts as zero in the pile. The tooltip lists the layers top first, after the x and the total (shares as percentages when normalised). |
| `ScatterChart` | `data`, `x`, `series`, `"aria-label"`, `pointLabel?` (a row key naming each point), `xType?`, `height?` (200), `formatValue?(value)`, `formatX?(value)`, `xLabel?`, `loading?`, `empty?`, `className?` | Points placed by x and each series' y. At most **three** series are drawn — any two points can sit side by side, and past the third slot the hues cannot all be told apart — each with its own marker (circle, square, triangle) so colour is never the only signal; the rest are listed with "+N more not shown" and kept in the table. Hovering finds the nearest point within 24px; the arrow keys walk the points in x order. |
| `Histogram` | `data`, `value` (the measured key), `"aria-label"`, `bins?` (one per 24px; at most 40 are drawn), `color?` (`blue`), `countLabel?` ("Count"), `height?` (200), `formatValue?(value)`, `loading?`, `empty?`, `className?` | How many values fall in each range, as touching columns on round bin edges (the last bin holds its upper edge). `formatValue` formats the measured value — the edges and the tooltip's range — and counts read in full. |
| `Heatmap` | `data`, `x`, `y`, `value`, `"aria-label"`, `xCategories?`, `yCategories?`, `color?` (`blue`), `formatX?(value)`, `formatY?(value)`, `yLabel?` ("Row"), `height?` (200), `formatValue?(value)`, `loading?`, `empty?`, `className?` | A value for each pair of categories (hour by weekday), as cells shaded in one hue from faint to full — never a rainbow — with the value range as a key above. Rows naming the same pair add up; a pair with no row is an empty cell, told apart from a zero. Categories run in first-appearance order unless `xCategories`/`yCategories` give it; at most 200 columns and 100 rows are drawn. The arrow keys move cell by cell. |
| `ContributionGrid` | `data`, `x` (a day: `Date`, epoch ms or ISO string), `value`, `"aria-label"`, `end?` (the latest day in `data`), `weeks?` (53), `weekStart?: 0 \| 1` (Sunday), `color?` (`blue`), `unit?` ("commits"), `height?`, `formatValue?(value)`, `loading?`, `empty?`, `className?` | A forge-profile calendar: a column per week, a row per weekday, each day in one of five shades by its share of the busiest day, with month and weekday labels and a "Less … More" key. Rows on the same local day add up. When the width runs out it keeps the newest weeks. `height` sets the cell size; omitted, a cell is 11px. The arrow keys move a day (Up/Down) or a week (Left/Right); the table fallback is a written summary with the total and the busiest day. |
| `Gauge` | `value`, `"aria-label"`, `min?` (0), `max?` (100), `label?`, `target?`, `thresholds?: { warning?, danger?, direction?: "above" \| "below" }`, `color?` (`blue`), `formatValue?(value)`, `size?` (160, at least 96), `loading?`, `className?` | One number against its range as a 240° arc with the figure inside and the range's ends beneath. Announced as a `meter`. `thresholds` turn the arc to the warning or danger colour with its glyph by the figure; `below` is for a level where less is worse (coverage). Below every threshold it is the chart colour, never green: a number under a warning line is not a success. `target` draws a tick on the arc. A 0–100 range reads as a percent; a `max` not above `min` falls back to 0–100. |

`formatValue` formats the axis ticks, tooltip, legend and table; omitted, the axis reads compact (`1.2K`) and the rest in full (`1,234`). `formatX` does the same for x. A formatter that throws or returns something other than a string gets the default label for that value. `loading` draws the kit's `Skeleton` at the chart's height; with no data, `empty` is shown, or a quiet "No data", centred in a frame the chart's height. Props from untyped JavaScript are narrowed like every kit component's: a bad value falls back to its default rather than throwing.

```tsx
<ContributionGrid data={commits} x="day" value="count" unit="commits" aria-label="Commits, last year" />
<Heatmap data={builds} x="hour" y="weekday" value="minutes" aria-label="Build minutes by hour and weekday"
  yCategories={["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]} formatValue={(m) => `${m} min`} />
<Gauge value={coverage} target={80} thresholds={{ warning: 70, danger: 50, direction: "below" }}
  label="Line coverage" aria-label="Line coverage" />
```

### Rich display

CLI output, hover previews, pictures and long documents. Every one is a host component under your props: `TerminalOutput` reads in the terminal's own colours, `HoverCard` is the host's issue-card surface, `ImageViewer` zooms on the file viewer's model, and `TableOfContents` tracks a document drawn with the kit's `Markdown`.

| Export | Props | Notes |
| --- | --- | --- |
| `AnsiText` | `text`, `display?: "inline" \| "block"`, `className?`, `id?`, `data-*` | A short run of CLI output with its colours and styles: a status line, a commit summary, one log line in a table cell. `inline` (the default) flows in a sentence in the mono face; `block` is a `pre` in the terminal font that keeps every line break. It parses exactly as `TerminalOutput` does. |
| `TerminalOutput` | `text`, `"aria-label"`, `title?`, `actions?`, `toolbar?` (true), `wrap?`, `defaultWrap?` (true), `onWrapChange?(wrap)`, `lineNumbers?`, `follow?` (true), `maxLines?` (10,000; at most 100,000), `empty?` ("No output"), `className?`, `id?`, `aria-*`, `data-*` | A process's output on the terminal background, in the terminal font, with the same `terminal-*` theme colours a Daintree terminal draws: the 16 ANSI colours and their bright pair (bold text takes the bright one, as the terminal does), the 256-colour palette and truecolor, bold, dim, italic, underline, strikethrough, reverse video and hidden text. A carriage return rewrites its line and `\x1b[K` clears it, so a progress bar collapses to its last frame; cursor moves within the output (up, down, to a column) land where a terminal would put them, and every other control sequence is dropped. OSC 8 hyperlinks to `http`, `https` and `mailto` targets are links that open through the host, like the kit's `Link` (never dragged, never navigating the view); any other target draws as plain text. The parser is bounded for output you did not write: a line keeps its first 16,384 characters, past 512 differently styled runs the rest of a line takes the last run's style, an escape too long to be real is dropped whole with its text still hidden, a malformed one gives way to the text after it, and an OSC never runs past the end of its line. Pass the whole output as one string as it grows: when the new text starts with the old, only the tail is parsed. Virtualised, it follows the newest line while the reader is at the bottom, and is one tab stop (`role="log"`, not live). The toolbar holds `title` on the left, then your `actions`, a Wrap toggle and Copy (the plain text, escapes removed). It fills its container's height. |
| `HoverCard` | `children` (the trigger element), `content`, `openDelay?` (300), `closeDelay?` (150), `side?` (`bottom`), `align?` (`start`), `width?: "sm" \| "md" \| "lg"` (`md`, the host's 280px card; `sm` 224px, `lg` 320px), `open?`, `defaultOpen?`, `onOpenChange?(open)`, `"aria-label"?`, `disabled?` | A preview of a person, an issue or a commit, on the surface Daintree's own issue and pull request cards use. It opens after `openDelay` on hover or as soon as the trigger takes keyboard focus, stays open while the pointer is on the trigger or the card (WCAG 1.4.13), lingers `closeDelay` after it leaves both, and closes at once on Escape or blur. It is not auto-dismissed and does not close for a dialog transition. A click inside never reaches the row behind the trigger. The card is a description, not a menu: it does not take focus, so anything in it the user acts on must also be reachable from the trigger (open the profile on its click). `aria-label` is what a screen reader reads for it; omitted, the card's text. The trigger shows while the kit loads. |
| `ImageViewer` | `images: { src, alt, caption? }[]`, `index?`, `defaultIndex?` (0), `onIndexChange?(index)`, `mode?: "pane" \| "modal"`, `open?`, `onOpenChange?(open)`, `title?` ("Image"), `defaultZoom?: "fit" \| "actual" \| number`, `checkerboard?` (true), `"aria-label"?`, `className?`, `id?`, `data-*` | Screenshots and design previews. `pane` fills its container; `modal` is a lightbox on the host dialog, with the title, "2 of 5" and a close button, closed by Escape. The wheel and a trackpad pinch zoom about the pointer, a touch pinch about the fingers, a drag pans a picture larger than the stage (never past its edges), and a double-click toggles between fit and twice the fit. On the keyboard the stage is one tab stop: `+` and `-` zoom, `0` fits, `1` is 100%, the arrows pan a picture larger than the stage and otherwise Left and Right step, Page Up and Page Down always step, and Home and End go to the first and last. The status strip shows the picture's pixel size and zoom, beside Previous and Next, Zoom out, Zoom in, Fit and 100%. Past 200% the pixels stay square. A checkerboard under the picture shows transparency; a picture that fails to load says so with Retry. Neighbours are fetched ahead. Each picture opens at `defaultZoom` (fit, by default; fit never enlarges). |
| `TableOfContents` | `target` (a ref or element), `markdown?` or `headings?: { text, level, id? }[]`, `maxLevel?` (3), `collapsible?` (true), `sticky?` (true), `title?` ("On this page"; `null` for none), `offset?` (24), `onNavigate?(heading, index)`, `"aria-label"?` ("Table of contents"), `className?`, `id?`, `data-*` | The outline of a long document beside it. Give it the Markdown the document renders (its ATX and setext headings are read, fenced code skipped) or the headings, and `target`, the element the document is drawn in: its `h1`–`h6` are matched in order (by `id` when a heading has one), and found again as the document renders or changes. The entry for the section at the top of the scroller around `target` is marked (`aria-current="location"`, a bar on the rail) as the reader scrolls; a click scrolls its heading to the top (smoothly unless reduced motion is on). Entries indent by level; with `collapsible`, a section's subsections fold from its chevron, and a folded current section is marked on its parent. One tab stop: Up and Down move, Left folds or goes to the parent, Right unfolds or goes to the first child, Enter goes to the heading. `sticky` keeps it at the top of its own scroller. |

```tsx
const doc = useRef<HTMLDivElement>(null);

<TerminalOutput text={log} title="npm test" aria-label="Test output" lineNumbers />
<HoverCard content={<AuthorCard author={ada} />} aria-label="Ada Lovelace, 214 commits">
  <Link href={ada.url}>@ada</Link>
</HoverCard>
<ImageViewer images={shots} mode="modal" open={open} onOpenChange={setOpen} title="Screenshots" />
<Inline align="start">
  <TableOfContents markdown={report} target={doc} className="w-56" />
  <div ref={doc}><Markdown source={report} /></div>
</Inline>
```

### Drag and drop

Reordering and moving by drag, with the pointer or the keyboard. Every kit drag moves with pointer events on the host's own drag engine, never the system drag-and-drop, so it starts and ends inside your view: the panel grid, the tab strips and an agent terminal's [`daintree-context` drop](./views.md#handing-work-to-an-agent-by-drag) never see it, and a press inside a kit list never picks up the panel around it. The lifted copy rides beside the pointer on the host's drag-preview surface, as Daintree's own worktree ghost does, so it never covers the line it is aiming at, and stays within the view; the slot it came from stays behind, faded, as a placeholder; a scroller inside the view scrolls while the pointer holds within 40px of its edge; an empty or folded column arms as a whole, framed like Daintree's own drop targets. Picking up takes 8px of travel with the mouse, so a click is still a click, or a long press on touch. A press that starts on a button, link or field inside a draggable item belongs to that control.

On the keyboard, the list or board is one tab stop and the arrow keys move between items. Space picks the focused item up, the arrow keys move it (on a `Kanban`, Up and Down within its column and Left and Right to the next column), Space or Enter drops it and Escape puts it back; moving focus away also puts it back. The held item is drawn lifted at its new position as it moves, and every pickup, step and drop is announced with its position ("Rate limits, position 2 of 3 in In progress"). Reduced motion drops the lift's scale-in and the landing glide.

Every item also has a context menu (right-click, or Shift+F10 on the focused item) with the same moves and no drag at all: Move up, Move down, Move to top and Move to bottom, and on a `Kanban`, Move to each other column (at its end). That is the pointer alternative WCAG 2.5.7 asks a drag interface for, so a user who cannot drag is never stuck. While an item is held by keyboard, `renderItem` and `renderCard` get the position (and column) it is drawn at, and a column's count and WIP warning preview the move.

`SortableList` and `Kanban` do not reorder anything themselves: they report the move and draw whatever `items` or `cards` you hand back, so an ignored move puts the item back.

| Export | Props | Notes |
| --- | --- | --- |
| `SortableList<T>` | `items`, `renderItem(item, { index, isDragging, isOverlay, disabled })`, `"aria-label"`, `getId?(item, index)`, `onReorder?(from, to)`, `onChange?(items)`, `orientation?: "vertical" \| "horizontal"`, `handle?`, `isItemDisabled?(item, index)`, `getItemLabel?(item, index)`, `className?`; `id` and `data-*` | A list of rows the user reorders: priorities, a playlist, the columns of a table. The list draws each row (hover, lift, focus ring); `renderItem` draws its content, and is called once more with `isOverlay` for the lifted copy. `getId` defaults to the item's `id`, then its index; give items stable ids so a row keeps its state across a move. `onReorder` hears the old and new index, `onChange` the reordered array. With `handle`, a grip at the row's start is the only handle, so buttons in the row keep working; without it the whole row is the handle, so keep controls out of it. A disabled item cannot be picked up, but others can be dropped around it. The list takes its content's height: put a long one in a `ScrollShadow` or a sized container and dragging near the edge scrolls it. `horizontal` lays the rows in a single row for chips or tabs; put a long one in a sideways scroller. |
| `Kanban<T>` | `columns: { id, title, limit?, empty? }[]`, `cards: Record<columnId, T[]>`, `renderCard(card, { columnId, index, isDragging, isOverlay, disabled })`, `"aria-label"`, `getCardId?(card)`, `onMove?({ cardId, fromColumn, toColumn, fromIndex, index })`, `handle?`, `isCardDisabled?(card)`, `getCardLabel?(card)`, `columnActions?(column)`, `collapsible?`, `collapsedColumns?`, `defaultCollapsedColumns?`, `onCollapsedColumnsChange?(ids)`, `columnWidth?` (272), `className?`; `id` and `data-*` | A board of columns, each a hairline frame with a quiet uppercase title and its card count. `limit` is a work-in-progress limit: the count reads "4/3" and turns to a warning past it, but the drop is never refused. An empty column shows `empty` ("No cards" by default). Cards are drawn on the card surface with `renderCard` inside; a card is dragged within its column or to another, and `onMove` reports it once on drop, `index` being its place in `toColumn` after the move. Card ids must be unique across the board (`getCardId` defaults to the card's `id`). `columnActions` fills the end of each header (an "Add card" `IconButton`). With `collapsible`, each header gets a fold button that narrows the column to a strip, which still shows its count and still takes drops, at its end; keyboard moves skip folded columns. The board fills its container's height, each column scrolls on its own and the board scrolls sideways when the columns don't fit, so give it a sized container. `columnWidth` runs 200 to 480. |
| `DragDropProvider` | `children?`, `onDragStart?(event)`, `onDragOver?(event)`, `onDragEnd?(event)`, `onDragCancel?(event)`, `renderOverlay?(activeId)`, `getLabel?(id)`, `className?` | The scope for your own drag and drop, when neither component above fits: dragging a file onto a folder, a person onto a slot. Every event is `{ activeId, overId }`, `overId` being `null` off every target (treat that drop as a cancel). With `renderOverlay`, the lifted copy is yours and the dragged item stays in place, faded; without it the item itself moves with its `style`. On the keyboard the arrow keys jump between drop targets. `getLabel` names ids in the announcements. Without `className` the provider takes no box. |

`useDraggable({ id, disabled? })` returns `{ ref, handleProps, isDragging, style }`: put `ref` and `style` on the item and spread `handleProps` on what the user grabs, the item itself or a grip inside it (it is a focusable button that picks up with the pointer or Space). `useDroppable({ id, disabled? })` returns `{ ref, isOver, activeId }`; draw your own "drop here" cue from `isOver`. Ids are strings or numbers, unique within the provider. Both hooks are inert outside a `DragDropProvider` (and so until its kit has loaded): nothing can be picked up or dropped, and they never suspend.

```tsx
import { Badge, Kanban, SortableList } from "@daintreehq/plugin-ui";

<Kanban
  aria-label="Sprint board"
  columns={[
    { id: "todo", title: "Backlog" },
    { id: "doing", title: "In progress", limit: 3 },
    { id: "done", title: "Done" },
  ]}
  cards={cardsByColumn}
  renderCard={(card) => (
    <div className="flex flex-col gap-1.5">
      <span className="font-medium">{card.title}</span>
      <Badge tone="info">{card.label}</Badge>
    </div>
  )}
  onMove={({ cardId, toColumn, index }) => moveCard(cardId, toColumn, index)}
/>;

<SortableList
  aria-label="Priorities"
  items={priorities}
  handle
  renderItem={(item) => item.title}
  onChange={setPriorities}
/>;
```

### Editors

Editing surfaces that are Daintree's own: `CodeEditor` is the file viewer's CodeMirror editor, `DiffView` the diff panel, and `MarkdownEditor` the comment field. Don't bundle CodeMirror, a diff renderer or a Markdown toolbar of your own (lint: `editor-library-import`); these carry the app's fonts, gutters, selection and diff colours, find bar and hunk headers in every theme, and cost your view nothing until one renders. `CodeEditor` and `DiffView` each load their own chunk on first use and hold their place with a skeleton until then.

```tsx
import { Button, CodeEditor, DiffView, MarkdownEditor, revertHunk } from "@daintreehq/plugin-ui";

<CodeEditor
  aria-label="studio.yaml"
  language="yaml"
  value={draft}
  onChange={setDraft}
  onSave={save}
  className="h-80"
/>;

<DiffView
  oldText={saved}
  newText={draft}
  path="studio.yaml"
  view="split"
  hunkActions={[{ id: "revert", label: "Revert", icon: "rotate-ccw" }]}
  onHunkAction={(id, hunk) => {
    const next = revertHunk(draft, hunk);
    if (next !== null) setDraft(next);
  }}
/>;

<MarkdownEditor
  aria-label="Release notes"
  value={notes}
  onChange={setNotes}
  onSubmit={publish}
  layout="auto"
  footer={<Button onClick={() => publish(notes)}>Publish</Button>}
/>;
```

| Export | Props | Notes |
| --- | --- | --- |
| `CodeEditor` | `value?`, `defaultValue?`, `onChange?(value)`, `language?`, `readOnly?`, `lineNumbers?` (true), `wrap?`, `placeholder?`, `minHeight?`, `maxHeight?` (px), `onSave?(value)`, `autoFocus?`, `bordered?` (true), `"aria-label"?`, `className?`, `ref?` | The file viewer's editor made editable: its theme, gutters and fold markers, bracket matching, undo history and the app's find and replace bar (Cmd+F inside the editor, or the app's Find in focused panel while it has focus; Cmd+L goes to a line where the app leaves it free). `language` takes a name, alias or extension from the languages the file viewer highlights (`json`, `yaml`, `ts`, `tsx`, `python`, `markdown`, `sql`, `go`, `rust`, `css`, `html`, …); unknown, the text is plain. `onChange` gets the whole text on every edit, never mid-way through an IME composition, and a new `value` replaces the text without calling it. `onSave` claims Cmd+S (Ctrl+S) inside the editor; without it the key is left to the app. `readOnly` keeps the text selectable and searchable. Tab moves focus out, as in every host editor. Without `maxHeight` the editor grows with its text, or fills the height `className` gives it; past `maxHeight` it scrolls. `bordered={false}` drops the field border for an editor that fills a pane edge to edge. `ref` holds `focus()` and `openSearch()`. |
| `DiffView` | `oldText?` + `newText?`, or `patch?`; `path?`, `language?`, `view?: "unified" \| "split"` (`unified`), `wrap?`, `context?` (3), `hunkActions?`, `onHunkAction?(id, hunk)`, `renderHunkActions?(hunk)`, `maxHeight?` (px), `"aria-label"?`, `className?` | The diff panel's surface: highlighted, with its line-number gutters and +/- markers, hunk headers, moved-line and whitespace marks and per-hunk copy. Two texts are diffed for you (the same line diff git uses), `context` unchanged lines around each change, and the rest fold behind Expand buttons in the hunk headers. `patch` takes `git diff` output (several files draw one after another), `diff -u` output (paths without `a/` and `b/`, with or without timestamps, one or several files) or a lone hunk. `path` names the file in the header and picks the highlighting; `language` overrides it. `split` puts the two sides side by side with one shared horizontal scroll. `hunkActions` (`{ id, label, icon?, tooltip?, disabled? }[]`, or a function of the hunk returning one) are buttons at the end of each hunk header, and `onHunkAction` receives the pressed one's `id` and the hunk: `index`, `filePath`, `header`, `oldStart`, `oldCount`, `newStart`, `newCount`, `oldText`, `newText` and `patch` (the hunk alone with its file headers, new and deleted files included, for `git apply`). `renderHunkActions` adds your own nodes after them. Identical texts draw the diff panel's "No changes detected". |
| `revertHunk(text, hunk)` | returns `string \| null` | `text` with a `DiffView` hunk undone: its new lines swapped back for its old ones. Pass the `newText` the diff was drawn from (or a later copy the hunk still matches); null when those lines no longer read as the hunk's new side, so a stale hunk is never spliced into the wrong place. A pure deletion drawn with `context={0}` has no lines to check and goes back where it says, so keep its hunk only as long as the text it came from. Whether the file ends in a newline is not part of a hunk: the text keeps its own. |
| `MarkdownEditor` | `value?`, `defaultValue?`, `onChange?(value)`, `placeholder?`, `mode?: "write" \| "preview"`, `defaultMode?`, `onModeChange?(mode)`, `layout?: "tabs" \| "split" \| "auto"` (`tabs`), `onSubmit?(value)`, `onCancel?()`, `minRows?` (3), `maxRows?` (16), `toolbar?` (true), `footer?`, `disabled?`, `readOnly?`, `autoFocus?`, `invalid?`, `basePath?`, `rootPath?`, `"aria-label"?`, `className?` | A field for comments, descriptions and notes, built like the app's own note composer: a text area that grows with its text from `minRows` to `maxRows`, a Write and Preview tab strip, and a toolbar for bold, italic, code (a fenced block over several lines), links and bulleted and numbered lists. Each toolbar edit is one step of the text area's own undo, and that history survives a look at Preview. Bold, italic, inline code and the lists come off again when pressed a second time. The keys are GitHub's (Cmd+I, Cmd+E, Cmd+Shift+8, …); one the app is bound to (Cmd+B toggles the sidebar, Cmd+K starts a chord) stays the app's and is not offered in the tooltip. Preview renders through `Markdown`, with `basePath` and `rootPath` as there, no shorter than the source was. `layout="split"` shows the source and preview side by side, and `auto` does so once the editor is 720px wide. Cmd+Enter calls `onSubmit` and Escape `onCancel`; `footer` is a row under the field for its buttons. |

### Git and forge

Worktrees, branches, files and their git state, commits, issues, pull requests, CI checks and dev servers, drawn exactly as Daintree draws its own: the worktree sidebar's ahead and behind marks, the change list's status letters, the file tree's icons, the commit list's rows and the GitHub builtin's issue and pull request rows. They are presentational: a view has no worktree or forge hooks, so the data comes from your worker (`host.getWorktrees()`, `host.git`, your forge provider) as props, and nothing here widens what a view can reach. A `WorktreeItem` uses `PluginWorktreeSnapshot`'s field names, so snapshots pass straight through. One look for every forge: GitHub, GitLab and a third-party provider's rows come out identical.

```tsx
import {
  ChecksList,
  CommitList,
  DevServerStatus,
  FileLink,
  GitStatusBadge,
  PullRequestRow,
  WorktreePicker,
} from "@daintreehq/plugin-ui";

<WorktreePicker worktrees={snapshots} value={worktreeId} onValueChange={setWorktreeId} />;

const rows = changes.map((change) => (
  <div key={change.path} className="flex items-center gap-2">
    <GitStatusBadge status={change.status} />
    <FileLink path={change.path} rootPath={worktree.path} />
  </div>
));

<CommitList commits={commits} loading={hasMore ? 1 : false} aria-label="Commits on main" />;

<PullRequestRow
  number={pr.number}
  title={pr.title}
  state={pr.isDraft ? "draft" : pr.state}
  url={pr.url}
  ci={pr.ciStatus}
  review="approved"
  labels={pr.labels}
  assignees={pr.assignees}
  updatedAt={pr.updatedAt}
/>;

<ChecksList title="Checks" checks={checks} />;

<DevServerStatus status="running" name="Vite" port={5173} />;
```

| Export | Props | Notes |
| --- | --- | --- |
| `BranchBadge` | `branch`, `className?`, `id?`, `data-*` | The host's own branch badge: mono, never uppercased (refs are case-sensitive), with a branch glyph, capped at 200px with the full name in a tooltip when it is cut. Nothing for an empty name. |
| `WorktreeBadge` | `worktree: WorktreeItem`, `showBranch?` (true), `showStatus?` (true), `className?`, `id?`, `data-*` | A worktree inline: the worktree glyph, its name (the branch, or the path's last segment, when it has none), its branch in mono unless that is the name, "Current" for `isCurrent`, then its changed files ("4 files", with a warning dot), `↑ahead` in the success ink and `↓behind` in the warning ink, as the worktree card draws them. The counts are one image named "4 changed files, 3 ahead, 1 behind". `WorktreeItem` is `{ id, name?, branch?, path?, isCurrent?, isMainWorktree?, aheadCount?, behindCount?, changedFileCount?, status?: { changedFileCount }, group? }`. |
| `WorktreePicker` | `worktrees: WorktreeItem[]`, `value?: string \| null`, `defaultValue?`, `onValueChange?(id, worktree)`, `open?`, `defaultOpen?`, `onOpenChange?(open)`, `placeholder?`, `searchPlaceholder?`, `emptyMessage?`, `disabled?`, `density?: "default" \| "compact"`, `"aria-label"?` ("Worktree"), `className?` | A `Select`-height trigger showing the chosen worktree and branch, opening a popover with a search over name, branch and path above the host palette's two-line worktree rows: name, branch, "Current", the badge's counts, and the path underneath. The worktrees are listed under "Main worktree" and "Worktrees", or under their own `group` names when any has one; a heading is drawn only when there is more than one group to tell apart. Each opening starts with an empty search. The chosen one carries a check; the search field keeps focus and Up/Down/Home/End move the cursor, Enter picks, Escape clears the search and then closes. Ids must be non-empty and unique; others are dropped. |
| `FileIcon` | `path`, `kind?: "file" \| "directory"`, `expanded?`, `size?` (14), `"aria-label"?`, `className?`, `id?`, `data-*` | The file tree's glyph for a name on its own: one per file category (source, config, data, image, lock, archive, …) in the tree's neutral, a folder (open when `expanded`) for a directory. Decorative unless named. |
| `FileLink` | `path`, `rootPath?`, `line?`, `children?`, `icon?` (true), `mono?`, `onClick?(event)`, `tabIndex?`, `className?`, `id?`, `data-*` | A path that opens in Daintree's file viewer, scrolled to `line` when given (shown as `:42`), with its `FileIcon` before it and `PathLabel`'s middle ellipsis: the directory gives way before the file name, and the whole path is in a tooltip when cut. `path` is relative to `rootPath` or absolute inside it, and is shown relative to the root either way, as the host's change lists show it (pass `mono` for their monospace names); the viewer holds every read to `rootPath` on the real path, so a symlink cannot lead out. A path that resolves outside `rootPath`, or no absolute `rootPath`, draws the same text with no link. `tabIndex={-1}` takes it out of the tab order for a list that owns the keyboard, and a press on it then leaves focus where it was. `onClick` runs first; `preventDefault()` there opens it yourself. |
| `GitStatusBadge` | `status: "modified" \| "added" \| "deleted" \| "untracked" \| "renamed" \| "copied" \| "ignored" \| "conflicted"`, `variant?: "letter" \| "label"`, `className?`, `id?`, `data-*` | The change list's marker: `M`, `A`, `D`, `?`, `R`, `C`, `I`, and `!` for a conflict, bold mono in the status ink (modified warning, added and untracked success, deleted and conflicted error, renamed and copied info). The letter is an image named with the word; `label` writes the word after it. An unknown status draws nothing. |
| `CommitRow` | `commit?: Commit`, `skeleton?`, `onActivate?(commit)`, `shaLength?` (7), `className?`, `id?`, `data-*` | One commit as the host's commit list draws it: the author's avatar, the subject (a button when `onActivate` is given, its full text in a tooltip when cut), up to two refs as mono chips (`head` emphasised, `tag`, `remote`, `branch`; the rest as "+N"), then "Not pushed" for `unpushed`, the author (email in a tooltip), a live age, `DiffStat`, and the short hash, which copies the full one. When the row is too narrow, the metadata after "Not pushed" drops out whole, with its separator, while the hash keeps its place. `skeleton` draws the row's loading shape. `Commit` is `{ sha, subject, author?: { name, avatarUrl?, email? }, date?, refs?: { name, kind? }[], additions?, deletions?, unpushed? }`. |
| `CommitList` | `commits: Commit[]`, `loading?: boolean \| number`, `onActivate?`, `shaLength?`, `empty?`, `"aria-label"?`, `className?` | `CommitRow`s in the order given (pass them newest first, as git logs them), with `loading` skeleton rows after them (three for `true`) and the list `aria-busy` while they show. The list is one Tab stop: Up and Down move to the same control in the next row, Left and Right between a row's subject and hash, Home and End to the first and last row. |
| `ForgeStateBadge` | `kind?: "issue" \| "pr"` (`pr`), `state: "open" \| "closed" \| "merged" \| "draft"`, `variant?: "glyph" \| "badge"`, `className?`, `id?`, `data-*` | The GitHub builtin's state glyphs, forge-neutral: an issue is a dot in a ring when open and a ticked ring when closed (any state but `open` draws closed for an issue); a pull request is the open, draft, merged or closed pull request glyph. Shape and colour (`pr-open`, `pr-draft`, `pr-merged`, `pr-closed`) both change, so neither carries the state alone. `glyph` is the 16px mark named "Draft pull request"; `badge` is an outline badge with the word. |
| `IssueRow` | `number`, `title`, `state: "open" \| "closed"`, `url?`, `onOpen?()`, `author?`, `assignees?`, `labels?: { name, color? }[]`, `maxLabels?` (1, from 1 to 20), `commentCount?`, `updatedAt?`, `timePrefix?`, `selected?`, `actions?`, `titleTabIndex?`, `className?`, `id?`, `data-*` | The forge list row: the state glyph, the title (a button that calls `onOpen`, else opens an http(s) `url` in the browser, else plain), and a rail of the first assignee's avatar (a "+N" before it for the rest, everyone named in its tooltip) and your `actions`; under it `#number`, the author, a live age, the comment count and the labels as the host's rows draw them: the first label's colour dot and name, "+N" for the rest, all named in a tooltip. The row is 64px with a 24px title line, the github row's geometry; the metadata line is one fixed line, and an item that does not fit (labels first, then the branch) drops out whole with its separator rather than being clipped mid-word; a cut author or branch reads in full in its tooltip. `selected` gives it the list's highlighted fill and puts `aria-current` on the title. Lay rows in a `VirtualList` or your own list; the row owns no keyboard model of its own: when your list owns the keyboard (a `useListNavigation` listbox, a grid with `aria-activedescendant`, as the github builtin's list does), pass `titleTabIndex={-1}` so the rows add no Tab stops, and a press on a title leaves focus where your list keeps it. |
| `PullRequestRow` | `IssueRow`'s props with `state: "open" \| "closed" \| "merged" \| "draft"`, plus `ci?: "success" \| "failure" \| "pending" \| "neutral"`, `mergeConflict?`, `review?: "approved" \| "changes_requested" \| "review_required"`, `headRef?`, `baseRef?` | While open or draft, the rail adds the checks: a tick, a cross or a pending dot, or the merge-conflict glyph, which takes the slot over any roll-up. "Approved" and "Changes requested" show beside the number; awaiting review is the resting state of nearly every pull request and does not. `headRef` is named "Merges head into base". Merged and closed pull requests keep neither. |
| `ChecksList` | `checks: CheckRun[]`, `title?`, `summary?` (true), `actions?`, `onOpenDetails?(check)`, `empty?`, `"aria-label"?`, `className?`, `id?`, `data-*` | The Review Hub's checks popover as a list: a summary line ("2 failing, 1 running, 12 passing, 1 skipped"), then the checks grouped by `workflow` under each group's own counts (no heading when every check is in one unnamed group; durations share one column), the group with the worst check first and failures leading within a group, required before optional. Each row has the host's glyph for its state (queued, running, passed, failed, timed out, cancelled, action required, skipped, neutral), its name, its outcome and requiredness, its duration (`durationMs`, else `finishedAt` less `startedAt`, else counted live from `startedAt` while it runs), and a details button: `onOpenDetails`, else its `detailsUrl` opened in the browser (only an ordinary http(s) URL; anything else gets no button). While any check needs a look, each workflow's clean results (passed, skipped, neutral) fold behind a "Show 4 passing" toggle, as the Review Hub's checks popover does. The list is one Tab stop: Up and Down move between the details buttons and toggles. Repeated names (matrix jobs) get "2 of 2" on their buttons. Names are sanitised. `CheckRun` is `{ id?, name, status, workflow?, required?, durationMs?, startedAt?, finishedAt?, detailsUrl? }`. |
| `DevServerStatus` | `status: "starting" \| "installing" \| "running" \| "crashed" \| "stopping" \| "stopped"`, `name?` ("Dev server"), `url?`, `port?`, `error?`, `target?`, `actions?`, `className?`, `id?`, `data-*` | A dev server on one line, as the worktree card's indicator draws it: a globe in the working ink while it runs, a spinner while it starts, installs or stops, the error glyph when it crashed and a ring when stopped, then its name and state in a polite status region, its address as a `PortLink` while it runs, and your `actions` (Restart, Stop) at the end. `error` shows under a crash, two lines at most. |
| `PortLink` | `url?` or `port?`, `target?: "panel" \| "external"` (`panel`), `copyable?` (true), `children?`, `className?`, `id?`, `data-*` | A local server's address, `localhost:5173/app`, as a mono link that opens a Daintree browser panel (or, with `external`, the system browser), and a copy button for the full URL. Only a loopback http(s) URL (`localhost`, `127.0.0.1`, `[::1]`) without credentials, or a port, links; anything else draws as text. |

### Workflows and agent work

Pieces for plugins that move records and agent output through review: attachments, references to your own records, repeated structured fields, form completion, outside connections, and the vocabulary of operations, tool calls, proposed changes, sources and decisions. All of them are presentational: what exists, who may change it, and whether a change took effect are your worker's to say. Nothing here authorises anything in Daintree itself.

| Export | Props | Notes |
| --- | --- | --- |
| `AttachmentChip` | `name`, `detail?`, `icon?` (`file`), `status?: "ready" \| "pending" \| "failed"`, `onOpen?()`, `onRemove?()`, `removeLabel?`, `disabled?`, `className?` | The chip the `Composer` draws. `onOpen` makes the name a button (not while `pending`); the X takes it off a draft, which is not deleting the thing itself. |
| `AttachmentList` | `attachments: Attachment[]` (`id`, `name`, `detail?`, `icon?`, `status?`), `layout?: "chips" \| "rows"`, `onOpen?(id)`, `onRemove?(id)`, `empty?`, `disabled?`, `"aria-label"?` ("Attachments"), `className?` | `rows` stacks them with the detail on the right ("Uploading" and "Failed" when there is none). Removing one moves focus to the next X, the one before, or the list. |
| `EntityChip` | `label`, `type?`, `icon?`, `avatar?: { src?, name }`, `availability?: "available" \| "loading" \| "missing" \| "forbidden"`, `onOpen?()`, `preview?`, `className?` | A reference to one of your records, read as "Customer, Acme Corp". A reference that is not `available` keeps its place and says why ("Deleted", "No access") rather than vanishing, and cannot be opened. `preview` is a `HoverCard` on hover and focus. |
| `RepeaterField<T>` | `items`, `getKey(item, i)`, `renderItem(item, { index, key, update, remove, error, disabled })`, `onChange(items)`, `createItem?()`, `duplicateItem?(item)`, `getItemLabel?(item, i)`, `addLabel?` ("Add item"), `min?`, `max?`, `reorderable?`, `errors?: Record<key, ReactNode>`, `empty?`, `disabled?`, `"aria-label"`, `className?` | A list of structured items (line items, contact methods, rules) edited in place. You draw each item's fields; it adds, removes, duplicates and, with `reorderable`, reorders through `SortableList`. Errors and focus follow keys, never positions: an insertion above an item never moves its error onto a neighbour. Add focuses the new item's first field; Remove focuses the neighbour's Remove (or its field, or Add, or the group). `disabled` reaches `renderItem` and stops `update`. `ListEditor` stays the field for a list of strings. |
| `FormErrorSummary` | `errors: { field?, message }[]`, `title?` ("Fix these to continue"), `onSelect?(field)`, `autoFocus?`, `className?` | Every problem with a form in one error `Callout`, each linked to its control by id. `onSelect` runs first so a closed section can open; focus follows a frame later. Errors with no field come first, as text. Nothing renders without errors. |
| `UnsavedChangesBar` | `changes`, `onSave()`, `onDiscard()`, `saving?`, `error?`, `saveLabel?`, `discardLabel?`, `message?`, `className?` | "3 unsaved changes" with Discard and Save. A promise from `onSave` holds Save loading until it settles; a rejection stays on the bar with the edits untouched, until the next save, Discard, or `changes` reaching zero. Gone when nothing is unsaved and no save is out. |
| `ConnectionCard` | `name`, `icon?` (`plug`), `account?`, `status: "connected" \| "connecting" \| "disconnected" \| "expired" \| "limited" \| "error"`, `detail?`, `checkedAt?`, `actions?`, `className?` | One outside service: who, which account, whether it works and when that was checked. A working connection stands neutral; `expired` and `limited` take the warning glyph. It shows what your worker reports and never holds a credential. |
| `OperationStatus` | `state`, `label?`, `detail?`, `compact?`, `className?` | Where a piece of work stands, beyond a task's states: `queued`, `running`, `waiting-input`, `awaiting-approval`, `cancelling`, `partial`, `done`, `failed`, `cancelled`, `unknown`. Work held on the user takes the agent waiting ring; `partial` the warning glyph; `unknown` (it may or may not have taken effect) asks for a check, not a retry. `compact` is the glyph alone, worded for assistive tech and its tooltip. |
| `ToolCallCard` | `name`, `summary?`, `state`, `input?`, `result?`, `error?`, `startedAt?`, `finishedAt?`, `open?`, `defaultOpen?`, `onOpenChange?(open)`, `className?` | One tool call as a compact row (state, name, purpose, duration) that opens on its input and result in an `ObjectInspector` (a string is shown as text, an element as is). Strip secrets before passing values. |
| `StructuredDiff` | `changes: FieldChange[]` (`id`, `label`, `kind?: "added" \| "changed" \| "removed"`, `before?`, `after?`, `note?`, `error?`), `selected?`, `onSelectedChange?(ids)`, `title?`, `empty?` ("No changes"), `disabled?`, `className?` | Proposed field changes as a table of field, before and after. With `onSelectedChange` each takes a checkbox and the header one for all, so a reviewer applies some and leaves the rest; a change with an `error` cannot be chosen. Applying is yours: check the record has not moved on first. |
| `SuggestedValue` | `label?`, `current?`, `suggested`, `reason?`, `source?`, `onAccept()`, `onReject()`, `onEdit?()`, `stale?`, `disabled?`, `className?` | One proposed value beside the current one. `stale` marks a suggestion made from data that has since changed: it can be rejected, not accepted. |
| `SourceCitation` | `index`, `title`, `locator?`, `onOpen?()`, `preview?`, `className?` | An inline numbered marker, read as "Source 2: Pricing page, p. 3". `preview` is a `HoverCard`; without it the title is the tooltip. Cite only sources your integration supplied, never a link a model merely mentioned. |
| `SourceList` | `sources: { id, title, locator?, excerpt?, icon? }[]`, `onOpen?(id)`, `"aria-label"?` ("Sources"), `className?` | The numbered sources behind an answer, in citation order, each with the passage relied on. |
| `DecisionRequest` | `title`, `description?`, `consequence?`, `children?`, `choices: { id, label, variant?: "default" \| "secondary" \| "destructive" }[]`, `onRespond(id)`, `status?: "pending" \| "answered" \| "expired" \| "cancelled" \| "superseded"`, `answer?`, `className?` | A question a run is waiting on. Choices are secondary unless marked `default` (the one accent answer). A promise from `onRespond` holds the answers until it settles, so one press is one answer; a rejection says why and offers them again. Anything but `pending` takes the answers away and announces what happened, keeping focus in the card; a change of `status` drops whatever was in flight. Give each request its own `key`. |

### Icons

`Icon` draws one of Daintree's own icons by name: `name`, `size?` (16 px; inside a kit `Button` the button sizes it), `className?`, `"aria-label"?` (omitted, the icon is decorative and `aria-hidden`). An unknown name renders nothing, with a warning in development, rather than throwing. The set only grows. The names are Lucide-style kebab-case, plus two Daintree concepts, `worktree` (a git worktree) and `daintree` (the app's mark):

`activity`, `alert-octagon`, `alert-triangle`, `arrow-down`, `arrow-left`, `arrow-right`, `arrow-up`, `arrow-up-right`, `at-sign`, `bell`, `bell-dot`, `book-open`, `bookmark`, `bot`, `braces`, `bug`, `calendar`, `chart-column`, `chart-line`, `chart-pie`, `check`, `check-square`, `chevron-down`, `chevron-left`, `chevron-right`, `chevron-up`, `chevrons-up-down`, `circle-check`, `circle-dashed`, `circle-dot`, `circle-slash`, `circle-x`, `clipboard`, `clock`, `cloud`, `cloud-off`, `code`, `copy`, `daintree`, `database`, `download`, `external-link`, `eye`, `eye-off`, `file`, `file-code`, `file-diff`, `file-plus`, `file-text`, `file-warning`, `filter`, `flame`, `flask`, `folder`, `folder-code`, `folder-open`, `folder-search`, `folder-tree`, `folder-x`, `gauge`, `git-branch`, `git-branch-plus`, `git-commit`, `git-compare`, `git-fork`, `git-merge`, `git-merge-conflict`, `git-pull-request`, `git-pull-request-closed`, `git-pull-request-draft`, `globe`, `grip-vertical`, `hash`, `help`, `history`, `home`, `hourglass`, `image`, `import`, `inbox`, `info`, `key`, `layers`, `layout-grid`, `layout-panel-top`, `lightbulb`, `link`, `list`, `list-checks`, `list-todo`, `loader`, `lock`, `mail`, `maximize`, `menu`, `message-square`, `minimize`, `minus`, `monitor`, `monitor-play`, `more-horizontal`, `more-vertical`, `mouse-pointer`, `notebook`, `package`, `panel-left`, `panel-right`, `panel-right-close`, `panel-right-open`, `paperclip`, `pause`, `pencil`, `pin`, `pin-off`, `play`, `plug`, `plus`, `puzzle`, `redo`, `refresh`, `rocket`, `rotate-ccw`, `rotate-cw`, `save`, `search`, `send`, `server`, `settings`, `share`, `shield`, `sliders`, `sort`, `sparkles`, `square`, `square-dashed-mouse-pointer`, `star`, `sticky-note`, `table`, `tag`, `target`, `terminal`, `trash`, `undo`, `unlink`, `unlock`, `unplug`, `upload`, `user`, `user-plus`, `users`, `wifi-off`, `workflow`, `worktree`, `wrench`, `x`, `zap`.

`PluginIconName` in `shared/types/plugin-sdk-react.ts` is the authoritative list. For a glyph that is not in it, pass your own `<svg>` element to a prop that takes a `PluginIconSource`. Importing `lucide-react` bundles it into the view, which `daintree-plugin lint` flags.

## Hooks

Behaviour a view needs over and over, as plain React hooks. Their options are read the way the components' props are: a field of the wrong type is ignored, and a missing options object means the defaults.

| Export | Returns | Notes |
| --- | --- | --- |
| `useSelection({ ids, mode?, selected?, defaultSelected?, onSelectedChange?, isDisabled? })` | `{ selected, count, anchor, allSelected, isSelected(id), toggle(id), select(id \| ids), selectRange(id, { additive? }), selectAll(), clear(), handleSelect(id, gesture?), handleNavigate(id, gesture?), getItemProps(id) }` | Single (`mode: "single"`) or multi selection keyed by row id, in the order of `ids`. `handleSelect` reads a click or key the platform way: plain replaces the selection, Cmd (Ctrl elsewhere) or Space toggles, Shift selects from the anchor and Shift with Cmd/Ctrl adds the range. A second Shift-click replaces the last range and keeps rows Cmd-clicked before it. `selected` holds only ids in `ids`, so a row a filter hides drops out until it is back. `getItemProps(id)` is `aria-selected` and a click handler for a row you draw yourself. |
| `useHotkeys(hotkeys, { scope?, enabled? })` | — | `hotkeys` is `{ combo, handler(event), allowInInput?, disabled? }[]`, `combo` in the app's notation (`"Delete"`, `"Cmd+A"`, `"Cmd+Shift+Z"`, as `KbdChord` draws it): `Cmd` is Command on macOS and Ctrl elsewhere, `Ctrl` the Control key everywhere, `Alt` Option. Keys work while focus is in your view, or in `scope` (a ref) when given; keys typed into a text field are left alone unless `allowInInput`. Daintree's own shortcuts always win: they run first, and a key that any host binding in the app's current scope is on is skipped here too, even when that binding's own conditions (`when`) are false, rather than risk shadowing it. Development builds warn about a combo the host binds in any scope. Until the kit has loaded (normally before the view's first frame), no binding fires. Keys pressed in an overlay the view opened (a kit `Dialog`, `Popover` or menu) count as the view's. The default is prevented unless the handler returns `false`. |
| `useUndoRedo(initial, { limit?, coalesceMs? })` | `{ value, push(next \| (current) => next, { coalesce? }), undo(), redo(), canUndo, canRedo, reset(value?) }` | A value with an undo history, `limit` (100) steps deep. Pushes sharing a `coalesce` key within `coalesceMs` (1000) make one step, so typing a word is one undo. `undo` and `redo` return the value they land on, for handing straight to the worker. |
| `useDisclosure({ open?, defaultOpen?, onOpenChange? })` | `{ open, onOpen, onClose, onToggle, onOpenChange }` | Open state for a popover, dialog or section, controlled or not; spread `{ open, onOpenChange }` onto a kit overlay. |
| `useDebouncedValue(value, delayMs?)` | the settled value | `value` once it has stopped changing for `delayMs` (300): a search field's text, so filtering waits for a pause. |
| `useDebouncedCallback(callback, delayMs?, { leading?, maxWait? })` | the debounced function, with `cancel()`, `flush()`, `isPending()` | Runs once calls stop, with the last arguments. `leading` also runs the first call of a burst; `maxWait` caps how long a steady stream holds it back. Dropped on unmount. |
| `usePersistentViewState(key, initial)` | `[value, setValue]` | `useState` that the view remembers — a tab, a split size, a filter — across unmounts, reloads and restarts, stored on the panel through the host's `persistState` (see [Views](./views.md)). Values must be JSON; a value that is not lasts until the view unmounts. A restored value whose type differs from `initial`'s (a string where a number is now expected, an array where an object was) is ignored; the check is by type, not a deep shape, so migrate a changed object yourself. Once set, any value of the declared type is kept, `null` included. Where the host keeps no panel record (a settings view) the value lasts until the view unmounts. |
| `useToast()` | `{ show({ message, tone?, durationMs?, action? }), showUndo({ message, onUndo }) }`, each returning `{ dismiss() }` | Toasts in the app's own toaster, from the view. `tone` is `info` (default), `success`, `warning` or `error`. The message carries your plugin's name, as the worker's `host.showToast` does, and the same bounds hold, applied rather than rejected: a message past 2000 characters is cut, a `durationMs` past a minute is a minute, an unknown `tone` is `info`, and a per-plugin rate limit sends a burst to the notification inbox. Unlike the worker, a view can put one `action` button on it; a toast with an action stays up until it is answered unless you pass `durationMs`. `showUndo` is the app's Undo toast ("3 snippets deleted · Undo") with the app's one 5-second Undo window, which a plugin cannot change, and a plugin has one up at a time: a new one replaces the last. Callbacks can run after the component that showed the toast has unmounted, so act on state that outlives it. |

`useSelection` and `useListNavigation` make a keyboard multi-select list together: the navigation owns the cursor, the selection owns what is chosen.

```js
const ids = snippets.map((s) => s.id);
const selection = useSelection({ ids });
const nav = useListNavigation({
  count: ids.length,
  getLabel: (i) => snippets[i].title,
  onSelect: (i, event) => selection.handleSelect(ids[i], event),
  onActiveIndexChange: (i, event) => selection.handleNavigate(ids[i], event),
  hasRowMenus: true, // each row sits in a ContextMenu
});
useHotkeys([
  { combo: "Cmd+A", handler: () => selection.selectAll() },
  { combo: "Delete", handler: () => removeSelected(), disabled: selection.count === 0 },
]);
// An Undo toast should restore its own change, not whatever the history head is by then:
// toast.showUndo({ message: "3 snippets deleted", onUndo: () => restore(removedRows) });
// <VirtualList {...nav.containerProps} aria-multiselectable …> with each row
// <ListRow {...nav.getRowProps(i)} aria-selected={selection.isSelected(id)} active={i === nav.activeIndex}
//   checked={selection.isSelected(id)} selecting={selection.count > 0} onToggle={() => selection.toggle(id)} …>
```

## Theme

For styling DOM, use the theme's utility classes and CSS variables (`bg-surface-panel`, `text-text-secondary`, `var(--theme-border-default)`); they follow the theme with no re-render, and [Views](./views.md) lists the vocabulary. The theme readers are for code that cannot use CSS — a canvas, WebGL, a chart library that takes colours as values:

| Export | Behaviour |
| --- | --- |
| `useDaintreeTheme()` | The active theme; re-renders the component when it changes. |
| `getDaintreeTheme()` | The same, outside React. Cheap to call often: tokens are resolved once per theme change and the same frozen object returns until the next one. |
| `onDidChangeDaintreeTheme(listener)` | Calls `listener(theme)` after every theme change. Returns a function that stops it. |

Each returns `{ colorMode, themeId, tokens }`, with `colorMode` either `"dark"` or `"light"`. `themeId` is a built-in id such as `"daintree"` or a custom theme's id. `tokens` maps each key to a concrete sRGB colour — `#rrggbb` when opaque, `rgba(r, g, b, a)` when not — that parses anywhere, including WebGL; a value the theme uses `oklch()` or `color-mix()` for is resolved first. A key the document does not define reads as `""`, so give extended tokens a fallback: `theme.tokens["syntax-keyword"] || "#c678dd"`. The object is replaced on a change, never mutated.

| Group | Tier | Keys |
| --- | --- | --- |
| Surfaces | Core | `surface-{grid,sidebar,canvas,panel,panel-elevated,input,inset,hover,active}` |
| Text | Core | `text-{primary,secondary,muted,placeholder,inverse,link}` |
| Borders | Core | `border-{default,subtle,strong,divider,interactive}` |
| Accent | Core | `accent-{primary,foreground,hover,soft,muted}`, `focus-ring` |
| Status | Core | `status-{success,warning,danger,info}` |
| Agent activity | Extended | `activity-{active,idle,working,waiting}` |
| Terminal | Extended | `terminal-{background,foreground,muted,cursor,selection}`, and the ANSI colours `terminal-{black,red,green,yellow,blue,magenta,cyan,white}` with their `terminal-bright-*` pairs |
| Syntax | Extended | `syntax-{comment,punctuation,number,string,operator,keyword,function,link,quote}` |
| Categories | Extended | `category-{blue,purple,cyan,green,amber,orange,teal,indigo,rose,pink,violet,slate}`, a 12-hue ramp for charts and tags |

## Formatters

The same formatting Daintree's own surfaces use, so a plugin's times and sizes read like the app's:

| Export | Output |
| --- | --- |
| `formatTimeAgo(value, now?)` | "just now", "5m ago", "11d ago", then the date past 30 days |
| `formatRelativeTime(value, now?)` | "5 minutes ago", "in 3 hours", then the date past 30 days |
| `formatBytes(bytes)` | 1024 steps: "0 B", "1.5 KB", "3 MB" |
| `formatCount(count)` | Exact below 1,000, then "1.2k", "23k", "1.2M"; truncates, never rounds up |
| `formatDuration(ms)` | "45s", "12m", "3h 5m", "2d 4h" |
| `formatIsoDate(day, style?)` | A `"YYYY-MM-DD"` day as the date fields show it: "Sep 30, 2026" (`short`, the default), "September 30, 2026" (`long`), "Wednesday, September 30, 2026" (`full`); "Unknown" for a day that does not exist |
| `isoToday(now?)` | The user's wall-clock day, "2026-09-30" |
| `isoFromDate(date)` | The local day a `Date` or epoch ms falls on, or `null` for an invalid date |
| `isoAddDays(day, days)` | The day `days` away, negative for earlier, never shifted by a clock change; `null` when `day` is not a real date |

The `iso*` helpers produce the `"YYYY-MM-DD"` strings `Calendar`, `DatePicker` and `DateRangePicker` take and report, so a "last 30 days" preset is `{ start: isoAddDays(isoToday(), -29), end: isoToday() }` with no date arithmetic of your own. A day is a calendar day, not an instant: never build one from `toISOString()`, which names the UTC day and is a day out in the evening west of Greenwich.

For the time formatters, `value` is a timestamp in milliseconds, an ISO string or a `Date`. For an age on its own, `TimeAgo` does all of this for you. Otherwise pair the relative formatters with `useNow()` from `@daintreehq/plugin-sdk/react`, so every time on screen turns over together on one shared timer. `formatTimeAgo` is minute-grained ("just now" for the first 60 seconds), so a once-a-minute `useNow()` is all it needs. For a time that ticks by the second ("12s ago", a running timer), use `useNow({ intervalMs: 1000 })` with `formatDuration(now - startedAt)`, which reads "12s" under a minute and "3m" after.

## Builtins draw through the kit

Daintree's built-in plugins (GitHub, GitLab, the Markdown editor, the SvelteKit site builder) render through this same public kit rather than importing the host's internal components, so every gap a third-party plugin would hit shows up in a first-party one first, and the kit is what gets fixed. An ESLint rule in `eslint.config.js` enforces it: in `plugins/builtin/*/renderer/**`, importing any host UI export the kit covers — `Button`, `Select`, `Dialog`, `Popover`, the settings rows and the rest, listed export by export — is an error with "Use the equivalent from @daintreehq/plugin-ui."

A builtin that still needs a covered export gets an exception scoped to one file and exactly those export names, and the block's `name` records the kit gap that forces it (a `Popover` with no anchor, a `Select` whose options cannot carry item markup, and so on). A contract test (`src/components/ui/__tests__/bundledPluginPrimitives.contract.test.ts`) reads those blocks and fails any exception the file no longer uses, so an exception disappears the moment the kit closes its gap. Tests and preview harnesses are exempt; they are not the plugin's runtime.

## Checking a view against the kit

`daintree-plugin lint` points at hand-rolled versions of kit controls — `raw-button`, `raw-form-control` (a password field points at `SecretInput`), `native-title-tooltip`, `inline-svg-icon`, `lucide-react-import`, `dnd-library-import`, `hand-rolled-context-drag`, `editor-library-import`, `data-view-library-import`, `ansi-library-import`, `hand-rolled-spinner`, `hand-rolled-badge`, `hand-rolled-drawer` (→ `Drawer`), `hand-rolled-forge-state` (→ `ForgeStateBadge`, `IssueRow`, `PullRequestRow`), `native-dialog-in-view`, `raw-portal`, `view-web-storage`, `global-key-listener`, and `viewport-breakpoint` and `self-container-query` (→ a container query, `AutoGrid` or `useBreakpoint`) — at styling off the design contract (`stock-palette-colour`, `dark-variant`, `legacy-daintree-utility`, `raw-shadow`, `arbitrary-text-size`, `text-colour-slash-alpha`, `raw-radius`, `unpaired-outline-suppression`, `apply-directive`), and at classes that compile to nothing against it. The `lint` command: Not in the 0.1.0 release on npm; it ships in the next one. The Styles tab in Settings → Plugins runs the same class check against a running view. See [Development loop → Lint](./dev-loop.md#daintree-plugin-lint-dir).
