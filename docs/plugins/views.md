# Views: what you get in the DOM

A plugin view is a React component the renderer mounts inside a panel. This page is what that component can rely on, what it can't, and how to make it look like it belongs. It applies equally to a project plugin's hand-written `dist/panel.js` and to a bundled `@daintreehq/plugin-vite` view; the differences are called out where they exist.

## Where you render

Views render **inline** in Daintree's React tree, not in an iframe. Same document, same CSS cascade, same `:root` custom properties, same React instance. That is what makes the styling below possible, and it is also why a view has the same reach as Daintree's own UI, including the full `window.electron` bridge. The [trust model](./trust-model.md) covers what that means; this page covers what to do with it.

The host mounts your default export under an error boundary and a `Suspense` boundary, inside a container that is `flex flex-col flex-1 min-h-0 w-full`. Make your root element fill it: `height: 100%` with `display: flex; flex-direction: column; min-height: 0` is the shape that scrolls correctly, because `min-height: 0` is what lets a flex child shrink below its content and hand the overflow to an inner scroller. A root that is only `height: 100%` will push the panel's own scrollbar around instead of owning it.

You receive [`PanelViewProps`](./contribution-points.md#views--shipped-panel-surface): `panelId`, `pluginId`, `disposeSignal`, `panelRemovedSignal`, `initialArgs`, `persistState`. Two of these are misread in every first plugin. `pluginId` is your host-side id, which for a project plugin is the instance key, not your manifest name; pass it through to the bridge as given. `disposeSignal` aborts on every unmount, including the temporary ones (a sibling pane maximised, a dock tab left), so it is for cancelling fetches, never for deciding something is finished.

A render error shows the host's diagnostics pane with a Try again that re-imports the module, Close panel, Copy diagnostics and View logs. The rest of Daintree keeps working.

## Styling

Every colour, radius, font and spacing in Daintree is a CSS custom property, and your view sees all of them. Build on the tokens and the panel follows the active theme, light or dark, with no work on your side. The names that matter most:

| Family | Examples | Use for |
| --- | --- | --- |
| Surfaces | `--color-surface`, `--color-surface-canvas`, `--color-surface-active`, `--color-surface-dialog` | Backgrounds, hover and selected rows |
| Text | `--color-text-primary`, `--color-text-secondary`, `--color-text-muted`, `--color-text-placeholder`, `--color-text-link` | Body, labels, hints. `--color-text-muted` has no contrast floor in dark themes; keep it to decoration, never to something the user has to read |
| Borders and overlays | `--color-border-subtle`, `--color-overlay` | Dividers, backdrops |
| Category colour | `--color-category-<hue>-subtle`, `-text`, `-border` and `--theme-category-<hue>` (`amber`, `blue`, `cyan`, `green`, `indigo`, `orange`, `pink`, `purple`, `rose`, …) | Chips, stage badges, the panel `color` in your manifest |
| Shape and type | `--radius-md`, `--font-mono`, `--text-2xs`, `--text-3xs` | Radii, code, the micro-label sizes Daintree's own chrome uses |

`src/index.css` in the Daintree repo is the authoritative list; grep it for `--color-` when you need one that isn't here.

Two rules from the design contract that apply to plugins as much as to the host: accent colour is at most one load-bearing signal per region, so in doubt use no accent; and a plugin panel that reads as native copies the host's own treatments for rows, chips, section labels and subtle buttons rather than inventing new ones. The components under `src/components/ui/` and the file browser are the reference.

**A `<style>` element works.** Ship your stylesheet as a string and inject it once from the view; it lands in the same document and the cascade applies. Scope selectors under a class on your root so you don't restyle the host.

**Tailwind utility classes do not work.** The host is built with Tailwind v4, which emits only the classes Daintree's own source uses. A class your view uses that the host happens to use too will style itself; one it doesn't will do nothing, and which is which changes with every Daintree release. Treat the utilities as unavailable and write CSS on the tokens.

**Icons.** There is no icon component to import in a raw view. Inline SVG (lucide's paths are what Daintree uses) with `currentColor` is the portable answer; the `iconId` in your manifest covers the panel tab and toolbar, not the inside of your view.

## Getting data in

Nothing reaches a view unless the worker sends it. The bridge is `window.electron.plugin`:

| Call | Direction | Pairs with |
| --- | --- | --- |
| `invoke(pluginId, channel, ...args)` | View asks, worker answers | `host.registerHandler(channel, (ctx, ...args) => …)` |
| `on(pluginId, channel, cb)` | Worker pushes to every open instance of the kind | `host.postToPanel(channel, payload)` |
| `onPanel(pluginId, channel, panelId, cb)` | Worker pushes to one instance | `host.postToPanel(channel, payload, panelId)` |

`on` and `onPanel` return an unsubscribe function; return it from your effect. Pushes are not buffered: a push during `activate()` is gone before any view mounts, so the shape that works is pull on mount, then subscribe to pushes for updates. [Patterns](./patterns.md#pull-on-mount-then-push) has the code.

A bundled view gets the same three calls as hooks: `useHostChannel`, `usePluginEvent`, `usePluginPanelEvent` from `@daintreehq/plugin-sdk/react`. A raw `plugin://` view cannot import that subpath (the host import map serves only `react`), so it uses the bridge directly.

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

- Bare npm imports in a raw view. Only `react` resolves through the host import map; everything else must be a relative module you ship in `dist/`, or you bundle.
- TypeScript, JSX or CSS files without a build. Hand-written views use `createElement` and a `<style>` string.
- Reaching into Daintree's React components. They are not exported to plugins, and the ones you can find by path are internal and will move.
- Module-scope state surviving a reload. Each reload re-imports your bundle under a fresh generation; keep anything worth keeping in `persistState` (survives remounts and reloads) or `host.storage` (survives everything).
