# Views: what you get in the DOM

A plugin view is a React component the renderer mounts inside a panel, or in the plugin's settings. This page is what that component can rely on, what it can't, and how to make it look like it belongs. It applies equally to a project plugin's hand-written `dist/panel.js` and to a bundled `@daintreehq/plugin-vite` view; the differences are called out where they exist. The short version: draw with [the kit](#host-ui-components), style the rest with [Daintree's tokens](#styling), get data with [the SDK's hooks](#the-sdks-react-hooks), and read [Performance](#performance) before you render a list. The manifest side is [Contribution points → Views](./contribution-points.md#views--shipped).

## Where you render

Views render **inline** in Daintree's React tree, not in an iframe. Same document, same CSS cascade, same `:root` custom properties, same React instance. That is what makes the styling below possible, and it is also why a view has the same reach as Daintree's own UI, including the full `window.electron` bridge. The [trust model](./trust-model.md) covers what that means; this page covers what to do with it.

The host mounts your default export under an error boundary and a `Suspense` boundary, inside a container that is `flex flex-col flex-1 min-h-0 w-full`. Make your root element fill it: `height: 100%` with `display: flex; flex-direction: column; min-height: 0` is the shape that scrolls correctly, because `min-height: 0` is what lets a flex child shrink below its content and hand the overflow to an inner scroller. A root that is only `height: 100%` will push the panel's own scrollbar around instead of owning it. The kit's [`PaneLayout`](./ui-kit.md#page-structure) is that shape already, with the header, toolbar and status strip at the host panes' own heights and the body as the one scroller.

You receive [`PanelViewProps`](./contribution-points.md#views--shipped): `panelId`, `pluginId`, `worktreeId`, `disposeSignal`, `panelRemovedSignal`, `initialArgs`, `stateVersion`, `persistState`, `requestReload`, `setHasUnsavedChanges`, `styleRootAttributes`, and on a settings view `settingsContext`. Two of these are misread in every first plugin. `pluginId` is your host-side id, which for a project plugin is the instance key, not your manifest name; pass it through to the bridge as given. `disposeSignal` aborts on every unmount, including the temporary ones (a sibling pane maximised, a dock tab left), so it is for cancelling fetches, never for deciding something is finished. `stateVersion` says which shape `initialArgs` holds, and is only meaningful once you declare `stateVersion` on the panel contribution — see [panel state versioning](./contribution-points.md#panels--shipped).

A render error shows the host's diagnostics pane with a Try again that re-imports the module, Close panel, Copy diagnostics and View logs. The rest of Daintree keeps working.

## Reloading a view

`requestReload()` asks the host to throw away the view you are running and mount a new one for the same panel. Use it when a view has built up more than it can shed — a long session of rendering, caches that only grow — and starting over is simpler than cleaning up in place. Your plugin's backend keeps running throughout.

What a reload is, plainly: a new React attempt using the module that is already loaded. The current attempt's `disposeSignal` aborts and its React cleanup runs; the new attempt gets a fresh `disposeSignal` and fresh DOM, and `initialArgs` holds the latest state the host accepted through `persistState`, with its `stateVersion`. `panelId`, `panelRemovedSignal` (the same object, still open), the panel's place in the layout and the backend all carry over. The module is reused, not evaluated again.

What a reload is not: module-scope variables, anything registered document-wide and anything you attached to `window` survive it untouched, so it frees only what your cleanup releases. It makes no promise about reclaiming memory, and it cannot rescue a view that is blocking the renderer — a stuck render loop never gets as far as asking.

It is a request. The host may refuse it, nothing tells you whether or when the new attempt mounted, and calls in the same tick coalesce into one reload. The callback belongs to the attempt that received it, so one you held on to after your view was torn down does nothing. The host polices loops: a fourth reload within 30 seconds of three accepted ones stops the view and shows the user an error with a Reload panel action, and automatic reloads stay off until the user uses it. Plugin panels get `requestReload` whether they sit in the grid, the dock or a dialog; a project surface does not, so call it optionally. Your backend can ask for the same thing with [`host.reloadPanel(panelId)`](./host-api.md#reloadpanel), which draws on the same budget.

The user can reload the panel too, from Reload panel in its menus and dialog header, and an agent can through the host's tools. That reload is the same new attempt, it is never rationed, and it is what lifts a stopped view. It does not ask first, because what you persisted comes back. If your view holds work it has not persisted — an unsaved draft, a half-filled form — call `setHasUnsavedChanges(true)` while it does and `setHasUnsavedChanges(false)` once it is saved or dropped; while it is set, the user is asked to confirm before the view is discarded, whichever way the reload was asked for. Your own `requestReload` is never held up by it. Like `requestReload`, the setter belongs to its attempt, a new attempt starts with nothing unsaved, and it is absent where there is no reload to guard.

## A settings section

A view with `location: "settings"` is your plugin's custom settings section, for what the generated [settings fields](./contribution-points.md#settings-schema--shipped) can't express — a sign-in, a list or a table of pairs (the kit's `ListEditor` and `KeyValueEditor`), a connection test. Declare at most one, with an `id` no panel uses:

```json
{ "id": "connection", "componentPath": "dist/settings.js", "location": "settings" }
```

The 0.1.0 CLI on npm accepts only `location: "panel"` views, so its `validate` and `package` refuse this entry: Not in the 0.1.0 release on npm; it ships in the next one.

The host mounts it in your settings home, below the generated fields. The section heading is the home's own, and the host draws one `SettingsGroup` around your view, so the view renders **rows** and nothing else: kit `SettingsRow`s under one root, with no heading, no card, and no `SettingsSection` or `SettingsGroup` of its own. There is no Save either — apply each change as it is made, like every other settings row — so a `SettingsActions` Save row does not belong in a `location: "settings"` view.

**Which home, which scope.** It receives `settingsContext: { scope, projectId }`. An installed plugin's section mounts twice — `{ scope: "user", projectId: null }` in the plugin manager, `{ scope: "project", projectId }` in Project settings — so render the rows for the scope you're given; each mount has its own `panelId`. A project plugin's section mounts only in Project settings, with `scope: "project"`.

**What it doesn't get.** There is no panel record behind it, so `initialArgs`, `persistState`, `stateVersion`, `worktreeId`, `requestReload` and `setHasUnsavedChanges` are absent. `pluginId`, `panelId`, `disposeSignal`, `panelRemovedSignal` and `styleRootAttributes` behave as they do in a panel.

**Containment.** The surface is contained like a project surface (`contain: layout paint`, overflow clipped, its own stacking context), so a `position: fixed` descendant stays inside it; portal anything that has to float with the kit's `Portal`, which marks its container as your style root.

**Lifecycle.** Mounting the section activates a loaded plugin that hasn't activated yet, as opening a panel does; it never starts a stopped one. While the plugin is disabled or stopped, the section shows as a single row saying it's available once the plugin runs. When the plugin stops, is muted or reloads, the section is unmounted and its `disposeSignal` and `panelRemovedSignal` abort. After a reload an open settings page shows "Reloading…" until the new module is being served, then mounts it — it never runs the retired one. A render error shows the same diagnostics pane with Try again that a panel gets.

**Fields it owns.** Mark a declared setting `editor: "view"` when this section is where it is edited — a credential behind a sign-in button, a table stored as `json`. The generated form then leaves it out, and a deep link to that key (`host.settings.open(key)`, the setup strip's **Open plugin settings**) lands on your section instead of a field. The setting keeps everything else a declaration gives it: `required` still drives the setup strip, and `host.settings.get` still reads it.

```jsx
import { Button, SettingsRow } from "@daintreehq/plugin-ui";

// One root whose children are rows. The host's group splits only its own direct
// children, so the root draws the hairlines between yours, in the group's own ink.
<div className="divide-y divide-border-subtle">
  <SettingsRow
    label="Connected account"
    description="Signed in as ada@example.com"
    control={
      <Button variant="outline" size="sm" onClick={signOut}>
        Sign out
      </Button>
    }
  />
  <SettingsRow
    label="Connection"
    description="Checks the account can reach the bank."
    control={
      <Button variant="outline" size="sm" loading={testing} onClick={testConnection}>
        Test connection
      </Button>
    }
  />
</div>;
```

A view has no `host`, so the section reads and writes through your worker, like any other view:

```js
// worker. bankToken is a required secret; the section learns only whether one is stored.
host.registerHandler("connection", async () => ({
  connected: !(await host.settings.missingRequired()).includes("bankToken"),
}));
host.registerHandler("saveToken", async (_ctx, token) => {
  await host.settings.set("bankToken", token);
});

// view
const { connected } = await window.electron.plugin.invoke(pluginId, "connection");
```

Store what the section edits with your worker: credentials as a declared `type: "secret"` setting (`host.settings.set`), everything else in `host.storage` or a `host.db` database (declare it `location: "local"` to keep it on this machine and out of the repository). Never put a credential in `host.storage` or a database. In the section, a kit `SecretInput` with `stored` shows that one is saved, with Replace and Clear, without the view ever holding it.

## Styling

**Draw with the kit first.** Buttons, inputs, selects, lists, tables, dialogs, empty and loading states, icons and the settings grammar are [`@daintreehq/plugin-ui`](#host-ui-components) components, already styled and themed; `daintree-plugin lint` points at a hand-rolled one. Tailwind is for the layout around them and for anything bespoke — and nothing below is locked down for that.

**Tailwind utility classes are how you style a plugin view.** Write `className="flex gap-2 p-4 bg-surface-panel"` and it works — in a hand-written `dist/panel.js` exactly as in a bundled view, with no build step and no configuration on your side.

Daintree compiles the classes your view uses at runtime, in the renderer, against the host's own Tailwind and the host's own theme. Two consequences worth understanding, because they are what the rest of this section follows from:

- **You get Daintree's vocabulary, not Tailwind's stock one.** The design system is enforced by the compiler. `bg-surface-panel` compiles; `bg-red-500` compiles to nothing at all, because the host's theme deletes the stock palette. This is deliberate — it is what keeps plugin panels looking like the app.
- **The generated rules are scoped to your view.** They apply inside the element the host marks as your style root and nowhere else, so a plugin can never restyle host chrome.

Semantic colours resolve to live theme variables, so a panel built on them follows a theme switch with no work on your side. Ordinary layout, spacing, sizing, typography, flexbox, grid, state variants (`hover:`, `focus-visible:`, `disabled:`, `group-hover:`), arbitrary values (`w-[327px]`), dynamic scales (`grid-cols-47`) and container queries all behave exactly as Tailwind documents them.

**Not part of the vocabulary:** stock palette colours (`bg-red-500`, `text-blue-600`); `dark:` — Daintree themes are runtime tokens, not a class, so a semantic token is already theme-aware and `dark:` is never the answer; `prose` (`@tailwindcss/typography` is not in the plugin contract; for rendered Markdown use [`Markdown`](#host-ui-components), which brings the host's document styles with it); `@apply`, which needs a build step this path does not have.

Prefer **container queries** (`@container`, `@sm:`, `@md:`) over viewport breakpoints (`sm:`, `md:`). A breakpoint describes the whole window; your panel is one pane in a grid and can be narrow while the window is wide. The container has to be an **ancestor**: `@md:` answers to the nearest enclosing `@container`, never to the element carrying it, so `@container @md:grid-cols-4` on one element never applies (lint: `self-container-query`). Put `@container` on the wrapper and the variants on its children. When the structure itself has to change with the pane — a list beside its detail when wide, stacked when narrow — read the width with the kit's `useContainerSize` or `useBreakpoint`, which answer to the element you hand them, and lay the grid out with `AutoGrid`, which reflows with its own width.

### The vocabulary

<!-- BEGIN generated: plugin-style-vocabulary -->

**Surfaces** — shown with `bg-`; `border-` and `text-` take the same names

`bg-surface-canvas` `bg-surface-sidebar` `bg-surface-toolbar` `bg-surface-panel` `bg-surface-panel-elevated` `bg-surface-dialog` `bg-surface-grid` `bg-surface-input` `bg-surface-inset` `bg-surface-hover` `bg-surface-active` `bg-surface-disabled` `bg-surface-highlight`

**Text**

`text-text-primary` `text-text-secondary` `text-text-muted` `text-text-placeholder` `text-text-inverse` `text-text-link`

**Borders** — shown with `border-`; `divide-` and `ring-` take the same names

`border-border-default` `border-border-subtle` `border-border-strong` `border-border-divider` `border-border-interactive` `border-border-input`

**Status** — shown with `bg-`; `text-` and `border-` take the same names

`bg-status-success` `bg-status-warning` `bg-status-danger` `bg-status-info` `bg-status-danger-surface` `bg-status-success-surface` `bg-status-warning-surface` `bg-status-info-surface` `bg-status-error` `bg-status-error-surface`

**Accent** — shown with `bg-`; `text-` and `border-` take the same names

`bg-accent-primary` `bg-accent-hover` `bg-accent-foreground` `bg-accent-primary-foreground` `bg-accent-soft` `bg-accent-muted` `bg-accent-secondary` `bg-accent-secondary-soft` `bg-accent-secondary-muted`

**Overlays** — shown with `bg-`; `border-` takes the same names

`bg-overlay-base` `bg-overlay-subtle` `bg-overlay-soft` `bg-overlay-medium` `bg-overlay-strong` `bg-overlay-emphasis` `bg-overlay-hover` `bg-overlay-active` `bg-overlay-selected` `bg-overlay-elevated` `bg-overlay-raised` `bg-overlay-highlight`

**Radii**

`rounded-xs` `rounded-sm` `rounded-md` `rounded-lg` `rounded-xl` `rounded-2xl` `rounded-3xl` `rounded-4xl`

**Shadows**

`shadow-ambient` `shadow-floating` `shadow-dialog`

**Type scale below Tailwind's floor**

`text-2xs` `text-3xs` `text-4xs`

**Fonts**

`font-mono`

**Durations**

`duration-75` `duration-100` `duration-120` `duration-150` `duration-200` `duration-250` `duration-300`

**Easings**

`ease-snappy` `ease-spring-critical` `ease-out-expo` `ease-exit` `ease-panel-minimize`

**Category hues** — `bg-`, `text-` or `border-`, then `category-<hue>` and a variant suffix: `bg-category-blue-subtle`, `text-category-teal-text`

hues: `blue` `purple` `cyan` `green` `amber` `orange` `teal` `indigo` `rose` `pink` `violet` `slate`

variants: `(bare)` `-subtle` `-text` `-border`

**SVG paint** — `fill-` and `stroke-` take every colour name above, and `fill-current` / `stroke-current` paint with the element's text colour

`fill-text-muted` `stroke-border-default` `fill-status-danger` `fill-category-blue`

**Custom variants** — write as `variant:utility`

`reduce-motion:` `motion-reduce:` `motion-safe:`

<!-- END generated: plugin-style-vocabulary -->

Everything else Tailwind ships that does not name a colour works too — this list is the part that is Daintree's rather than Tailwind's.

### Copy-ready shapes

```jsx
// Panel root, when the kit's PaneLayout doesn't fit. `flex flex-col flex-1 min-h-0`
// is what makes an inner scroller own the overflow instead of pushing the
// panel's own scrollbar around.
<div className="flex flex-col flex-1 min-h-0 bg-surface-panel text-text-primary">

// A bespoke row the kit's ListRow doesn't fit
<div className="flex items-center gap-2 px-3 py-2 hover:bg-surface-hover">

// Section label
<div className="px-3 pt-3 pb-1 text-2xs font-medium uppercase text-text-muted">
```

Buttons, badges, inputs and spinners are not on this list on purpose: they are `Button`, `Badge`, `Input` and `Spinner` in the kit (and text sizes and colours are `Text` and `Heading`, status dots `StatusDot`), and a hand-rolled copy is what the `raw-button`, `hand-rolled-badge`, `raw-form-control` and `hand-rolled-spinner` lint rules report.

**Conditional classes must be complete strings.** `isActive ? "bg-surface-active" : ""` works. `` `bg-surface-${tone}` `` does not — the compiler sees the class in your source or in the DOM, and a name assembled from fragments exists in neither until it is too late to matter. The same rule applies to a lookup table, which is fine, and to string concatenation, which is not.

**Portals need a marked container.** Anything you render with `createPortal` leaves your style root, so its classes generate CSS that never matches. Kit overlays — `Dialog`, `ConfirmDialog`, `Popover`, `DropdownMenu`, `Tooltip` — portal for you and re-mark the content you pass them, so your classes still apply inside a dialog body. For a portal of your own, use the kit's `Portal`, which marks its container for you:

```jsx
import { Portal } from "@daintreehq/plugin-ui";

<Portal>
  <div className="fixed right-4 bottom-4 p-4 bg-surface-dialog">…</div>
</Portal>;
```

A raw `plugin://` view that renders without the kit spreads `styleRootAttributes` from `PanelViewProps` onto its own `createPortal` container instead.

**A `<style>` element still works**, for the things utilities do not cover — a keyframe, a complex selector, a third-party widget's stylesheet. Scope your selectors under a class on your root so you don't restyle the host. Do not ship compiled Tailwind CSS: `@daintreehq/plugin-vite` fails the build if you wire Tailwind into it, because two independently-compiled copies of the same utilities lose Tailwind's own ordering rules.

**Custom properties are still there** if you prefer to write plain CSS on tokens. Every `--theme-*` and `--color-*` the host defines is readable from your view; `src/styles/design-contract.css` in the Daintree repo is the authoritative list. Canvas and WebGL code, which cannot use a CSS variable, reads resolved colours from the kit's [theme API](#theme-api-for-canvas-and-webgl) instead of `getComputedStyle`, so it follows a theme switch.

Two rules from the design contract that apply to plugins as much as to the host: accent colour is at most one load-bearing signal per region, so in doubt use no accent (a kit `Button` with no `variant` is the accent-filled primary, so give it to one action per region and `secondary`, `outline`, `ghost` or `subtle` to the rest); and a plugin panel that reads as native uses the host's own treatments for rows, chips, section labels and buttons rather than inventing new ones. The kit is those treatments.

**Icons.** Use `Icon` from the kit: `createElement(Icon, { name: "git-branch" })` draws one of Daintree's own icons, sized 16 px by default and coloured by `currentColor`. Every kit prop that takes an icon (`Button`'s `icon`, `ListRow`, `PaneHeader`, `EmptyState`, …) accepts the same names. An inline `<svg>` still works for a glyph the set lacks, and most of those props accept your own element too — a few take a name only: `Select` options, `Callout`'s `icon`, `DropdownMenu` and `ContextMenu` entries (`action` entries included), `Tabs` items and `SpinningIcon`; don't copy lucide paths by hand or bundle `lucide-react` (lint: `inline-svg-icon`, `lucide-react-import`). The `iconId` in your manifest covers the panel tab and toolbar, not the inside of your view.

## Getting data in

Nothing reaches a view unless the worker sends it. The bridge is `window.electron.plugin`:

| Call | Direction | Pairs with |
| --- | --- | --- |
| `invoke(pluginId, channel, ...args)` | View asks, worker answers | `host.registerHandler(channel, (ctx, ...args) => …)` |
| `on(pluginId, channel, cb)` | Worker pushes to every `on` subscriber for this plugin and channel — across all its panel kinds, not one kind | `host.postToPanel(channel, payload)` |
| `onPanel(pluginId, channel, panelId, cb)` | Worker pushes to one instance | `host.postToPanel(channel, payload, panelId)` |

`on` and `onPanel` return an unsubscribe function; return it from your effect. Pushes are not buffered: a push during `activate()` is gone before any view mounts. They are also not ordered against `invoke` results — a push can land before or after the answer to a pull made at the same moment — so the shape that works is subscribe first, then pull, with a revision on both to keep whichever is newer. [Patterns → Subscribe, then pull](./patterns.md#subscribe-then-pull) has the code, and `useSyncedCollection` does it for a keyed list ([Push deltas](./patterns.md#push-deltas-not-the-whole-state)).

The host delivers pushes batched, one IPC message per task per renderer, in order and never merged; each payload is copied when you post it, and a targeted push to a panel that has closed is dropped. A push is at most 1 MiB, an `invoke`'s arguments 4 MiB and its result 16 MiB; past that the call fails with a `PLUGIN_PAYLOAD_TOO_LARGE:` error naming the limit. A handler has five minutes to settle by default, after which the view's `invoke` rejects with `PLUGIN_INVOKE_TIMEOUT:`; pass `registerHandler(channel, handler, { timeoutMs })` to change it (`0` for none). [Host API](./host-api.md) is the reference.

### Zero-build views and the import map

A view is served exactly as written; nothing compiles it. Its bare imports resolve through the host's import map, which serves exactly the five React specifiers (`react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom`, `react-dom/client`), the tour's four (`@daintreehq/tour`, `@daintreehq/tour/react`, `@daintreehq/tour/kit`, `@daintreehq/tour/mock-app`), [`@daintreehq/plugin-ui`](#host-ui-components) and [`@daintreehq/plugin-sdk/react`](#the-sdks-react-hooks), and nothing else. Each resolves to the host's own instance, so your view shares the app's React rather than bringing a second copy. Everything else a raw view imports is a relative module you ship. So a hand-written view uses `createElement` instead of JSX, the kit for its controls, the SDK's hooks (or the `window.electron.plugin` bridge above) for its data, and the [SDK's documented JSON](#handing-work-to-an-agent-by-drag) instead of its root-entry helpers.

`@daintreehq/plugin-sdk/react` is served to zero-build views only. A view bundled with `@daintreehq/plugin-vite` keeps bundling the SDK version its author pinned, so a Daintree upgrade never swaps its hooks out from under it.

The worker is the other way round: it is Node, and it can import `@daintreehq/plugin-sdk`, `/files` and `/data` with no install, because the plugin worker serves a copy that ships with Daintree ([data helpers](./data-helpers.md)). The view cannot import those three, and the worker cannot import `/react`. Do data work in the worker and hand the view results over a channel.

### Sharing a module between worker and view

Code both halves need — a formatter, a validator, the shape of a record — can live in one `.mjs` file that each imports by relative path. `.mjs` is ES module syntax to Node whatever your `package.json` says, and the host serves it to the renderer as JavaScript:

```js
// shared/money.mjs — imported by both halves
export function formatCents(cents, currency) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100);
}

// dist/index.mjs (worker)
import { formatCents } from "../shared/money.mjs";

// dist/panel.js (view)
import { formatCents } from "../shared/money.mjs";
```

The module has to run in both places: relative imports with their file extensions only, no bare specifiers (the view cannot resolve an npm package, the worker cannot resolve `react`), no Node built-ins and no DOM. The view's copy resolves inside the same view generation as the view itself, so a plugin reload picks up edits to it along with the view.

### The SDK's React hooks

`@daintreehq/plugin-sdk/react` works in every view: a bundled view bundles it, and a zero-build view imports it through the import map. Its hooks are the bridge calls above done properly — subscriptions released with the mount, races handled, renders batched — so prefer them to calling the bridge by hand.

| Import | What it is |
| --- | --- |
| `useHostChannel`, `usePluginEvent`, `usePluginPanelEvent` | The three bridge calls above as hooks. See [Host API → React hooks](./host-api.md#react-hooks--daintreehqplugin-sdkreact). |
| `useSyncedCollection`, `useCachedHostChannel`, `useStreamBuffer`, `useThrottledCallback`, `usePluginEventSelector`, `useHostStore`, `shallowEqual` | Getting data in without over-rendering: a keyed list mirrored by deltas, a cached read revalidated in the background, appended lines, replaceable values, one slice of a large push. See [Performance](#performance). |
| `useVirtualList`, `useProgressiveList` | Headless windowing and progressive rendering for lists you draw yourself. |
| `useNow`, `useAnimationFrame` | A shared clock and a frame loop, both paused while nobody can see the view. |
| `lazyWithPreload`, `usePreloadOnIntent` | A split chunk preloaded on hover or focus, so it renders in its first frame. |
| `createViewScope` | Releases listeners, timers, observers, workers and WebGL contexts with the mount. See [Resources your view owns](#resources-your-view-owns). |
| `loadDocumentPackage` | Loads a library the host document keeps across reloads. See [Document packages](./document-packages.md). |

A zero-build view gets every hook here from the host. A bundled view gets them from the SDK it installs, and 0.1.0 on npm has only the first row and `loadDocumentPackage`; for everything else in this table: Not in the 0.1.0 release on npm; it ships in the next one.

A bundled view can also import `setAgentContextDragData` from the root `@daintreehq/plugin-sdk` entry ([Handing work to an agent by drag](#handing-work-to-an-agent-by-drag)); a zero-build view writes the same JSON by hand. The helper: Not in the 0.1.0 release on npm; it ships in the next one. `@daintreehq/plugin-ui` is never bundled: the preset leaves it external and the host serves it. That externals rule in the preset: Not in the 0.1.0 release on npm; it ships in the next one.

There are no hooks for worktrees, settings or commands. A view reads its own worktree from the `worktreeId` prop and gets everything else from the worker.

**Types.** A scaffolded plugin's `tsconfig.json` already lists `"types": ["@daintreehq/plugin-sdk/view-globals", "@daintreehq/plugin-sdk/plugin-ui"]`. The first declares `window.electron.plugin` (`invoke`, `on`, `onPanel` — and nothing else on `window.electron`, on purpose); the second declares the kit. Without them a view that calls the bridge fails `tsc` with `Property 'electron' does not exist on type 'Window'` even though Vite builds it. Add both to a hand-made tsconfig. The two type entries: Not in the 0.1.0 release on npm; it ships in the next one.

## Host UI components

`@daintreehq/plugin-ui` is Daintree's own UI kit, served to your view through the same import map as React: the host's components running from the host's code, styled with the host's tokens, so they look and behave like the app in every theme without you shipping or styling anything. They carry the keyboard and screen-reader behaviour of the host's own controls, and the ones that open over the page (dialogs, menus, tooltips, select lists) sit in the host's overlay layer. A zero-build view imports it like `react`; a `@daintreehq/plugin-vite` build leaves it external, because there is no package to bundle — the implementation only exists inside the running app.

**Reach for it first.** A hand-rolled button, input, badge, spinner, dialog or inline icon is what makes a plugin look foreign, and `daintree-plugin lint` names the kit component for each one it finds. In the lab, ten plugins written without the kit hand-rolled 117 such pieces between them; the same plugins ported to it kept 12, the things the kit has no component for. The token vocabulary under [Styling](#styling) stays available for exactly those.

```js
// dist/panel.js — zero build: the kit, the SDK hooks and react all come from the host.
import { createElement, useState } from "react";
import { useCachedHostChannel } from "@daintreehq/plugin-sdk/react";
import { Button, ConfirmDialog, EmptyState, PaneHeader, PaneState } from "@daintreehq/plugin-ui";

export default function Notes({ pluginId, disposeSignal }) {
  const { data, error, revalidate } = useCachedHostChannel(pluginId, "notes", null, {
    signal: disposeSignal,
    invalidateOn: "notes-changed",
  });
  const [discarding, setDiscarding] = useState(false);

  if (error && !data)
    return createElement(PaneState, {
      kind: "error",
      title: "Couldn't load notes",
      onRetry: revalidate,
    });
  if (!data) return createElement(PaneState, { kind: "loading", title: "Loading notes" });

  return createElement(
    "div",
    { className: "flex flex-col flex-1 min-h-0" },
    // The panel's own title and icon are already in the host's chrome above
    // this view; the header says what only the view knows.
    createElement(PaneHeader, {
      title: `${data.length} notes`,
      actions: createElement(
        Button,
        { variant: "ghost", size: "sm", onClick: () => setDiscarding(true) },
        "Discard draft"
      ),
    }),
    data.length === 0
      ? createElement(EmptyState, {
          title: "No notes yet",
          description: "Ask an agent to add one.",
        })
      : createElement(NoteList, { notes: data }), // your own component, or a kit VirtualList
    createElement(ConfirmDialog, {
      open: discarding,
      onClose: () => setDiscarding(false),
      onConfirm: () => discardDraft(), // yours: e.g. invoke a worker channel, then close
      title: "Discard this draft?",
      confirmLabel: "Discard draft",
      variant: "destructive",
    })
  );
}
```

### What it has

`plugin-ui.d.ts` in `@daintreehq/plugin-sdk` is the full, current list with every prop, and the [UI kit reference](./ui-kit.md) documents each export; these are the groups.

| For | Components |
| --- | --- |
| Actions | `Button` (variants `default` — the accent primary, and the default — `secondary`, `outline`, `ghost`, `subtle`, `contrast`, `destructive`, `ghost-danger`, `link`, `pill`), `IconButton`, `SplitButton` (a primary action with a menu of alternatives), `ToggleGroup` (toggle buttons, any number or at most one on), `CopyButton`, `DismissButton`, `DropdownMenu`, `ContextMenu` (the same rows on a right-click or Shift+F10; both nest submenus and take a description line per row) |
| Forms | `Input` (text, search, email, url, password, number, tel, date, time, datetime-local), `Textarea`, `Select` (an `options` array; `value={null}` shows the placeholder again), `Combobox` (a `Select` with a search, for long or fetched lists), `MultiSelect` (several choices, as chips), `TagInput` (free-text tags), `Checkbox`, `Switch`, `RadioGroup`, `SegmentedControl`, `NumberInput` (steppers, units, clamping), `Slider`, `RangeSlider` (a low and a high value), `ColorPicker` and `ColorSwatch` (label and tag colours), `SearchField`, `FilterChip` (a toggle or removable filter in a filter bar), `FileDropzone` (drop or choose files; you get `File` objects, never paths), `FormField` (label, description and error wired to the control), `FormFieldGroup` (one label over a set of controls), `Form` with `useForm` (dirty tracking, sync and async checks, submit and reset) and `FormStatus`, `SchemaForm` (a settings group generated from a JSON Schema) |
| Text inputs | `MentionTextarea` (a growing field with `@` and `/` suggestions), `Composer` (the agent composer: text, attachments and Send or Stop), `InlineEdit` (a name renamed in place), `KeyValueEditor` (environment variables, headers), `ListEditor` (hosts, globs, scopes), `SecretInput` (a token or key, saved without the view holding it), `ShortcutRecorder` (a keyboard shortcut in the app's notation) |
| Lists and tables | `VirtualList`, `DataTable` (with checkbox selection, groups, expandable rows, resizable and hideable columns, a pinned first column and inline editing when you ask for them), `LogView`, `ListRow` with `useListNavigation`, `ScrollShadow`, `FileTree`, `TreeView` (a tree of anything: lazy children, checkboxes, drag to reorder), `ObjectInspector` (an API response or tool result as a collapsible value), `Timeline` (an activity feed or audit log), `HighlightedText` (search matches in a row) |
| Figures | `StatCard` (a labelled figure with an optional change), `Sparkline`, `Meter` (usage against a limit, with warning and danger thresholds), `DiffStat` ("+12 -3") |
| Dates | `Calendar` (an inline month grid, one day or a range), `DatePicker` and `DateRangePicker` (typed or picked ISO `"YYYY-MM-DD"` days, range presets), `TimePicker` and `DateTimePicker` (kit-drawn `"HH:mm"` times and `"YYYY-MM-DDTHH:mm"` date-times, with the zone named), `TimeAgo` (an age that keeps itself current) |
| Charts | `BarChart` (grouped or stacked, upright or across), `LineChart` (numeric or time x, optional area), `DonutChart` (parts of a whole), `StackedAreaChart` (series piled to a total or 100%), `ScatterChart` (points by two numbers), `Histogram` (a distribution), `Heatmap` (a value per pair of categories), `ContributionGrid` (a calendar of daily counts), `Gauge` (one number against its range) — all with a tooltip anchored to the point under the pointer or the arrow keys |
| Rich display | `TerminalOutput` (CLI output in the terminal's colours, with progress-bar rewrites and OSC 8 links) and `AnsiText` (a short run of it inline), `HoverCard` (a preview of a person, issue or commit), `ImageViewer` (zoom, pan and step through screenshots, in a pane or a lightbox), `TableOfContents` (a long document's sticky, scroll-tracking outline) |
| Type and status marks | `Text` and `Heading` (the type ramp and colour roles), `Link`, `InlineCode`, `CodeBlock` (a highlighted read-only snippet), `PathLabel` (a path that ellipsises in the middle), `VisuallyHidden`, `LiveRegion` and `useAnnounce` (spoken updates), `Portal`, `StatusDot` and `StateGlyph` (running, waiting, idle, error, success), `ColoredLabel` (a label in a colour the user chose), `UnreadDot` and `CountIndicator` (an unread pip or a capped count, alone or on a control's corner) |
| Pane chrome | `PaneHeader`, `Toolbar`, `ToolbarButton`, `OverflowToolbar` (a toolbar that folds what doesn't fit into a menu), `Tabs`, `StatusBar` (the strip along a pane's edge) |
| Navigation | `NavList` (an app's left rail), `Breadcrumbs`, `Stepper` (a wizard's progress), `CommandPalette` (a quick switcher or "jump to…") |
| Page structure | `PaneLayout` (a panel's shell: header, toolbar, one scrolling body, footer and status strip), `Stack`, `Inline`, `Cluster`, `Grid`, `AutoGrid` (as many columns as fit), `ScrollArea` (a scroller on either axis, fading the edges with more) |
| Layout | `Card` (header, body and footer; clickable with `onClick`), `Divider`, `SectionLabel`, `ResizableSplit` (two panes with a draggable divider), `Accordion`, `Disclosure`, `DescriptionList` with `DescriptionListItem` (a record's label and value rows) |
| Editors | `CodeEditor` (Daintree's CodeMirror editor, with the file viewer's theme and find bar), `DiffView` (two texts or a patch, unified or split, with your own hunk actions; `revertHunk` undoes one), `MarkdownEditor` (a comment or notes field with a toolbar and Write and Preview) |
| Panes | `MasterDetail` (a list and its record, one pane when narrow), `SplitGroup` (three or more resizable, collapsible panes), `Inspector` with `InspectorSection` and `PropertyRow` (a compact property panel), `Drawer` and `DrawerToggle` (a panel that slides in within the pane), `GroupedVirtualList` (sticky group headers with counts), `BulkActionBar`, `LoadMoreFooter`, `TaskList` (a queue of jobs), `RefreshOverlay` and `StaleIndicator` (refreshing and old data) |
| Workflows and agent work | `AttachmentChip` and `AttachmentList`, `EntityChip` (a reference to one of your records, deleted and no-access included), `RepeaterField` (structured items edited in place, keyed), `FormErrorSummary` and `UnsavedChangesBar`, `ConnectionCard` (an outside service and its state), `OperationStatus` (queued through partial and unknown), `ToolCallCard`, `StructuredDiff` and `SuggestedValue` (proposed changes, reviewed before they apply), `SourceCitation` and `SourceList`, `DecisionRequest` (a question a run is waiting on) |
| Git and forge | `WorktreePicker`, `WorktreeBadge` and `BranchBadge` (take `host.getWorktrees()` snapshots as they come), `FileIcon`, `FileLink` (opens in the file viewer at a line), `GitStatusBadge` (the change list's M/A/D/R/?/! letters), `CommitRow` and `CommitList`, `IssueRow`, `PullRequestRow` and `ForgeStateBadge` (one forge-neutral look for any provider), `ChecksList` (CI checks by workflow), `DevServerStatus` and `PortLink` |
| Drag and drop | `SortableList` (a list reordered by pointer or keyboard), `Kanban` (columns of cards moved between and within columns, with counts and WIP limits), and `DragDropProvider` with `useDraggable` and `useDroppable` for anything else |
| States and status | `PaneState` (a whole pane's `loading`, `empty` or `error`), `EmptyState`, `Callout` (an inline message; `severity="error"` with a Retry `action` is the error banner, `variant="strip"` the pane-wide band), `Badge`, `Spinner`, `SpinningIcon`, `ProgressBar`, `Skeleton`, `SkeletonBone`, `SkeletonText`, `SkeletonHint`, `SeverityIcon` |
| Overlays | `Dialog`, `ConfirmDialog` (including the destructive typed-name gate), `ConfirmPopover` (an inline confirm on its trigger), `Sheet` (a record's detail or edit form against the window's edge), `Popover`, `PopoverSearchField`, `EmojiPicker`, `Tooltip`, `TruncatedTooltip` |
| Settings | `SettingsSection`, `SettingsGroup`, `SettingsRow`, `SettingsActions` — the host's section → group → row grammar, for settings drawn inside a panel. A [`location: "settings"` view](#a-settings-section) renders `SettingsRow`s only: the host draws the heading and the group, and there is no Save row |
| Behaviour | Hooks: `useSelection` (single, multi and range selection), `useHotkeys` (view-scoped shortcuts that never shadow the app's), `useUndoRedo`, `useDisclosure`, `useDebouncedValue` and `useDebouncedCallback`, `usePersistentViewState` (a remembered tab or split size, through `persistState`), `useToast` (toasts and Undo toasts from the view), `useForm` (form state for `Form`), `useContainerSize` and `useBreakpoint` (layout that answers to the pane's width, not the window's) |
| Daintree-native | `ActionButton` and the menus' `action` entry (run one of Daintree's actions with its own title, binding and availability), `AgentAvatar`, `AgentBadge`, `AgentStateIndicator` (an agent's mark and what was observed on its terminal), `AgentPicker` (the project's agent panes by worktree), `SendToAgentButton` and `ContextDragSource` (hand work to an agent), `TerminalSnapshot` (a still of a terminal's last lines), `ShortcutHint` and `KeyHints` (keys as the app draws them) |
| Everything else | `Markdown`, `Icon`, `Avatar`, `AvatarGroup`, `Kbd`, `KbdChord`; formatters `formatTimeAgo`, `formatRelativeTime`, `formatDuration`, `formatBytes`, `formatCount`; day helpers `formatIsoDate`, `isoToday`, `isoFromDate`, `isoAddDays` for the date fields' `"YYYY-MM-DD"` values; the theme API below (`useDaintreeTheme`, `getDaintreeTheme`, `onDidChangeDaintreeTheme`); `preloadPluginUi` and `whenPluginUiReady` ([Loading and the first frame](#loading-and-the-first-frame)); `PLUGIN_UI_VERSION` ([Versioning](#versioning)) |

One status vocabulary runs through `Badge` `tone`, `Callout` `severity` and `SeverityIcon`: `error` (the same colour as `danger`, which `Badge` also accepts), `warning`, `success`, `info` and `neutral`.

Not in the kit, so draw them with tokens: other chart forms (a graph of nodes, a treemap, a sankey), and a point tooltip on a canvas of your own; the kit charts carry theirs. Read the series colours from the `category-*` tokens with a fallback, in the kit charts' order (`blue`, `amber`, `indigo`, `orange`, `violet`, `teal`), so your chart and theirs agree.

**Never `window.confirm`, `alert` or `prompt` in a view.** A native dialog ignores the theme, blocks the whole window and takes focus from every other panel. `ConfirmDialog` is the view-side confirm, and `ConfirmPopover` the small inline one for an action that is cheap to undo; `host.showConfirm` is the worker's. For feedback after the fact, `useToast` puts a toast (or an Undo toast) in the app's toaster straight from the view.

### Loading and the first frame

Nothing of the kit loads at startup. Importing `@daintreehq/plugin-ui` costs a few hundred bytes and starts fetching the kit's one chunk; until that chunk is in, most components render nothing, so the first kit view in a session can paint one frame late. Fifteen draw a fallback instead, so what they wrap is there from the first frame and only their own behaviour waits:

- **Their trigger:** `Popover`, `EmojiPicker`, `ConfirmPopover`, `AgentPicker`.
- **Their child:** `Tooltip`, `TruncatedTooltip`, `HoverCard`, `ContextMenu`.
- **Their content:** `DragDropProvider`, `Drawer`, `RefreshOverlay`, `ContextDragSource`.
- **The wrapped child:** `UnreadDot`, `CountIndicator`.
- **Its fields:** `Form`.

It is a local chunk, requested at import, and normally in before your view first renders. Two calls control it:

- `preloadPluginUi()` starts loading without waiting — for code that knows a view is about to open.
- `whenPluginUiReady()` resolves once every component renders on its first frame, and rejects if the chunk fails to load (calling again retries). Await it in tests, or before measuring kit output.

### Versioning

`PLUGIN_UI_VERSION` is the kit's semver contract, `"1.0.0"` today. A minor version adds components, optional props, icon names and theme token keys; within a major version no export, prop, accepted value or core token key is removed or narrowed. Every component validates its props at runtime, so a value outside the types — from an older or newer plugin — is ignored rather than thrown on. The kit comes from the running app, so check `PLUGIN_UI_VERSION` before relying on a component a later minor added, and declare an `engines.daintree` that has it: `>=0.41.0` for anything beyond `Markdown`, which is all Daintree 0.40 serves. `engines` is advisory (an unmet range warns and still loads), so read the version through a namespace import rather than trusting the range ([UI kit → Feature detection](./ui-kit.md#versioning-and-stability)).

### Styling kit components

Pass `className` to a kit component to place it — margins, width, flex — and it goes through the same runtime Tailwind as the rest of your view. The parts a kit component opens in a host overlay (a tooltip body, a menu, a select list, a dialog frame) take no `className`: they render outside your style root, where your classes do not apply. The content you put inside them does keep your classes, because the kit re-marks it as yours.

### Icons

`Icon` draws one of Daintree's own icons by name: lucide-style kebab-case names (`git-branch`, `folder-open`, `alert-triangle`, `refresh`, …) plus Daintree's concepts (`worktree`, `daintree`). `size` defaults to 16 px, colour follows `currentColor`, and it is decorative unless you pass `aria-label`. An unknown name renders nothing and warns in development. Most kit props that take an icon accept the same names or an element of your own, such as an inline `<svg>` for a glyph the set lacks. A few take a name only (`PluginIconName`): `Select` options, `Callout`'s `icon`, `DropdownMenu` and `ContextMenu` entries (`action` entries included), `Tabs` items and `SpinningIcon`. The set only grows.

### Theme API for canvas and WebGL

DOM styled with token classes follows a theme switch on its own. Code that paints pixels needs the colours as values, and a theme-change signal:

| Call | Returns |
| --- | --- |
| `useDaintreeTheme()` | `{ colorMode: "dark" \| "light", themeId, tokens }`, and re-renders the component on a theme change |
| `getDaintreeTheme()` | The same, outside React. Cheap to call often: the same frozen object until the theme changes |
| `onDidChangeDaintreeTheme(listener)` | Calls `listener(theme)` after every theme change; returns the unsubscribe |

`tokens` maps each key listed in [UI kit → Theme](./ui-kit.md#theme) (`surface-panel`, `text-primary`, `border-subtle`, `accent-primary`, `status-danger`, `category-blue`, `terminal-red`, `syntax-keyword`, …) to a concrete sRGB colour, `#rrggbb` or `rgba(r, g, b, a)`. It is a fixed set, not every `--theme-*` the host defines: tokens that exist only as CSS — `surface-toolbar`, `surface-dialog`, `surface-disabled`, `border-input`, `accent-secondary` and its variants, the `status-*-surface` fills — are not keys and read as absent, so draw with the nearest key instead. The core groups — surfaces, text, borders, accent, `focus-ring`, status — are stable within the major version; `terminal-*` (with the ANSI colours), `syntax-*`, `activity-*` and `category-*` are best effort and may be renamed in a minor with a release note, so read those with a fallback. Reading `--theme-*` once with `getComputedStyle` is the bug this replaces. [Patterns → Draw on a canvas](./patterns.md#draw-on-a-canvas) puts it together with `useAnimationFrame`.

### Types

For TypeScript, `@daintreehq/plugin-sdk` ships the kit's declaration: `"types": ["@daintreehq/plugin-sdk/plugin-ui"]` in `compilerOptions` (a scaffolded plugin already has it), and every component's props type comes with it (`ButtonProps`, `DataTableProps`, …). The `plugin-ui` type entry: Not in the 0.1.0 release on npm; it ships in the next one.

### `Markdown`

`Markdown` is the renderer behind Daintree's file viewer and Markdown panels: GFM (tables, task lists, strikethrough, autolinks), highlighted code fences, and the app's document typography. Raw HTML in the source is dropped, never rendered, so it is safe for text you did not write.

| Prop | Meaning |
| --- | --- |
| `source` | The Markdown text. Required. |
| `basePath` | Absolute path relative links and images resolve against. A path ending in `.md`, `.markdown`, `.mdx` or `.mkd` is read as the document itself and its directory is used; anything else, or a path ending in `/`, is the directory. Omitted, relative references resolve against `rootPath`. |
| `rootPath` | Absolute directory local images and relative links must stay inside. Defaults to the directory `basePath` resolves to. |
| `className` | Classes for the document's root element. |
| `fontSize` | A rung of the type scale: `2xs` `xs` `sm` `base` `lg` `xl` `2xl` `3xl`. Omitted, the document renders at Daintree's default Markdown size. |
| `align` | `"center"` (the default) centres the document's reading measure in its container, as Daintree's own document views do; `"start"` keeps the measure but sets it against the leading edge, in line with the controls above it — for a preview inside a form or an editor. |

Relative images load from disk over `daintree-file://`, contained to `rootPath`; one that climbs out of it is not requested at all. Relative links open in Daintree's file viewer when they stay inside `rootPath` and do nothing otherwise, and the viewer holds its read to `rootPath` on the real path, so a symlinked directory cannot carry a link outside it; `http(s)` and `mailto` links open in the browser. With neither `basePath` nor `rootPath` — or with a relative one, which is ignored rather than resolved against a renderer with no working directory — the text still renders and relative references resolve nowhere. Select All (Cmd/Ctrl+A) selects the block you last clicked or selected in, so several blocks in one view never compete for it. When a note links to images elsewhere in the project, pass the project root as `rootPath`.

```js
// dist/panel.js — the worker's "note" handler answers { text, path }, where
// `path` is the absolute path it read the file from.
import { createElement, useEffect, useState } from "react";
import { Markdown } from "@daintreehq/plugin-ui";

export default function Notes({ pluginId }) {
  const [note, setNote] = useState(null);
  useEffect(() => {
    let live = true;
    void window.electron.plugin.invoke(pluginId, "note", { name: "today.md" }).then((next) => {
      if (live) setNote(next);
    });
    return () => {
      live = false;
    };
  }, [pluginId]);

  return createElement(
    "div",
    { className: "flex flex-col flex-1 min-h-0 overflow-auto p-4" },
    note ? createElement(Markdown, { source: note.text, basePath: note.path }) : null
  );
}
```

The first `Markdown` in a session renders nothing while the async renderer loads, then the document; later ones render at once.

## Handing work to an agent by drag

A card, a message or a row in your view can be dragged onto an agent terminal — its input bar or the terminal itself — and it lands in that agent's draft for the user to instruct it about. Nothing is submitted. The kit's [`ContextDragSource`](./ui-kit.md#daintree-native-actions-agents-terminals-and-keys) does all of this for you: wrap the card's grip or a chip in it with the text, and it writes the payload below, checks it as the drop will, and keeps clear of kit drags.

```js
createElement(ContextDragSource, { text: card.body, title: card.title, sourceLabel: "Kanban" });
```

Underneath, the drag carries one app-internal type, `application/x-daintree-agent-context`, holding JSON:

```ts
{ v: 1, text: string, title?: string, source?: { label?: string } }
```

`text` is required, non-blank and at most 32,768 characters; `title` at most 120; `source.label` at most 80 (say `"Kanban"`). Set `text/plain` to the same text too, so a drop anywhere else — an editor, another app — still gets something sensible. Without the kit, in a hand-written view with no build step:

```js
createElement(
  "div",
  {
    draggable: true,
    onDragStart: (event) => {
      const payload = { v: 1, title: card.title, text: card.body, source: { label: "Kanban" } };
      event.dataTransfer.setData("application/x-daintree-agent-context", JSON.stringify(payload));
      event.dataTransfer.setData("text/plain", card.body);
      event.dataTransfer.effectAllowed = "copy";
    },
  },
  card.title
);
```

A bundled view can use the SDK helper, which writes all three and throws on a payload the drop would refuse:

```ts
import { setAgentContextDragData } from "@daintreehq/plugin-sdk";

onDragStart={(event) => setAgentContextDragData(event.dataTransfer, { v: 1, title, text })}
```

Kit drags (`SortableList`, `Kanban`, `DragDropProvider`) never carry this payload: they move with pointer events and stay inside the view, so a card on a kit board is reordered, not handed off. To offer both, keep the handoff on a separate element inside the card — a `ContextDragSource` chip, or your own element that sets `draggable` and the payload — and offer **Send to agent…** beside it for the keyboard.

What lands is the same block `host.sendToAgent` drafts: one fenced block tagged `daintree-context`, holding your `source.label` and `title` as a heading (`Kanban: Fix login redirect`) and then the text, appended after whatever the user already typed and kept literal on submit — `@diff` and the other tokens inside it are never expanded. Control characters other than tab and newline are stripped. The drop selects the pane and puts the caret in its input bar, exactly like dropping a file there. Only an agent pane whose input bar can take a draft shows the drop affordance; a plain shell, an exited, docked, locked or restarting agent, one in an armed fleet, or any pane while the input bar is switched off refuses the drag outright, and nothing is ever typed into a terminal. The payload is data, not instructions — anything can start a drag carrying this type, so the host validates it in full at the drop and drops anything malformed: a wrong `v`, blank or oversized text, an over-long `title` or label, or a non-string where a string belongs. Unknown extra keys are ignored.

## Sending work to an agent from a view

A drag is one route; a **Send to agent…** button or menu entry is the other, and the one keyboard users get. It goes through [`host.sendToAgent`](./host-api.md#sendtoagent--hand-work-to-an-agents-draft), which only your worker can call — it is gated on `agent:input` and bound to your plugin's identity, which a view cannot assert. So the view asks the worker over a channel. Register the handler below in the worker, and the kit's [`SendToAgentButton`](./ui-kit.md#daintree-native-actions-agents-terminals-and-keys) is the whole view side — label, busy state and the refusals only you hear about:

```js
// view
createElement(SendToAgentButton, { text: card.body, title: card.title, worktreeId });
```

Written by hand, the same thing is:

```js
// worker (activate)
host.registerHandler("sendToAgent", (_ctx, { text, title, worktreeId, terminalId }) =>
  host.sendToAgent(text, { title, worktreeId, terminalId })
);

// view
const result = await window.electron.plugin.invoke(pluginId, "sendToAgent", {
  text: card.body,
  title: card.title,
  worktreeId, // from PanelViewProps, so the picker opens on this panel's worktree
});
if (
  result.status === "refused" &&
  ["project-unavailable", "prompt-open", "busy"].includes(result.reason)
) {
  // Only these three are reported to you alone; say something in the view.
}
```

To pick the agent inside your own view instead of the host's picker, pass the panes your worker reads with `host.agents.list()` (it needs `agent:read`) to the kit's `AgentPicker`, and send the chosen `terminalId` back to the worker. Without a `terminalId` the user picks the agent — or starts one, here or in a new worktree — and the text lands in its draft as the same block a drop makes, headed with your plugin's display name rather than a label you choose, and never submitted. The call resolves `drafted`, `cancelled` or `refused`; the user already sees why their agent refused, so a view only needs to speak up for the three reasons that concern the plugin. Label the control **Send to agent…**: the ellipsis says a picker comes first. To put it on the panel's ⋯ and right-click menus instead, declare an action in the panel's [`menu`](./contribution-points.md#panel-menu) — it is dispatched with `{ panelId }`, so the worker knows which panel asked.

## Resources your view owns

An unmount frees what your component held and nothing it attached elsewhere. A `window` or `document` listener, an interval, an animation-frame loop, an observer never disconnected, a `Worker`, an object URL and a WebGL context all outlive it unless something releases them, and because `disposeSignal` aborts on every temporary unmount too, a view that forgets gains another set with each maximise or tab switch. WebGL runs out first: Chromium keeps a canvas's context until garbage collection and evicts the oldest once a renderer holds about sixteen.

`createViewScope(disposeSignal)` from `@daintreehq/plugin-sdk/react` ties them to the mount attempt and releases them together, newest first, when the signal aborts or your effect's cleanup calls `dispose()`, whichever comes first:

```tsx
import { createViewScope } from "@daintreehq/plugin-sdk/react";

useEffect(() => {
  const scope = createViewScope(disposeSignal);
  scope.listen(window, "resize", onResize);
  scope.setInterval(refresh, 5_000);
  const observer = new ResizeObserver(onBoxChange);
  observer.observe(boxRef.current!);
  scope.observe(observer);
  const gl = scope.webgl(canvasRef.current!.getContext("webgl2")!);
  void loadScene(gl, { signal: scope.signal });
  return scope.dispose;
}, [disposeSignal]);
```

| Method | Released with |
| --- | --- |
| `listen(target, type, listener, options?)` | `removeEventListener`, with the capture flag it was added with |
| `setTimeout`, `setInterval`, `requestAnimationFrame` | the matching clear or cancel |
| `observe(observer)` | `disconnect()` |
| `worker(worker)` | `terminate()` |
| `objectURL(blob)` | `URL.revokeObjectURL` |
| `webgl(gl)` | `WEBGL_lose_context.loseContext()`, when the context is still live and the extension exists |
| `add(fn)` | calling `fn` |

`listen`, the timers and `add` return a function that releases early. Start an observer before adopting it, as above: a scope that is already disposed disconnects what it adopts on arrival, and an observer started after that would escape it. A timeout, a frame or a `{ once: true }` listener forgets itself as it fires, so a render loop that re-requests frames does not grow the scope. `scope.signal` aborts when the scope does; pass it to `fetch` and anything else signal-aware.

Disposal is idempotent and never throws: a cleanup that throws is logged and the rest still run. Anything registered after disposal, typically from an `await` that settled after the view went away, is released on arrival and logged once, so check `scope.signal.aborted` before a continuation starts new work. Create a fresh scope in each effect setup; a disposed one stays disposed.

`scope.stats()`, and the `onReport` option called once after disposal, count what the scope released, which cleanups threw and what arrived late. They see only what went through the scope, so zero proves nothing about what else the view kept alive; a heap snapshot is the tool for that. Nothing durable belongs here, for the reason `disposeSignal` exists: it belongs in the worker. A zero-build view imports `createViewScope` from `@daintreehq/plugin-sdk/react` like a bundled one.

## Performance

A plugin view shares the renderer — and the main thread — with the whole app, so a slow view is a slow Daintree. The host does its part: views mount only once activation has resolved and without React's Suspense reveal delay, pushes travel batched, and the bursty host subscriptions coalesce by default. What is left is what your view renders and how often. These are the patterns that mattered when naive plugins were measured against ported ones (one machine, one run each — read the numbers as orders of magnitude):

| Instead of | Do | Measured |
| --- | --- | --- |
| `rows.map(…)` over a large result | `DataTable` or `VirtualList` from the kit; `useProgressiveList` for a few hundred rows of your own markup | 10,000 rows: 1.5 s to first paint and 130,027 DOM nodes naive; 490 nodes and a 19 ms sort with `DataTable` |
| One push per item, `setState([...prev, line])` per push | Batch in the worker on a timer; `useStreamBuffer` in the view; `LogView` to render | 20,000 pushes and 20,000 log rows in the DOM naive; 7 pushes and 180 log nodes ported |
| Re-pushing the whole list on every change | `createSyncedCollection` in the worker, `useSyncedCollection` in the view; items that hold what the row shows, a large field fetched on open | 100 tool calls: 1.1 MB in 200 pushes naive; 23 KB in 13 |
| Refetching everything on each change push | `useCachedHostChannel(…, { invalidateOn })`: one refetch per burst | 200 database writes: about 200 full refetches naive |
| A `setInterval` per timestamp | `useNow` and the kit's `formatTimeAgo`; for a seconds tick, `useNow({ intervalMs: 1000 })` and `formatDuration` | — |
| `"activationEvents": ["onStartupFinished"]` for a panel plugin | No `activationEvents`: the worker starts when the panel first opens | an eager dashboard's worker: 72 MB from boot, with no panel open |
| A `requestAnimationFrame` loop and colours read once | `useAnimationFrame` and `useDaintreeTheme` | the naive canvas kept its old background after a theme switch |
| A `readdir` and `readFile` per entry | `host.fs.walk` and `host.fs.readFiles` in the worker | a 2,045-file search: 960 ms naive, 335 ms ported |

The rest of the toolbox, all in `@daintreehq/plugin-sdk/react`:

- **`usePluginEventSelector(pluginId, channel, selector, { initial, isEqual, panelId })`** re-renders only when your slice of a large push changes; `useHostStore` is the same for any store, and `shallowEqual` pairs with selectors that build objects.
- **`useThrottledCallback(callback, { ms })`** commits a replaceable value at most once per frame (or per `ms`), keeping only the latest arguments. Never for lines — they would be dropped; that is `useStreamBuffer`.
- **`useCachedHostChannel(pluginId, channel, args, { staleMs, cacheKey, signal, enabled, invalidateOn, debounceMs })`** paints the cached result first when one is still cached (the 50 least recently used unwatched entries are kept) and revalidates behind it; concurrent mounts share one request.
- **`lazyWithPreload(load)` with `usePreloadOnIntent(Component)`** for a dialog, tab or editor split into its own chunk: preload on hover or focus and it renders in its first frame instead of flashing a fallback.

**First frame.** What the user waits for when a panel opens is activation, the view module's import, style preparation and then your first commit. Keep `activate()` to registrations and start scans without awaiting them; render a shell at once and let data arrive into it (`PaneState kind="loading"` stays blank for its first 400 ms, so a fast load never flashes); keep the first commit small, which is what windowed lists are for. A kit component can paint one frame late the first time the kit loads in a session ([Loading and the first frame](#loading-and-the-first-frame)).

**Lifecycle.** A backgrounded project keeps its views mounted and its timers and frames running ([Project switches and staleness](#project-switches-and-staleness)). `useNow` and `useAnimationFrame` pause while nobody can see the view; anything else periodic belongs in the worker, or needs the cache edges from [Patterns → Refresh when the user comes back](./patterns.md#refresh-when-the-user-comes-back). On the worker side, `host.hasListeners` says whether any view is subscribed to a channel, so a producer can stop while every panel is closed ([Patterns → Subscribe, then pull](./patterns.md#subscribe-then-pull)).

### Measuring your plugin

Daintree measures every plugin as it runs and shows it in two places:

- **The Performance tab** on the plugin's page in Settings → Plugins (a project plugin's entry in Project settings → Plugins has the same section): activation time, the latest view load and first paint (split into activate, import and styles), invoke latency with errors and timeouts, pushes per second and bytes, long frames that coincided with the plugin's activity, and worker memory — each beside its budget. The tab appears once something has been measured. A **Styles** tab lists the classes in your open panels that produced no CSS.
- **`daintree-plugin dev`**, the installed-plugin dev loop, prints the same measurements against the same budgets every two seconds while it watches (`--no-metrics` turns it off). See [Development loop → `daintree-plugin dev`](./dev-loop.md#daintree-plugin-dev). A project plugin, built with its own watcher, reads them in Project settings.

The budgets: activation 500 ms, view load 300 ms, first paint 500 ms, commit p95 16 ms, invoke p95 250 ms, 60 pushes and 1 MiB per second sustained, worker memory 256 MiB. They are observations for this session, not a verdict: a plugin that was active during a slow frame didn't necessarily cause it, invokes that waited on a consent prompt are left out of the latency, and Daintree never slows or stops a plugin for going over a budget. Use them to find what to look at, then profile it in DevTools.

Before shipping, run **`npx daintree-plugin lint`** in the plugin folder (the command: Not in the 0.1.0 release on npm; it ships in the next one.) It reads your view and worker source and flags the patterns above — interval polling in a view, whole-state pushes, a render per event, a subscription never disposed, a bundled copy of React (an error) — and the consistency ones: stock palette colours (an error), `dark:`, raw shadows, radii and text sizes, a hand-rolled button, form control, spinner, badge or icon, a native dialog, a container query on its own container, and classes that compile to nothing. `--strict` fails on warnings too; `daintree-plugin doctor` runs it as part of its checks.

## Media and binary files

`host.fs.readFile` returns UTF-8 text and nothing else. For an image, an audio file or anything binary, don't route the bytes through the worker at all: the renderer reads the file itself over Daintree's file protocols, as the file viewer does. Both take the same query — an absolute `path` and an absolute `root` — and realpath-contain `path` under `root`, answering 404 for anything outside it; the project root is the natural `root` for a project plugin.

**Audio and video: point the element at `daintree-media://`.** It is the scheme Daintree's own audio and video previews play from: media only (a file that isn't audio or video is a 404), served in byte ranges, so the element streams and seeks rather than downloading the whole file first.

```js
// In the view: the same URL shape the file viewer builds.
const src = `daintree-media://load/?path=${encodeURIComponent(absPath)}&root=${encodeURIComponent(projectRoot)}`;
createElement("video", { src, controls: true });
```

The scheme has no `fetch()` surface, only element loads, so a failure shows up as the element's `error` event. To check the file first — that it exists, or its size — send a `HEAD` to the same `path` and `root` on `daintree-file://load?…`, which answers with its `Content-Length` without reading it; the file viewer does exactly that before it mounts a player. A file rewritten in place needs a new URL to play its new bytes, since the element keeps what it has buffered; add a query parameter of your own (`&v=2`), which both schemes ignore.

**Any other binary: fetch from `daintree-file://` into a blob.**

```js
const url = `daintree-file://load?path=${encodeURIComponent(absPath)}&root=${encodeURIComponent(projectRoot)}`;
const blob = await (await fetch(url, { signal: disposeSignal })).blob();
const objectUrl = URL.createObjectURL(blob); // revoke it on cleanup, or use scope.objectURL(blob)
```

An `<img>` can take the `daintree-file://` URL as its `src` directly. Both schemes work because views are inline in Daintree's own document; they are not part of the host API, and a future move to an isolated view host would replace them with one.

## Project switches and staleness

"The user just switched to my project, refresh" is a question the DOM cannot answer, and the obvious answer is wrong in a way that fails silently.

Switching projects does not unmount anything: the outgoing project's `WebContentsView` is detached and marked `setVisible(false)`, its renderer keeps running, and your view stays mounted with its React state intact. Neither of those operations changes page visibility, because Chromium tracks that at the `BrowserWindow` level — so a backgrounded project view goes on reporting whatever its window reports, `document.visibilityState === "visible"` while that window is on screen, and its `requestAnimationFrame` callbacks can keep firing at the full rate. Every gate written as `document.visibilityState !== "visible"` is dead code in a project the user has switched away from, which is how one backgrounded project ended up at 4.5% CPU and 3300 idle wakeups a second (#11212). `document` tells you whether the window is on screen, never whether your project is the one being shown.

The signal that does answer it is main's explicit lifecycle broadcast, which exists precisely because no DOM event covers this. Views are inline, so it is on `window.electron.app`:

| Call | What it means |
| --- | --- |
| `isViewCached()` | Not an event — the current state, latched in preload before any page script ran. This is what you seed from. |
| `onViewCached(cb)` | Main has detached and hidden this project view. Nothing can observe it until it returns: stop periodic work here. |
| `onViewWarmActivated(cb)` | Main has re-attached the view. It may still sit behind the anti-flash bridge where Chromium culls paints, so this means "running again", not "on screen". Fires on **every** reactivation. |
| `onViewRevealed(cb)` | The view is the presenting foreground surface. Sent only when it is still the active project by the time the swap completes, so a switch superseded mid-flight never produces one. |

Four things follow, and the first is the one that bites.

**They are edges, and nothing replays.** A cold switch can be released as early as the pre-React skeleton, so a switch storm can cache the view before your module has evaluated. Seed from `isViewCached()` and subscribe; a subscription alone answers "not cached" forever for a view that was already cached. Clear your own cached flag on `onViewWarmActivated`, not on `onViewRevealed`: warm activation is the cached-to-active edge and precedes presentation, while a reveal is only sent if this project is still the active one when the swap completes — a cold switch that rolls back reactivates the view and sends warm activation alone, so a flag cleared only on reveal can stay demoted with the view running.

**This bridge is the host's own, not part of the plugin API.** It works because views are inline, exactly like `daintree-file://` above, and an isolated view host would replace it. The host's internal wrapper (`src/lib/viewCacheState.ts`, with `usePollingLifecycle` and `useProjectViewRevealed` on top) is what Daintree's own panes use; read it before you build anything elaborate.

**Combine it with document visibility rather than replacing it.** Minimising the window is a real `visibilitychange` — as is being fully covered by another window, on the platforms that report occlusion — and both are independent of caching, so a view can be uncached and unseen. The host's own consumers AND the two together. Whether a backgrounded renderer's timers actually stop varies: main deliberately applies no CPU throttling, and an explicit `Page.setWebLifecycleState` freeze is conditional and is skipped while the cached project has a live agent or an MCP binding — the cases that cost the most. So treat "my timers stopped" and "my timers kept running" as both possible, and demote your own periodic work on `onViewCached` instead of hoping the platform does it for you. A poll that must not miss a beat belongs in the worker, which for a non-builtin plugin is a separate utility process that does not freeze with the view (builtins run in main).

**Memory pressure turns the flip into a fresh mount.** The host can reclaim a backgrounded project view and destroy its renderer. That is not a close — the project stays open and your worker keeps running — but the recreated view mounts from scratch, so the work you do on reveal must be the same work you do on mount or the user gets one of two states depending on whether their renderer survived. The worker is told nothing about the destruction itself: the host drops what that renderer reported rather than synthesizing a `removed` phase, since a reclaimed renderer says nothing about whether the user closed a panel. It does see the recreated view's `mounted`.

[Patterns → Refresh when the user comes back](./patterns.md#refresh-when-the-user-comes-back) is the whole recipe, worker half included.

Worker-side there is no equivalent, and the three subscriptions that look close are not it. `onDidChangePanelLifecycle` reports mount and unmount, which a switch does not cause. `onDidChangeActiveWorktree` fires on worktree activation and, for an unbound plugin, resolves against whichever project is focused — mid-switch that can still be the outgoing one, and the snapshot it hands you carries no `projectId` to check, so confirming which project you are looking at means a `getWorktreesResult()` with `status === "ok"` and a comparison against its `projectId`. `onDidWake` is machine sleep, explicitly machine-scoped. Keep the "is this stale?" decision in the view.

## Global registration survives reload

Views share one document per project view, so anything you put in a browser-global registry is shared by every view in that project — and outlives every reload of the plugin that put it there. Custom elements are the sharp case: `customElements.define` is keyed by name and the spec gives no way to unregister one. The entry belongs to the document, so only replacing the document clears it.

That collides with how reload works. A reload re-imports your bundle under a fresh generation, so your module body runs again — against a registry that still holds the entry the previous generation made. Which failure you get is the library's choice, not yours:

| The library's registration code | What a reload does |
| --- | --- |
| Guards with `customElements.get(name)` — Trix does this | Skips. The first generation's class stays installed and your rebuilt code is silently ignored |
| Registers unconditionally — `@37signals/lexxy` does this | Throws `NotSupportedError`. Where the throw lands decides what you see |

The second row is worse than it reads, because a throw during module evaluation and a throw from a timer are not the same event. Lexxy ends its module body with `setTimeout(defineElements, 0)`, so the `import()` **resolves**, your view mounts normally, and the error surfaces afterwards as an uncaught window error — which the host attributes to the plugin when its source URL or registration stack is known. A global banner names the affected plugins and offers a project-window reload, with an inbox entry as the fallback while a higher-priority banner owns the slot; both survive plugin reloads and main-process status snapshots. What you are left looking at is a live generation-2 module graph driving generation-1 element classes.

The same split applies across plugins rather than across reloads: two plugins vendoring the same element library contend for the same document registry. Earlier successful definitions remain installed, independently of the versions each plugin bundles.

**For elements you define yourself,** register under a name that changes per load so a reload installs genuinely new code, and read the class back off the registry rather than closing over it. Old names stay resident and accumulate, like the module records themselves, until the document is replaced.

**For a vendored library that hardcodes its element names,** you cannot rename `lexxy-editor` from outside the library. The workable pattern is to stop re-evaluating it: use a [document package](./document-packages.md): put the library and the integration that shares object identities with it in a separately built adapter, retained by the host document while your view code reloads normally. Merely stripping the `__dtv-N` segment is insufficient: each plugin load also replaces its opaque `plugin://` authority, and unload invalidates that authority. A module-local cache inside the reloading entry does not survive, and an eager static import defeats the arrangement. That buys a working reload of your own code, not a live upgrade of the library; changing the library itself still needs the document replaced.

Closing and reopening the project replaces the document; switching back to a cached project view does not. So does reloading the project renderer, which is the cheaper option. Both reset the registry, and both reset document-local state across the project. State already persisted through the host can be restored, but in-memory edits and view objects cannot be promised to survive. Save edits before reloading.

Custom elements are the strict case because registration is irreversible. Other globals are name-keyed but not permanent — `window.*` singletons can be reassigned, stylesheets removed, service workers unregistered — so give each an explicit lifetime. A per-view stylesheet or listener belongs to the mount disposer; a shared loader such as Monaco’s belongs to its document package. Shared package initialization must not capture one plugin’s host bridge, credentials, or panel state.

## Working with a live dev preview

`window.electron.sitePreview` lets a view attach to one of the project's running dev-preview panels and receive structured observations from the page inside it — which element was hovered or clicked, and what the page reported about it. SvelteKit Tools is built on it; nothing about it is Svelte-specific.

| Call | What it does |
| --- | --- |
| `listCandidates()` | The dev-preview panels this project could bind to, with any existing binding |
| `bind({ panelId, adapterId, mode })` | Installs the named host-registered guest runtime into the page and returns a binding with a host-issued session id |
| `setMode({ sessionId, mode })` | Switches between `browse` (the page behaves normally) and `select` |
| `getState({ sessionId })`, `detach({ sessionId })` | Read or release the binding |
| `onEvent(cb)` | Guest events with a host-validated envelope, epoch advances, origin-policy suspensions, and detaches |

Things that shape how you use it:

- **It is renderer IPC.** A plugin's main side cannot reach it. The view owns the binding and forwards what it learns to main over its own channels.
- **You name a runtime; you do not supply one.** `adapterId` selects a guest adapter main registered at startup, and main loads that adapter's asset itself. Nothing a view sends becomes script in the page. Adapters are host-owned today: a plugin that wants its own runtime needs one registered in main, not a body on the wire.
- **There is no "evaluate in the page" call, on purpose.** The runtime is installed by the host on every document the preview shows, and the host wraps it in a prelude that addresses and numbers each message. A general evaluate method would hand every renderer-side caller a standing arbitrary-execution channel into whatever site the user is previewing.
- **The host validates the envelope; you validate the payload.** Core checks protocol version, session, epoch, sequence and size, and that the event carries a `type` — plus the shape of the one lifecycle event it acts on, `documentReady`. Everything else in an event is forwarded uninterpreted, so parse `payload.event` against your adapter's own schema before you read a field of it, and drop what fails. That is also why a new adapter needs no change in core: the event union belongs to the adapter, not to `shared/types/ipc/sitePreview.ts`.
- **An adapter runs only where it was declared to.** Every registered adapter carries an origin policy, `local-preview` unless it says otherwise: loopback, `*.localhost`, `*.local` and private-network addresses. The host checks the guest's URL on every install — at bind and after each navigation — and when the preview shows a page outside the policy it withholds the runtime, removes what the previous document left behind, and pushes `{ kind: "origin-policy", suspended: true }`; the binding survives, and the next document back inside the policy installs on its own and pushes `suspended: false`. Show that as an observation, not a fault.
- **Everything from the page is an observation, never an instruction.** The page is an application under development, and it shares the main world with your runtime, so it can forge messages for its own binding. That reaches nothing beyond that binding's observations — the host validates session, epoch, sequence and size — but never act on a file path, range or revision a page supplied without resolving it yourself.
- **Key state on each event's `documentEpoch`, not on arrival order.** The new runtime's own ready event for a document can arrive before the host's epoch-advance notice for it. A hot-module update that does not navigate does not advance the epoch at all, so "the page reloaded" and "the page shows your latest source" are different claims.

The mechanism — CDP binding, prelude, validation — is described in [`docs/architecture/sveltekit-site-builder.md`](../architecture/sveltekit-site-builder.md).

## Built-in plugin views

A built-in plugin's view is compiled into the host bundle, so some of this page reads differently for it. [Architecture → Built-in plugin views](./architecture.md#built-in-plugin-views) covers registration; these are the practical differences once it renders:

- **It may import host modules.** `@/store/...` and `@/components/ui/...` resolve normally. Follow the host's store rules: cross-store reads go through `src/store/storeAccessors.ts`, and nothing imports a partner store at module evaluation.
- **Finding your worktree.** `PanelViewProps.worktreeId` is the worktree the panel was spawned with (`undefined` for a panel spawned without one), so start there rather than dispatching `worktree.getCurrent`, which answers for the _visible_ worktree and is wrong for a background or restored panel. To turn it into a path, read the worktree store. A plugin view is not guaranteed to sit under the worktree store's provider, so use the optional accessor (`useWorktreeStoreOptional`) with `getWorktreePathIndex()` as a fallback — the non-optional hook throws there. The project id comes from the project store.
- **Styling is the host's Tailwind.** The per-plugin runtime stylesheet described above does not run for a built-in; you get the host's full design system and must follow its rules — `.claude/rules/design-system.md` in the repo.
- **Registering a `lazy()` view is fine.** The host wraps every built-in view in its own `lazy()` for activation; it renders yours from a plain component so React never sees a lazy resolving to a lazy (error #306).
- **Never alias a lowercase component binding to a capitalised name for JSX.** The React Compiler folds `const View = component; return <View />` back into `jsx("component")`, which renders an unknown `<component>` DOM element — no error, just an empty panel. Use `createElement(component, props)`.
- **Extending the dev preview.** A built-in can add a toolbar toggle, a strip and a drawer to every dev preview with `registerDevPreviewTool` (`src/registry/devPreviewToolRegistry.ts`) instead of contributing a panel. The host mounts them with the preview's panel, project, worktree, URL and readiness; the tool decides whether its button applies to that preview. [Dev preview tools](#dev-preview-tools) below is the lifecycle.
- **React Compiler applies to you.** A bailout is silent at runtime and reddens the compiler budget. Two traps specific to controller-style views: never call a method that reads mutable controller state during render — pass a `useSyncExternalStore` snapshot to a pure function instead — and do not write a `try`/`finally` without a `catch` in a component.

## Dev preview tools

A dev preview tool is one registration — `registerDevPreviewTool({ id, pluginId, label, Button, isAvailable?, unavailableReason?, createSession?, Toolbar?, Drawer? })` — and one entry in `useDevPreviewToolStore.activeByPanel`, which holds the tool a preview has switched on, one at a time per panel.

**The manifest admits it.** The registration supplies the components (they are host-bundled, so nothing else can), but the tool only reaches the toolbar when its plugin's manifest declares the same id under [`contributes.previewTools`](./contribution-points.md#preview-tools--shipped-built-in-only). A registered tool no manifest names stays hidden and logs once, so a renamed id is diagnosable rather than a button that silently disappeared. Built-in plugins only, for now.

**One availability answer.** `isAvailable(context)` decides whether the tool applies to a preview at all, and it may be async. The host hides the toolbar toggle where it says no and refuses `devPreview.toggleTool` there with your `unavailableReason`, so a palette entry or an agent can never switch on what the toolbar is hiding. It is asked again whenever the preview's worktree, page or readiness changes — a project that grows an app while the preview is open starts offering the tool — and cache your own lookups if they are expensive. Two things the host guarantees: a tool already switched on keeps its toggle while the predicate is unanswered, so the one control that turns it off never vanishes; and switching a tool **off** is never refused. A command runs away from the pane, so the context it evaluates carries the panel's last recorded URL and `isWebviewReady: false` — answer on the worktree, not the live page.

**The host owns the session.** Declare `createSession(context)` and the host calls it when the tool is switched on for a preview — before any surface mounts — and hands the result to the surfaces as `props.session`. It may return a promise, which is how a tool keeps its real implementation in a lazy chunk; the surfaces are not mounted until the session exists. Check `context.signal.aborted` before building anything expensive: a promise that resolves after the preview let go is disposed immediately, and a factory that throws switches the tool back off. The session is what holds the tool's state for that preview: a binding, a workspace, a selection, a draft.

**What the session is told.** The context is live: `panelId`, `projectId`, `worktreeId`, `worktreePath`, `url`, `isWebviewReady`, `visible` (whether any of the tool's surfaces are mounted), and an `AbortSignal` aborted on disposal. Changes arrive through `update(context)` for as long as the session lives. The page and worktree half comes from the preview's pane, so a fully unmounted preview holds the last of it rather than fresh news; what a session sees while nothing is mounted is that snapshot plus `visible: false`.

**What ends it.** `dispose()` runs when the tool is switched off, the preview is trashed or removed, or the owning plugin is disabled — the last two also clear the active entry, so a restored preview comes back plain. Nothing else does: a surface unmounting is not one of them, because a hidden dock tab, a maximised sibling and a grid remount all unmount surfaces without ending anything the user started. Put every teardown in `dispose()` and treat it as the only teardown.

**The drawer's chrome is the host's.** Your `Drawer` fills a host-owned frame (`src/components/DevPreview/DevPreviewToolDrawerChrome.tsx`) and declares nothing about its own width: no width classes, no `@container` — the chrome declares `@container/drawer`, so your rows still answer to the drawer's real width. The frame is 360px by default and drag-resizable between 280px and 560px from its page-facing edge (the width is shared by every preview for the session); in a preview too narrow to share it floats over the page instead, capped so a strip of the page always stays clear, which can render it below the nominal minimum. It hides itself entirely while your drawer renders nothing, which is how a tool stays shut until it has something to say. The policy for a cramped preview is the host's too: while docking the drawer would leave the page under 480px, the drawer floats over the page instead of squeezing it — a page pushed through its own responsive breakpoints stops being the thing the user is building. Closing a tool from inside one of its surfaces returns focus to the toolbar toggle that opened it.

**What the surfaces are for.** Rendering the session and calling it. They may not own its lifetime, and they should not reconstruct host events from the panel store or the tool store — the session hears those from the host. `src/services/devPreviewTools/sessionManager.ts` is the implementation, and SvelteKit Tools is the worked example.

## What doesn't work inline

- Bare npm imports in a raw view. Only the five React specifiers above, the tour's four (`@daintreehq/tour`, `@daintreehq/tour/react`, `@daintreehq/tour/kit`, `@daintreehq/tour/mock-app`), [`@daintreehq/plugin-ui`](#host-ui-components) and [`@daintreehq/plugin-sdk/react`](#the-sdks-react-hooks) resolve through the host import map; everything else must be a relative module you ship in `dist/`, or you bundle. The tour specifiers resolve to the host's own tour instance, so a scene's `useCue` sees the host's player — `@daintreehq/plugin-vite` leaves them external for the same reason. Install `@daintreehq/tour` as a dev dependency for its types; its runtime always comes from the host. The tour module loads when a scene first imports it, not at startup.
- TypeScript, JSX or CSS files without a build. Hand-written views use `createElement` and a `<style>` string.
- Reaching into Daintree's React components. Only what [`@daintreehq/plugin-ui`](#host-ui-components) exports is served to plugins; the ones you can find by path are internal and will move.
- Module-scope state surviving a plugin reload. Each full plugin load mints a fresh view generation for the next import; keep anything worth keeping in `persistState` (survives remounts and reloads; `usePersistentViewState` from the kit is the `useState`-shaped way to use it) or `host.storage` (survives everything). A `daintree-plugin dev` rebuild is a full load, so it drops module-scope state and picks up view edits like any other reload (#12277); see [Contribution points → Worker reload vs. view-module replacement](./contribution-points.md#worker-reload-vs-view-module-replacement) for the mechanism.
