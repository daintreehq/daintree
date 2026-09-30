# UI kit — `@daintreehq/plugin-ui`

`@daintreehq/plugin-ui` is Daintree's own controls, served to plugin views through the host import map and themed with the app: the same buttons, fields, menus, dialogs, lists and pane chrome Daintree draws itself. A view that uses it looks and behaves like the rest of the app, follows the user's theme without a re-render, and pays nothing in bundle size.

There is no package behind the specifier. The implementation exists only inside the running app (compiled from `src/pluginUi`), `@daintreehq/plugin-vite` keeps the import external, and a raw `plugin://` view imports it directly. Types come from the SDK: add `"@daintreehq/plugin-sdk/plugin-ui"` to `compilerOptions.types` (the scaffold's tsconfig already does), or put `/// <reference types="@daintreehq/plugin-sdk/plugin-ui" />` in one file. `packages/plugin-sdk/plugin-ui.d.ts` declares the module; the prop interfaces live in `shared/types/plugin-sdk-react.ts` and are re-exported from `@daintreehq/plugin-sdk/react` as `Plugin*Props`. Those two files are the contract; this page is the readable form of them.

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

Kit components are lazy. The facade that the import map serves is small, and the host adapters behind it load as one chunk, requested the moment a view imports the kit. Until that chunk is in, a component renders nothing — except `Tooltip` and `TruncatedTooltip`, which render their child, and `Popover`, which renders its trigger — so the first time a view renders it, a control could paint a frame late.

The host's view load path closes that gap for panel views: it starts loading the kit alongside the plugin's activation and waits for it together with the view's styles, so once the kit has loaded, a view's first committed frame already has every kit control in it; a kit that fails to load is left to each control's own boundary rather than failing the view (see [Architecture → The plugin view load path](./architecture.md#the-plugin-view-load-path)). Two exports cover everything else:

| Export | Behaviour |
| --- | --- |
| `whenPluginUiReady(): Promise<void>` | Resolves once every component renders on its first frame with no placeholder. Await it in tests and in code that measures kit output or must not paint late. Rejects when the chunk fails to load; calling it again retries. |
| `preloadPluginUi(): void` | Starts loading without waiting. Every call shares one request. Call it when a view is about to open outside the host's load path. |

`Markdown` loads its renderer separately, on its first render, and is not covered by `whenPluginUiReady`.

## Overlays, portals and layers

Tooltip bodies, menus, select lists, popovers and dialogs open in host overlays that portal to the document body, outside the view's style root. Two consequences:

- **The overlay's own chrome takes no `className`.** Those props do not exist on `DropdownMenu`, `Dialog`, `ConfirmDialog`, `Popover`, `Tooltip` or `Select`'s list: the chrome is the host's. `Select`'s `className` styles its trigger only.
- **What you put inside an overlay is still yours.** Content you pass into a tooltip, popover or dialog body is re-marked as a plugin style root and tagged with your plugin, so your view's Tailwind classes apply there too and diagnostics (the Styles check, long-frame attribution) know whose it is. A portal you open yourself with `createPortal` must mark its container with the `PLUGIN_STYLE_ROOT_ATTRIBUTE` attribute from `@daintreehq/plugin-sdk`, or your classes will not reach it ([Views](./views.md)).

Overlays stack at the popover tier. A dialog opened from inside another modal surface — Settings, another dialog — passes `layer="nested"`, and kit overlays opened inside that dialog lift themselves above it.

Menus and popovers are rendered through React portals, so React events still bubble to the trigger's ancestors: a menu on a clickable row would also click the row. `DropdownMenu`'s `stopPropagation` stops that.

## Shared vocabulary

**Status.** `Badge`'s `tone`, `Callout`'s `severity` and `SeverityIcon` share one vocabulary: `error`, `danger`, `warning`, `success`, `info`, `neutral`. `error` and `danger` are the same colour (the `status-error` class aliases the `status-danger` theme token); a `Badge` draws them identically, while a `Callout` gives `danger` — a destructive caution — its own octagon glyph. `outline` is a Badge-only, uncoloured shape. Error banners are `Callout severity="error"` with a Retry `action`; a pane that failed as a whole is `PaneState kind="error"`. There is no separate banner component.

**DOM props.** Every control that renders in the view (not in an overlay) forwards `PluginDomProps` to its root: `id`, `title`, `tabIndex`, `role`, `style`, any `aria-*` or `data-*` attribute, DOM event handlers, and `ref`. That is also what lets a kit control be a `DropdownMenu` or `Popover` `trigger`, or a `Tooltip` child. Tables below mark these components "DOM props". Every other component that renders in the view still forwards an `id` and any `data-*` attribute (`data-testid`, say) to its root, so a test can find it without a wrapper `div`; `SegmentedControl`, `CopyButton`, `DismissButton`, `Toolbar`, `ToolbarButton`, `ProgressBar`, `LogView` and `FileTree`, whose root is the control itself, take `aria-*` too. Where the component sets an attribute itself (its name, its role, its state), its own value wins. The types are `PluginRootAttributes` and `PluginAriaRootAttributes` in `@daintreehq/plugin-sdk/react`.

**Icons.** Most props that take an icon take a `PluginIconSource`: an icon name, or your own element (an inline `<svg>`); a string is always read as a name, never as text. A few take a name only (`PluginIconName`): `Select` options, `Callout`'s `icon`, `DropdownMenu` items, `Tabs` items and `SpinningIcon`. Sides are `"top" | "right" | "bottom" | "left"`; alignments `"start" | "center" | "end"`.

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

`DropdownMenu` entries (`PluginDropdownMenuEntry`):

| `type` | Fields |
| --- | --- |
| `"item"` (or omitted) | `label`, `onSelect`, `icon?`, `shortcut?` (a canonical combo such as `"Cmd+Enter"`, drawn in the key column), `disabled?`, `destructive?` |
| `"checkbox"` | `label`, `checked`, `onCheckedChange`, `disabled?` |
| `"radio-group"` | `value`, `onValueChange`, `items: { value, label, disabled? }[]` (values non-empty and unique), `label?` heading |
| `"label"` | `label` |
| `"separator"` | — |

### Form controls

| Export | Props | Notes |
| --- | --- | --- |
| `Input` | `type?: "text" \| "search" \| "email" \| "url" \| "password" \| "number" \| "tel" \| "date" \| "time" \| "datetime-local"`, `value?`, `defaultValue?`, `onValueChange?(value)`, `placeholder?`, `name?`, `disabled?`, `readOnly?`, `required?`, `autoFocus?`, `autoComplete?`, `spellCheck?`, `maxLength?`, `min?`, `max?`, `step?`, `invalid?`, `density?: "default" \| "compact"`, `className?`; DOM props | Single-line field. `date`, `time` and `datetime-local` use the platform picker in the theme's light or dark scheme, with ISO values (`"2026-09-30"`, `"14:05"`, `"2026-09-30T14:05"`). `onValueChange` fires beside the native `onChange`. |
| `Textarea` | `value?`, `defaultValue?`, `onValueChange?`, `placeholder?`, `name?`, `rows?`, `disabled?`, `readOnly?`, `required?`, `autoFocus?`, `spellCheck?`, `maxLength?`, `invalid?`, `density?`, `variant?: "default" \| "code"`, `resize?: "vertical" \| "none"`, `className?`; DOM props | `code` for paths, prompts and JSON. |
| `Select` | `options: (SelectOption \| SelectOptionGroup)[]`, `value?: string \| null`, `defaultValue?`, `onValueChange?`, `placeholder?`, `disabled?`, `density?`, `name?`, `id?`, `"aria-label"?`, `"aria-labelledby"?`, `"aria-describedby"?`, `className?` (trigger) | Options are `{ value, label, description?, icon?, disabled? }`, values non-empty and unique; a group is `{ label, options }`. Passing `value` at all makes it controlled, and `""`, `null` or `undefined` then shows the placeholder again (a form reset); leave it out for an uncontrolled Select. `compact` is 28 px. |
| `SegmentedControl` | `options: { value, label, disabled?, "aria-label"?, tooltip? }[]`, `value`, `onValueChange`, `"aria-label"`, `"aria-describedby"?`, `disabled?`, `fullWidth?`, `density?`, `className?` | Exactly one of a few options, with radio-group keyboard behaviour. `compact` is 24 px, for a 32 px toolbar strip. |
| `Checkbox` | `checked?: boolean \| "indeterminate"`, `defaultChecked?`, `onCheckedChange?(checked)`, `disabled?`, `invalid?`, `required?`, `name?`, `value?`, `size?: "sm" \| "md"`, `className?`; DOM props | Pair with `<label htmlFor>` or an `aria-label`. An indeterminate box resolves to `true`. |
| `Switch` | `checked?`, `defaultChecked?`, `onCheckedChange?`, `disabled?`, `name?`, `size?` (deprecated, ignored), `className?`; DOM props | An instant on/off setting, neutral (never accent) when on. In a form with a Save, use `Checkbox`. |
| `SearchField` | `value`, `onValueChange?`, `onClear?`, `placeholder?`, `"aria-label"?`, `clearLabel?`, `size?: "compact" \| "dense" \| "palette"`, `autoFocus?`, `disabled?`, `invalid?`, `className?`; DOM props | Controlled only. `onClear` shows the clear button while there is text and makes Escape clear first. Sizes are 28 (default), 24 and 38 px. |
| `FilterChip` | `children?`, `selected?`, `defaultSelected?`, `onSelectedChange?(selected)`, `count?`, `onRemove?()`, `removeLabel?`, `disabled?`, `className?`; DOM props except `aria-pressed` | One value in a filter bar above a list or table: Daintree's own filter pill, never accent, since several can be on at once. A toggle chip is pressed while its filter is on; controlled with `selected`, uncontrolled with `defaultSelected`. `count` shows "(3)", and `0` on an unselected chip drops it to a quiet edge without disabling it. With `onRemove` it is an applied filter ("Status: Open"): always pressed, drawn with a ×, and removed by a click, Backspace or Delete, with `removeLabel` ("Remove filter") as its tooltip; it shows no count. |
| `FormField` | `label`, `description?`, `error?`, `required?`, `htmlFor?`, `orientation?: "vertical" \| "horizontal"`, `disabled?`, `children: ReactNode \| ((control) => ReactNode)`, `className?` | Wires label, description and error to the control for assistive tech. Kit `Input`, `Textarea`, `Select`, `Checkbox` and `Switch` join on their own; for your own control, pass a function and spread the `{ id, "aria-labelledby"?, "aria-describedby"?, "aria-invalid"? }` it receives. `horizontal` puts a checkbox or switch before its label and makes the row clickable; a switch is centred on the label's first line. |
| `FormFieldGroup` | `label`, `description?`, `error?`, `required?`, `disabled?`, `layout?: "stack" \| "inline"`, `children?`, `className?` | One label over a set of controls that answer it together, such as a row of checkboxes, each its own horizontal `FormField`. The label is a `FormField` label's size and tone, so the group reads as one more field. A `fieldset` named by its label: `disabled` disables every control inside. `inline` wraps the controls in a row; `stack` (the default) puts one per line. |

### Status and feedback

| Export | Props | Notes |
| --- | --- | --- |
| `Badge` | `children?`, `tone?: "neutral" \| "outline" \| "error" \| "danger" \| "warning" \| "success" \| "info"`, `size?: "xs" \| "sm" \| "md"`, `shape?: "default" \| "pill"`, `className?`; DOM props | Presentation only; wrap it in a `Button` to make it clickable. |
| `Callout` | `severity`, `children?`, `title?`, `action?`, `actionPlacement?: "inline" \| "below"`, `onDismiss?`, `dismissLabel?`, `variant?: "box" \| "strip"`, `icon?`, `size?: "default" \| "compact"`, `className?`; DOM props except `title` | An inline message whose glyph and tint follow `severity`. `strip` is the full-width band across the top of a pane or popover: `title` is its headline and `children` one line under it; a strip never stands green (`success` draws neutral with the check glyph) and forwards only `role`, `aria-live` and `data-testid`. `icon` replaces the info mark on `neutral` only. `role="alert"` or `role="status"` reaches the root for a message that should be announced. |
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
| `AvatarGroup` | `avatars: { name, src?, shape? }[]`, `max?` (4), `size?: "xs" \| "sm" \| "md" \| "lg"`, `"aria-label"?`, `className?` | Overlapping `Avatar`s for the people on something, each with its name as a tooltip, cut out from each other with the pane's canvas colour. Past `max` the rest fold into a "+N" that takes focus and lists them in its tooltip (ten names, then a count). `aria-label` ("Reviewers") makes it a named group. |
| `HighlightedText` | `text`, `query?`, `ranges?: [start, end][]`, `className?` | Text with its search matches on a neutral band, the host's search highlight: never accent and never bold, so a row does not reflow as the user types. `query` marks the first case-insensitive occurrence, which is what a substring filter tested; `ranges` are inclusive offsets you computed (fuse.js `indices` as they come), merged where they touch. |

### Overlays

| Export | Props | Notes |
| --- | --- | --- |
| `Dialog` | `open`, `onClose`, `title`, `icon?`, `description?`, `children?`, `size?: "sm" \| "md" \| "lg"`, `primaryAction?`, `secondaryAction?`, `hint?`, `footer?`, `dismissible?` (true), `layer?: "default" \| "nested"`, `"data-testid"?` | A modal with a title bar, scrolling body and footer. Actions are `{ label, onClick, disabled?, disabledReason?, loading?, intent?: "default" \| "destructive", icon? }`; a disabled action stays focusable and announced unavailable, and a disabled primary's `disabledReason` shows as the footer hint when the dialog has none. `footer` replaces the two actions with your own right-aligned kit `Button`s, the primary last and `contrast`. `dismissible={false}` blocks Escape, the backdrop and the close button. `icon` takes a name or your own element. |
| `ConfirmDialog` | `open`, `onClose`, `onConfirm: () => void \| Promise<void>`, `title`, `description?`, `children?`, `confirmLabel`, `cancelLabel?`, `variant?: "default" \| "destructive" \| "info"`, `icon?`, `loading?`, `confirmDisabled?`, `typedNameTarget?`, `hint?`, `layer?` | The one confirm-or-cancel shape. `confirmLabel` is a verb-noun ("Delete branch"), never "OK". `loading` puts a spinner on the confirm and locks the dialog. On a `destructive` dialog, `typedNameTarget` makes the user type that exact text to enable the confirm. |
| `Popover` | `trigger: ReactElement`, `children?`, `side?`, `align?`, `open?`, `defaultOpen?`, `onOpenChange?`, `width?: "sm" \| "md" \| "lg" \| "trigger" \| "auto"`, `padding?: "default" \| "none"`, `"aria-label"?`, `onCloseAutoFocus?` | A floating panel for a filter, picker or detail card. Focus moves in on open and back to the trigger on close; Escape and an outside click close it. Widths are 14, 18 (default) and 24 rem, the trigger's width, or the content's. The trigger shows while the kit loads. |
| `PopoverSearchField` | `value`, `onValueChange?`, `onClear?`, `placeholder?`, `"aria-label"?`, `clearLabel?`, `autoFocus?`, `disabled?`; DOM props | The full-width search strip at the top of a filtering `Popover` with `padding="none"`. Controlled only. Anywhere else, use `SearchField`. |

### Lists and tables

| Export | Props | Notes |
| --- | --- | --- |
| `VirtualList<T>` | `items?` or `count?`, `renderItem(index, item)`, `itemKey?(index, item)`, `estimatedItemSize?` (28), `overscan?` (8), `onEndReached?(lastIndex)`, `activeIndex?`, `shadows?`, `"aria-label"`, `className?`; DOM props | Mounts only the rows in view, so ten thousand items cost what forty do. It fills its container's height, so give the container one. Without `itemKey` rows key by index and remount when the list reorders. DOM props land on the element that holds the rows, except `style` and `ref`, which the virtualiser owns there; spread `useListNavigation().containerProps` for a keyboard listbox, and the DOM props then land on its scroller (the size of the viewport), which takes focus, rather than the row element. Either way your `id` and `data-*` (`data-testid` included) are on the element with the role and name, never overwritten by the virtualiser's own. Without a `role` it is a plain list. `shadows` adds `ScrollShadow`'s edge fades. |
| `DataTable<T>` | `columns`, `rows`, `rowKey: ((row, index) => string \| number) \| string`, `sort?: { columnId, direction: "asc" \| "desc" } \| null`, `onSortChange?`, `onRowClick?(row, index)`, `selectedRowKey?`, `empty?`, `estimatedRowSize?` (28), `onEndReached?`, `"aria-label"`, `className?` | A sticky header over an always-virtualised body that fills its container. Columns are `{ id, header, width?, align?, sortable?, grow?, render?(row, index) }`; without `render` a cell shows `row[id]` when that is a string or number. Columns without a `width` share what the sized ones leave, up to 480 px each; the space beyond that stays at the trailing edge rather than stretching one column across the pane, and a table of sized columns keeps exactly the widths it asked for. `grow` gives one column everything left, for a message or a path that should run to the edge. Sorting is controlled: the table reports `onSortChange` (ascending first, then flipping) and you sort `rows`. With `onRowClick` it is a keyboard grid: one tab stop, Up/Down/Home/End, Enter. |
| `FileTree` | `entries?: { path, type: "file" \| "dir" \| "directory" }[]` or `nodes?: { name, type?, children? }[]`, `"aria-label"`, `selectedPath?`, `defaultSelectedPath?`, `onSelect?(path, item)`, `expandedPaths?`, `defaultExpandedPaths?`, `onExpandedPathsChange?(paths)`, `onActivate?(path, item)`, `sort?: "natural" \| "none"`, `empty?`, `className?` | Daintree's file tree: the host browser's rows, chevron gutter (files keep it, so their icons line up under their folder's), file-type icons and keyboard model, virtualised so a ten-thousand-file walk mounts one screen of rows. It fills its container's height. `entries` takes what `host.fs.walk` returns and fills in any folder it only implies. `natural` (the default) sorts each folder folders first, then by name, numeric-aware and case-insensitive, so `churn-2` comes before `churn-10` whatever order `walk` returned. One tab stop: Up/Down/Home/End select, Right opens a folder or steps into it, Left closes it or steps out, Enter and double-click call `onActivate`, and typing jumps to a matching name. A row click selects and toggles a folder; the chevron toggles without selecting. Selection and expansion are each controlled when you pass `selectedPath` / `expandedPaths`, uncontrolled otherwise. `item` is `{ path, name, type: "file" \| "directory", depth }`. |
| `LogView` | `lines: (string \| { text, severity? })[]`, `maxLines?` (5000), `follow?` (true), `monospace?` (true), `wrap?` (true), `"aria-label"`, `className?` | A bounded, virtualised log that stays pinned to the newest line while the reader is at the bottom. It bounds the DOM, not your array: append in batches (`useStreamBuffer`) and drop old lines yourself if you keep them in state. |
| `Timeline<T>` | `items: { id, title, icon?, description?, timestamp?, actor?, tone? }[]`, `"aria-label"`, `renderContent?(item, index)`, `groupByDay?`, `timeFormat?: "compact" \| "verbose"`, `now?`, `estimatedItemSize?` (44), `onEndReached?(lastIndex)`, `className?` | An activity feed or audit log: one entry per row on a connecting rail, the actor (a name, or `{ name, src }` with an avatar) before the title, and a relative time on the right with the exact time on hover. The marker is `icon`, else a `tone`'s severity glyph, else a dot; `tone` also tints an icon (`success` leaves it neutral) and is spoken before the title. `renderContent` adds anything under an entry, such as a comment body in `Markdown`; extend the item type with your own fields and read them there. `groupByDay` puts a Today, Yesterday or date header before each day, breaking the rail there. Virtualised with measured rows, so entries of any height mount one screen at a time. It is as tall as its entries up to its container's height, then scrolls, so a long feed needs a sized container; unsized, it grows to fit every entry. Times refresh on a shared minute tick; `now` fixes the clock. |
| `ListRow` | `title`, `subtitle?`, `icon?`, `meta?`, `selected?`, `onSelect?`, `disabled?`, `className?`; DOM props except `title` | A row with Daintree's highlight. Spread `getRowProps(index)` into it for a keyboard listbox; otherwise, with `onSelect`, it is a button, and without, a plain row. In a listbox, report disabled rows through `useListNavigation`'s `isDisabled` too. |
| `ScrollShadow` | `children`, `className?` (the frame; size it here), `scrollClassName?` (the scroller; pad it here), `compact?`, `ref?` (the scroller); DOM props | A vertical scroller with fades that show there is more. DOM props land on the scrolling element, so it can be a listbox. For a windowed list use `VirtualList` with `shadows`. |

`useListNavigation(options)` is the keyboard model of a list: one tab stop, Up/Down/Home/End move the cursor, Enter or Space selects, typing jumps when `getLabel` is given. Options are `count`, `onSelect?(index)`, `loop?` (false), `initialIndex?` (0), `getLabel?(index)` and `isDisabled?(index)` (rows the cursor, typeahead, Enter, Space and clicks all skip). It returns `{ activeIndex, setActiveIndex, containerProps, getRowProps }`: `containerProps` is `{ role: "listbox", tabIndex: 0, "aria-activedescendant", onKeyDown }`, and `getRowProps(index)` is `{ id, role: "option", "aria-selected", "aria-disabled"?, onClick, onPointerMove }`. `activeIndex` is `-1` for an empty list.

### Pane chrome

| Export | Props | Notes |
| --- | --- | --- |
| `PaneHeader` | `title`, `icon?`, `subtitle?`, `actions?`, `className?` | A pane's compact title bar. `subtitle` is one quiet line (a count, a path, a filter in effect); `actions` is usually a `Toolbar`. The host's panel chrome already shows your panel's title and icon, so don't repeat them here: `title` is the view's own context (the branch, the selection, "4,096 of 5,000"). With nothing of that kind to say, leave `PaneHeader` out and use a `Toolbar variant="bar"` for the actions. |
| `Toolbar` | `children?`, `"aria-label"`, `variant?: "inline" \| "bar"`, `className?` | A row of controls that is one tab stop, Left/Right between them. `bar` draws a pane's toolbar strip; `inline` (the default) is the bare group for inside a `PaneHeader`. |
| `ToolbarButton` | `icon?`, `label?`, `"aria-label"?`, `onClick?`, `pressed?`, `expanded?`, `disabled?`, `tooltip?: ReactNode \| false`, `tooltipSide?: "top" \| "bottom"` | Icon-only (its `aria-label` doubles as the tooltip) or, with `label`, an icon and a word. `pressed` is a toggle, `expanded` a disclosure; never both. Disabled buttons stay in the arrow-key order and ignore clicks. |
| `Tabs` | `items: { value, label, icon?, badge? }[]`, `value`, `onValueChange`, `"aria-label"`, `children?: ReactNode \| ((value) => ReactNode)`, `content?: Record<string, ReactNode>`, `density?: "page" \| "strip"`, `className?`, `panelClassName?` | Switches between panes of content; for a value picker use `SegmentedControl`. Arrow keys and Home/End move and select. A number `badge` draws a count pill. |

### Settings grammar

A settings view is a stack of `SettingsSection`s, each holding `SettingsGroup`s of `SettingsRow`s — the same section → group → row grammar Daintree's own settings pages use.

| Export | Props | Notes |
| --- | --- | --- |
| `SettingsSection` | `title`, `description?`, `action?`, `badge?`, `id?`, `children?` | Sentence-case title, no icon. `action` is one control on the heading's right; `badge` a short tag ("Beta"). |
| `SettingsGroup` | `label?`, `id?`, `children?` | One surface of related rows split by hairlines. `label` sits above it when a section has more than one group. |
| `SettingsRow` | `label`, `description?`, `control?: ReactNode \| ((ids) => ReactNode)`, `layout?: "inline" \| "stacked"`, `accessory?`, `disabled?`, `disabledReason?`, `error?`, `isModified?`, `onReset?`, `id?` | Words on the left, control on the rail. A function `control` receives `{ labelId, descriptionId, disabled }` to wire as `aria-labelledby` / `aria-describedby`. `stacked` for paths, code and lists. `isModified` draws the modified-from-default mark, and with `onReset` a reset button. |
| `SettingsActions` | `children?`, `status?` | The explicit-save row at the end of a group: actions right-aligned (`contrast` Save, `outline` others, all `size="sm"`), and a politely announced status on the left. |

### Data display

| Export | Props | Notes |
| --- | --- | --- |
| `StatCard` | `label`, `value`, `delta?`, `tone?: Severity`, `hint?`, `children?`, `className?`; DOM props | One figure for a dashboard row: a sentence-case label (never an uppercase eyebrow), the figure in tabular numerals, and one quiet `hint` line. A number `delta` is signed and drawn with an up or down arrow, and stays neutral, since whether up is good depends on the figure. `tone` adds its severity glyph beside the label and leaves the figure neutral; `success` is for a recorded result, never standing health. Cards carry a hairline and no fill or accent, so a row of them stays quiet. `children` sits below, for a `Sparkline`. Format the value yourself (`formatCount`, `formatBytes`, `formatDuration`). |
| `Sparkline` | `values: number[]`, `"aria-label"`, `height?` (24), `tone?: Severity`, `min?`, `max?`, `className?` | A trend line with no axes, drawn in the secondary text colour or a status colour, never accent, with a dot on the newest value. It fills its container's width. `min`/`max` fix the scale; omitted, it is the values' own range. A non-finite value is a gap, and fewer than two values draw an empty box of the same height. `success` draws neutral: a trend is standing status. An empty `aria-label` hides it from assistive tech, for a line whose figure is already in text beside it. |
| `DiffStat` | `additions?`, `deletions?`, `className?` | Line churn in Daintree's one spelling, "+12 -3": additions in the success ink, deletions in the error ink, since here they are diff notation rather than status. A zero side is left out, and so is the whole stat when both are. It takes its size from the text around it. |

### Dates

Days are ISO `"YYYY-MM-DD"` strings and ranges are `{ start, end }` of them, both ends inclusive. A day is not an instant, so it carries no time or zone and names the same day for every user; never pass one through `new Date("2026-09-30")`, which reads it as UTC midnight and lands on the 29th west of Greenwich. Month and weekday names and the first day of the week follow the user's locale.

| Export | Props | Notes |
| --- | --- | --- |
| `Calendar` | `mode?: "single" \| "range"`, `value?`, `defaultValue?`, `onValueChange?`, `min?`, `max?`, `isDateDisabled?(date)`, `month?: "YYYY-MM"`, `defaultMonth?`, `onMonthChange?`, `numberOfMonths?: 1 \| 2`, `weekStartsOn?: 0–6`, `"aria-label"?`, `className?`, `id?`, `data-*` | An inline month grid, the building block of the pickers. In `single` mode the value is a day; in `range` mode it is a range, reported once both ends are pressed (in either order) and previewed between the two presses. One tab stop: arrows move by day and week, PageUp/PageDown by month and with Shift by year, Home/End to the week's ends, Enter or Space chooses. Today is marked and the selection is the neutral inverse fill, never accent. A disabled day, or one outside `min`/`max`, can take focus but not be chosen. |
| `DatePicker` | `value?: string \| null`, `defaultValue?`, `onValueChange?(value \| null)`, `min?`, `max?`, `isDateDisabled?`, `weekStartsOn?`, `placeholder?`, `clearable?` (true), `disabled?`, `required?`, `invalid?`, `name?`, `open?`, `onOpenChange?`, `density?: "default" \| "compact"`, `id?`, `"aria-label"?`, `"aria-labelledby"?`, `"aria-describedby"?`, `className?` | A field drawn like `Input` that shows the day as "Sep 30, 2026" and opens a `Calendar` from its calendar button (or Alt+Down). Typing is lenient: `2026-09-30`, `2026/9/30`, `Sep 30 2026`, `30 September`, or the locale's numeric order; it is checked on Enter or blur, and text that is not an allowed day marks the field invalid without touching the value. Escape puts the text back. `null` is empty; the clear button hides when `required`. `name` submits the ISO value in a native form. Joins a `FormField` on its own. |
| `DateRangePicker` | `value?: { start, end } \| null`, `defaultValue?`, `onValueChange?(range \| null)`, `presets?: { label, range }[]`, and the rest of `DatePicker`'s | Two months side by side where the window has room, with `presets` ("Last 7 days") listed beside them; work a preset's range out when you render. Typed ranges take two dates with `–`, `-` or `to` between. `name` submits `start/end`. |
| `TimeAgo` | `value: number \| string \| Date`, `verbose?`, `prefix?`, `tooltip?` (true), `className?`, `id?`, `data-*` | A `<time dateTime>` reading `formatTimeAgo` ("5m ago"), or `formatRelativeTime` ("5 minutes ago") when `verbose`, that keeps itself current: every `TimeAgo` shares `useNow`'s clocks, ticking every 30 s for the first hour and then every 5 minutes and every hour (by the second only while a verbose age is under a minute), and none tick while the view is hidden. The full date and time is in a tooltip; `tooltip={false}` puts it in a native `title` instead, for an age inside a button or option. |

### Icons

`Icon` draws one of Daintree's own icons by name: `name`, `size?` (16 px; inside a kit `Button` the button sizes it), `className?`, `"aria-label"?` (omitted, the icon is decorative and `aria-hidden`). An unknown name renders nothing, with a warning in development, rather than throwing. The set only grows. The names are Lucide-style kebab-case, plus two Daintree concepts, `worktree` (a git worktree) and `daintree` (the app's mark):

`activity`, `alert-octagon`, `alert-triangle`, `arrow-down`, `arrow-left`, `arrow-right`, `arrow-up`, `arrow-up-right`, `at-sign`, `bell`, `bell-dot`, `book-open`, `bookmark`, `bot`, `braces`, `bug`, `calendar`, `chart-column`, `chart-line`, `chart-pie`, `check`, `check-square`, `chevron-down`, `chevron-left`, `chevron-right`, `chevron-up`, `chevrons-up-down`, `circle-check`, `circle-dashed`, `circle-dot`, `circle-slash`, `circle-x`, `clipboard`, `clock`, `cloud`, `cloud-off`, `code`, `copy`, `daintree`, `database`, `download`, `external-link`, `eye`, `eye-off`, `file`, `file-code`, `file-diff`, `file-plus`, `file-text`, `file-warning`, `filter`, `flame`, `flask`, `folder`, `folder-code`, `folder-open`, `folder-search`, `folder-tree`, `folder-x`, `gauge`, `git-branch`, `git-branch-plus`, `git-commit`, `git-compare`, `git-fork`, `git-merge`, `git-merge-conflict`, `git-pull-request`, `git-pull-request-closed`, `git-pull-request-draft`, `globe`, `grip-vertical`, `hash`, `help`, `history`, `home`, `hourglass`, `image`, `import`, `inbox`, `info`, `key`, `layers`, `layout-grid`, `layout-panel-top`, `lightbulb`, `link`, `list`, `list-checks`, `list-todo`, `loader`, `lock`, `mail`, `maximize`, `menu`, `message-square`, `minimize`, `minus`, `monitor`, `monitor-play`, `more-horizontal`, `more-vertical`, `mouse-pointer`, `notebook`, `package`, `panel-left`, `panel-right`, `panel-right-close`, `panel-right-open`, `paperclip`, `pause`, `pencil`, `pin`, `pin-off`, `play`, `plug`, `plus`, `puzzle`, `redo`, `refresh`, `rocket`, `rotate-ccw`, `rotate-cw`, `save`, `search`, `send`, `server`, `settings`, `share`, `shield`, `sliders`, `sort`, `sparkles`, `square`, `square-dashed-mouse-pointer`, `star`, `sticky-note`, `table`, `tag`, `target`, `terminal`, `trash`, `undo`, `unlink`, `unlock`, `unplug`, `upload`, `user`, `user-plus`, `users`, `wifi-off`, `workflow`, `worktree`, `wrench`, `x`, `zap`.

`PluginIconName` in `shared/types/plugin-sdk-react.ts` is the authoritative list. For a glyph that is not in it, pass your own `<svg>` element to a prop that takes a `PluginIconSource`. Importing `lucide-react` bundles it into the view, which `daintree-plugin lint` flags.

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

`value` is a timestamp in milliseconds, an ISO string or a `Date`. For an age on its own, `TimeAgo` does all of this for you. Otherwise pair the relative formatters with `useNow()` from `@daintreehq/plugin-sdk/react`, so every time on screen turns over together on one shared timer. `formatTimeAgo` is minute-grained ("just now" for the first 60 seconds), so a once-a-minute `useNow()` is all it needs. For a time that ticks by the second ("12s ago", a running timer), use `useNow({ intervalMs: 1000 })` with `formatDuration(now - startedAt)`, which reads "12s" under a minute and "3m" after.

## Builtins draw through the kit

Daintree's built-in plugins (GitHub, GitLab, the Markdown editor, the SvelteKit site builder) render through this same public kit rather than importing the host's internal components, so every gap a third-party plugin would hit shows up in a first-party one first, and the kit is what gets fixed. An ESLint rule in `eslint.config.js` enforces it: in `plugins/builtin/*/renderer/**`, importing any host UI export the kit covers — `Button`, `Select`, `Dialog`, `Popover`, the settings rows and the rest, listed export by export — is an error with "Use the equivalent from @daintreehq/plugin-ui."

A builtin that still needs a covered export gets an exception scoped to one file and exactly those export names, and the block's `name` records the kit gap that forces it (a `Popover` with no anchor, a `Select` whose options cannot carry item markup, and so on). A contract test (`src/components/ui/__tests__/bundledPluginPrimitives.contract.test.ts`) reads those blocks and fails any exception the file no longer uses, so an exception disappears the moment the kit closes its gap. Tests and preview harnesses are exempt; they are not the plugin's runtime.

## Checking a view against the kit

`daintree-plugin lint` points at hand-rolled versions of kit controls — `raw-button`, `raw-form-control`, `native-title-tooltip`, `inline-svg-icon`, `lucide-react-import`, `hand-rolled-spinner`, `hand-rolled-badge`, `native-dialog-in-view` — and at classes that compile to nothing against the design contract. The Styles tab in Settings → Plugins runs the same class check against a running view. See [Development loop → Lint](./dev-loop.md#daintree-plugin-lint-dir).
