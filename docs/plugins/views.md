# Views: what you get in the DOM

A plugin view is a React component the renderer mounts inside a panel. This page is what that component can rely on, what it can't, and how to make it look like it belongs. It applies equally to a project plugin's hand-written `dist/panel.js` and to a bundled `@daintreehq/plugin-vite` view; the differences are called out where they exist.

## Where you render

Views render **inline** in Daintree's React tree, not in an iframe. Same document, same CSS cascade, same `:root` custom properties, same React instance. That is what makes the styling below possible, and it is also why a view has the same reach as Daintree's own UI, including the full `window.electron` bridge. The [trust model](./trust-model.md) covers what that means; this page covers what to do with it.

The host mounts your default export under an error boundary and a `Suspense` boundary, inside a container that is `flex flex-col flex-1 min-h-0 w-full`. Make your root element fill it: `height: 100%` with `display: flex; flex-direction: column; min-height: 0` is the shape that scrolls correctly, because `min-height: 0` is what lets a flex child shrink below its content and hand the overflow to an inner scroller. A root that is only `height: 100%` will push the panel's own scrollbar around instead of owning it.

You receive [`PanelViewProps`](./contribution-points.md#views--shipped-panel-surface): `panelId`, `pluginId`, `disposeSignal`, `panelRemovedSignal`, `initialArgs`, `persistState`, `styleRootAttributes`. Two of these are misread in every first plugin. `pluginId` is your host-side id, which for a project plugin is the instance key, not your manifest name; pass it through to the bridge as given. `disposeSignal` aborts on every unmount, including the temporary ones (a sibling pane maximised, a dock tab left), so it is for cancelling fetches, never for deciding something is finished.

A render error shows the host's diagnostics pane with a Try again that re-imports the module, Close panel, Copy diagnostics and View logs. The rest of Daintree keeps working.

## Styling

**Tailwind utility classes are how you style a plugin view.** Write `className="flex gap-2 p-4 bg-surface-panel"` and it works — in a hand-written `dist/panel.js` exactly as in a bundled view, with no build step and no configuration on your side.

Daintree compiles the classes your view uses at runtime, in the renderer, against the host's own Tailwind and the host's own theme. Two consequences worth understanding, because they are what the rest of this section follows from:

- **You get Daintree's vocabulary, not Tailwind's stock one.** The design system is enforced by the compiler. `bg-surface-panel` compiles; `bg-red-500` compiles to nothing at all, because the host's theme deletes the stock palette. This is deliberate — it is what keeps plugin panels looking like the app.
- **The generated rules are scoped to your view.** They apply inside the element the host marks as your style root and nowhere else, so a plugin can never restyle host chrome.

Semantic colours resolve to live theme variables, so a panel built on them follows a theme switch with no work on your side. Ordinary layout, spacing, sizing, typography, flexbox, grid, state variants (`hover:`, `focus-visible:`, `disabled:`, `group-hover:`), arbitrary values (`w-[327px]`), dynamic scales (`grid-cols-47`) and container queries all behave exactly as Tailwind documents them.

**Not part of the vocabulary:** stock palette colours (`bg-red-500`, `text-blue-600`); `dark:` — Daintree themes are runtime tokens, not a class, so a semantic token is already theme-aware and `dark:` is never the answer; `prose` (`@tailwindcss/typography` is not in the plugin contract); `@apply`, which needs a build step this path does not have.

Prefer **container queries** (`@container`, `@sm:`, `@md:`) over viewport breakpoints (`sm:`, `md:`). A breakpoint describes the whole window; your panel is one pane in a grid and can be narrow while the window is wide.

### The vocabulary

<!-- BEGIN generated: plugin-style-vocabulary -->

**Surfaces** — `bg-`, `border-`, `text-`

`surface-canvas` `surface-sidebar` `surface-toolbar` `surface-panel` `surface-panel-elevated` `surface-dialog` `surface-grid` `surface-input` `surface-inset` `surface-hover` `surface-active` `surface-disabled` `surface-highlight`

**Text** — `text-`

`text-primary` `text-secondary` `text-muted` `text-placeholder` `text-inverse` `text-link`

**Borders** — `border-`, `divide-`, `ring-`

`border-default` `border-subtle` `border-strong` `border-divider` `border-interactive`

**Status** — `bg-`, `text-`, `border-`

`status-success` `status-warning` `status-danger` `status-info` `status-danger-surface` `status-success-surface` `status-warning-surface` `status-info-surface` `status-error` `status-error-surface`

**Accent** — `bg-`, `text-`, `border-`

`accent-primary` `accent-hover` `accent-foreground` `accent-primary-foreground` `accent-soft` `accent-muted` `accent-secondary` `accent-secondary-soft` `accent-secondary-muted`

**Radii** — `rounded-`

`xs` `sm` `md` `lg` `xl` `2xl` `3xl` `4xl`

**Type scale below Tailwind's floor** — `text-`

`2xs` `3xs` `4xs`

**Durations** — `duration-`

`75` `100` `120` `150` `200` `250` `300`

**Easings** — `ease-`

`snappy` `spring-critical` `out-expo` `exit` `panel-minimize`

**Category hues** — `bg-`, `text-`, `border-`, as `category-<hue>` plus a variant suffix

hues: `blue` `purple` `cyan` `green` `amber` `orange` `teal` `indigo` `rose` `pink` `violet` `slate`

variants: `(bare)` `-subtle` `-text` `-border`

**Custom variants** — write as `variant:utility`

`reduce-motion:`

<!-- END generated: plugin-style-vocabulary -->

Everything else Tailwind ships that does not name a colour works too — this list is the part that is Daintree's rather than Tailwind's.

### Copy-ready shapes

```jsx
// Panel root. `flex flex-col flex-1 min-h-0` is what makes an inner scroller own
// the overflow instead of pushing the panel's own scrollbar around.
<div className="flex flex-col flex-1 min-h-0 bg-surface-panel text-text-primary">

// Row
<div className="flex items-center gap-2 px-3 py-2 hover:bg-surface-hover">

// Subtle button
<button className="rounded-md border border-border-subtle px-3 py-1.5 text-xs hover:bg-surface-hover">

// Badge
<span className="rounded-full bg-surface-inset px-2 py-0.5 text-2xs text-text-muted">
```

**Conditional classes must be complete strings.** `isActive ? "bg-surface-active" : ""` works. `` `bg-surface-${tone}` `` does not — the compiler sees the class in your source or in the DOM, and a name assembled from fragments exists in neither until it is too late to matter. The same rule applies to a lookup table, which is fine, and to string concatenation, which is not.

**Portals need a marked container.** Anything you render with `createPortal` leaves your style root, so its classes generate CSS that never matches. Spread `styleRootAttributes` from `PanelViewProps` onto the container:

```jsx
createPortal(
  <div {...styleRootAttributes} className="p-4 bg-surface-dialog">
    …
  </div>,
  document.body
);
```

**A `<style>` element still works**, for the things utilities do not cover — a keyframe, a complex selector, a third-party widget's stylesheet. Scope your selectors under a class on your root so you don't restyle the host. Do not ship compiled Tailwind CSS: `@daintreehq/plugin-vite` fails the build if you wire Tailwind into it, because two independently-compiled copies of the same utilities lose Tailwind's own ordering rules.

**Custom properties are still there** if you prefer to write plain CSS on tokens. Every `--theme-*` and `--color-*` the host defines is readable from your view; `src/styles/design-contract.css` in the Daintree repo is the authoritative list.

Two rules from the design contract that apply to plugins as much as to the host: accent colour is at most one load-bearing signal per region, so in doubt use no accent; and a plugin panel that reads as native copies the host's own treatments for rows, chips, section labels and subtle buttons rather than inventing new ones. The components under `src/components/ui/` and the file browser are the reference.

**Icons.** There is no icon component to import in a raw view. Inline SVG (lucide's paths are what Daintree uses) with `currentColor` is the portable answer; the `iconId` in your manifest covers the panel tab and toolbar, not the inside of your view.

## Getting data in

Nothing reaches a view unless the worker sends it. The bridge is `window.electron.plugin`:

| Call | Direction | Pairs with |
| --- | --- | --- |
| `invoke(pluginId, channel, ...args)` | View asks, worker answers | `host.registerHandler(channel, (ctx, ...args) => …)` |
| `on(pluginId, channel, cb)` | Worker pushes to every `on` subscriber for this plugin and channel — across all its panel kinds, not one kind | `host.postToPanel(channel, payload)` |
| `onPanel(pluginId, channel, panelId, cb)` | Worker pushes to one instance | `host.postToPanel(channel, payload, panelId)` |

`on` and `onPanel` return an unsubscribe function; return it from your effect. Pushes are not buffered: a push during `activate()` is gone before any view mounts, so the shape that works is pull on mount, then subscribe to pushes for updates. [Patterns](./patterns.md#pull-on-mount-then-push) has the code.

A bundled view gets the same three calls as hooks: `useHostChannel`, `usePluginEvent`, `usePluginPanelEvent` from `@daintreehq/plugin-sdk/react`. A raw `plugin://` view cannot import that subpath — the host import map serves exactly five specifiers (`react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom`, `react-dom/client`) and nothing else — so it uses the bridge directly.

## Media and binary files

`host.fs.readFile` returns UTF-8 text and nothing else. For an image, an audio file or anything binary, don't route the bytes through the worker at all: the renderer can fetch the file itself over the `daintree-file://` protocol, which is how Daintree's own audio and video previews work (`useMediaBlobUrl` in the repo).

```js
// In the view. `root` must be a root the protocol may serve from: the project
// root is the one a project plugin has. The handler realpath-contains `path`
// under `root` and refuses anything outside it.
const url = `daintree-file://load?path=${encodeURIComponent(absPath)}&root=${encodeURIComponent(projectRoot)}`;
const blob = await (await fetch(url, { signal: disposeSignal })).blob();
const objectUrl = URL.createObjectURL(blob); // <audio src={objectUrl}>; revoke it on cleanup
```

Fetch into a blob rather than pointing an element's `src` at the URL directly; the blob path is the one the host has verified against Electron's media pipeline. This works because views are inline; it is not part of the host API, and a future move to an isolated view host would replace it with one.

## What doesn't work inline

- Bare npm imports in a raw view. Only the five React specifiers above resolve through the host import map; everything else must be a relative module you ship in `dist/`, or you bundle.
- TypeScript, JSX or CSS files without a build. Hand-written views use `createElement` and a `<style>` string.
- Reaching into Daintree's React components. They are not exported to plugins, and the ones you can find by path are internal and will move.
- Module-scope state surviving a plugin reload. Each full plugin load mints a fresh view generation for the next import; keep anything worth keeping in `persistState` (survives remounts and reloads) or `host.storage` (survives everything). The `daintree-plugin dev` hot-reload path only respawns the worker, so already imported view modules retain their module-scope state and do not pick up edits (#12277); see [Contribution points → Worker reload vs. view-module replacement](./contribution-points.md#worker-reload-vs-view-module-replacement) for the mechanism and the workaround.
