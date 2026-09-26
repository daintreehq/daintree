# Views: what you get in the DOM

A plugin view is a React component the renderer mounts inside a panel. This page is what that component can rely on, what it can't, and how to make it look like it belongs. It applies equally to a project plugin's hand-written `dist/panel.js` and to a bundled `@daintreehq/plugin-vite` view; the differences are called out where they exist.

## Where you render

Views render **inline** in Daintree's React tree, not in an iframe. Same document, same CSS cascade, same `:root` custom properties, same React instance. That is what makes the styling below possible, and it is also why a view has the same reach as Daintree's own UI, including the full `window.electron` bridge. The [trust model](./trust-model.md) covers what that means; this page covers what to do with it.

The host mounts your default export under an error boundary and a `Suspense` boundary, inside a container that is `flex flex-col flex-1 min-h-0 w-full`. Make your root element fill it: `height: 100%` with `display: flex; flex-direction: column; min-height: 0` is the shape that scrolls correctly, because `min-height: 0` is what lets a flex child shrink below its content and hand the overflow to an inner scroller. A root that is only `height: 100%` will push the panel's own scrollbar around instead of owning it.

You receive [`PanelViewProps`](./contribution-points.md#views--shipped-panel-surface): `panelId`, `pluginId`, `worktreeId`, `disposeSignal`, `panelRemovedSignal`, `initialArgs`, `stateVersion`, `persistState`, `requestReload`, `setHasUnsavedChanges`, `styleRootAttributes`. Two of these are misread in every first plugin. `pluginId` is your host-side id, which for a project plugin is the instance key, not your manifest name; pass it through to the bridge as given. `disposeSignal` aborts on every unmount, including the temporary ones (a sibling pane maximised, a dock tab left), so it is for cancelling fetches, never for deciding something is finished. `stateVersion` says which shape `initialArgs` holds, and is only meaningful once you declare `stateVersion` on the panel contribution — see [panel state versioning](./contribution-points.md#panels--shipped).

A render error shows the host's diagnostics pane with a Try again that re-imports the module, Close panel, Copy diagnostics and View logs. The rest of Daintree keeps working.

## Reloading a view

`requestReload()` asks the host to throw away the view you are running and mount a new one for the same panel. Use it when a view has built up more than it can shed — a long session of rendering, caches that only grow — and starting over is simpler than cleaning up in place. Your plugin's backend keeps running throughout.

What a reload is, plainly: a new React attempt using the module that is already loaded. The current attempt's `disposeSignal` aborts and its React cleanup runs; the new attempt gets a fresh `disposeSignal` and fresh DOM, and `initialArgs` holds the latest state the host accepted through `persistState`, with its `stateVersion`. `panelId`, `panelRemovedSignal` (the same object, still open), the panel's place in the layout and the backend all carry over. The module is reused, not evaluated again.

What a reload is not: module-scope variables, anything registered document-wide and anything you attached to `window` survive it untouched, so it frees only what your cleanup releases. It makes no promise about reclaiming memory, and it cannot rescue a view that is blocking the renderer — a stuck render loop never gets as far as asking.

It is a request. The host may refuse it, nothing tells you whether or when the new attempt mounted, and calls in the same tick coalesce into one reload. The callback belongs to the attempt that received it, so one you held on to after your view was torn down does nothing. The host polices loops: a fourth reload within 30 seconds of three accepted ones stops the view and shows the user an error with a Reload panel action, and automatic reloads stay off until the user uses it. Plugin panels get `requestReload` whether they sit in the grid, the dock or a dialog; a project surface does not, so call it optionally. Your backend can ask for the same thing with [`host.reloadPanel(panelId)`](./host-api.md#reloadpanel), which draws on the same budget.

The user can reload the panel too, from Reload panel in its menus and dialog header, and an agent can through the host's tools. That reload is the same new attempt, it is never rationed, and it is what lifts a stopped view. It does not ask first, because what you persisted comes back. If your view holds work it has not persisted — an unsaved draft, a half-filled form — call `setHasUnsavedChanges(true)` while it does and `setHasUnsavedChanges(false)` once it is saved or dropped; while it is set, the user is asked to confirm before the view is discarded, whichever way the reload was asked for. Your own `requestReload` is never held up by it. Like `requestReload`, the setter belongs to its attempt, a new attempt starts with nothing unsaved, and it is absent where there is no reload to guard.

## Styling

**Tailwind utility classes are how you style a plugin view.** Write `className="flex gap-2 p-4 bg-surface-panel"` and it works — in a hand-written `dist/panel.js` exactly as in a bundled view, with no build step and no configuration on your side.

Daintree compiles the classes your view uses at runtime, in the renderer, against the host's own Tailwind and the host's own theme. Two consequences worth understanding, because they are what the rest of this section follows from:

- **You get Daintree's vocabulary, not Tailwind's stock one.** The design system is enforced by the compiler. `bg-surface-panel` compiles; `bg-red-500` compiles to nothing at all, because the host's theme deletes the stock palette. This is deliberate — it is what keeps plugin panels looking like the app.
- **The generated rules are scoped to your view.** They apply inside the element the host marks as your style root and nowhere else, so a plugin can never restyle host chrome.

Semantic colours resolve to live theme variables, so a panel built on them follows a theme switch with no work on your side. Ordinary layout, spacing, sizing, typography, flexbox, grid, state variants (`hover:`, `focus-visible:`, `disabled:`, `group-hover:`), arbitrary values (`w-[327px]`), dynamic scales (`grid-cols-47`) and container queries all behave exactly as Tailwind documents them.

**Not part of the vocabulary:** stock palette colours (`bg-red-500`, `text-blue-600`); `dark:` — Daintree themes are runtime tokens, not a class, so a semantic token is already theme-aware and `dark:` is never the answer; `prose` (`@tailwindcss/typography` is not in the plugin contract; for rendered Markdown use [`Markdown`](#host-ui-components), which brings the host's document styles with it); `@apply`, which needs a build step this path does not have.

Prefer **container queries** (`@container`, `@sm:`, `@md:`) over viewport breakpoints (`sm:`, `md:`). A breakpoint describes the whole window; your panel is one pane in a grid and can be narrow while the window is wide.

### The vocabulary

<!-- BEGIN generated: plugin-style-vocabulary -->

**Surfaces** — `bg-`, `border-`, `text-`

`surface-canvas` `surface-sidebar` `surface-toolbar` `surface-panel` `surface-panel-elevated` `surface-dialog` `surface-grid` `surface-input` `surface-inset` `surface-hover` `surface-active` `surface-disabled` `surface-highlight`

**Text** — `text-`

`text-primary` `text-secondary` `text-muted` `text-placeholder` `text-inverse` `text-link`

**Borders** — `border-`, `divide-`, `ring-`

`border-default` `border-subtle` `border-strong` `border-divider` `border-interactive` `border-input`

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

A bundled view gets the same three calls as hooks: `useHostChannel`, `usePluginEvent`, `usePluginPanelEvent` from `@daintreehq/plugin-sdk/react`. A raw `plugin://` view cannot import that subpath — the host import map serves exactly the five React specifiers (`react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom`, `react-dom/client`), the tour's four (`@daintreehq/tour`, `@daintreehq/tour/react`, `@daintreehq/tour/kit`, `@daintreehq/tour/mock-app`) and [`@daintreehq/plugin-ui`](#host-ui-components), and nothing else — so it uses the bridge directly.

## Host UI components

`@daintreehq/plugin-ui` is Daintree's own UI, served to your view through the same import map as React: the host's components running from the host's code, styled with the host's tokens, so they look like the app in every theme without you shipping or styling anything. A zero-build view imports it like `react`; a `@daintreehq/plugin-vite` build leaves it external, because there is no package to bundle — the implementation only exists inside the running app. It loads the first time a view renders one of its components, never at startup.

It exports one component today.

**`Markdown`** is the renderer behind Daintree's file viewer and Markdown panels: GFM (tables, task lists, strikethrough, autolinks), highlighted code fences, and the app's document typography. Raw HTML in the source is dropped, never rendered, so it is safe for text you did not write.

| Prop | Meaning |
| --- | --- |
| `source` | The Markdown text. Required. |
| `basePath` | Absolute path relative links and images resolve against. A path ending in `.md`, `.markdown`, `.mdx` or `.mkd` is read as the document itself and its directory is used; anything else, or a path ending in `/`, is the directory. |
| `rootPath` | Absolute directory local images and relative links must stay inside. Defaults to the directory `basePath` resolves to. |
| `className` | Classes for the document's root element. |
| `fontSize` | A rung of the type scale: `2xs` `xs` `sm` `base` `lg` `xl` `2xl` `3xl`. Omitted, the document renders at Daintree's default Markdown size. |

Relative images load from disk over `daintree-file://`, contained to `rootPath`. Relative links open in Daintree's file viewer when they stay inside `rootPath` and do nothing otherwise; `http(s)` and `mailto` links open in the browser. With neither `basePath` nor `rootPath`, the text still renders and relative references resolve nowhere. When a note links to images elsewhere in the project, pass the project root as `rootPath`.

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

The component renders nothing for the instant its code is loading, then the document. For TypeScript, `@daintreehq/plugin-sdk` ships the module's declaration: add `"types": ["@daintreehq/plugin-sdk/plugin-ui"]` to `compilerOptions`, and `MarkdownProps` comes with it.

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

`scope.stats()`, and the `onReport` option called once after disposal, count what the scope released, which cleanups threw and what arrived late. They see only what went through the scope, so zero proves nothing about what else the view kept alive; a heap snapshot is the tool for that. Nothing durable belongs here, for the reason `disposeSignal` exists: it belongs in the worker. A raw `plugin://` view cannot import the SDK and releases these by hand.

## Media and binary files

`host.fs.readFile` returns UTF-8 text and nothing else. For an image, an audio file or anything binary, don't route the bytes through the worker at all: the renderer can fetch the file itself over the `daintree-file://` protocol, which is how Daintree's own audio and video previews work (`useMediaBlobUrl` in the repo).

```js
// In the view. `root` must be a root the protocol may serve from: the project
// root is the one a project plugin has. The handler realpath-contains `path`
// under `root` and refuses anything outside it.
const url = `daintree-file://load?path=${encodeURIComponent(absPath)}&root=${encodeURIComponent(projectRoot)}`;
const blob = await (await fetch(url, { signal: disposeSignal })).blob();
const objectUrl = URL.createObjectURL(blob); // <audio src={objectUrl}>; revoke it on cleanup, or use scope.objectURL(blob)
```

Fetch into a blob rather than pointing an element's `src` at the URL directly; the blob path is the one the host has verified against Electron's media pipeline. This works because views are inline; it is not part of the host API, and a future move to an isolated view host would replace it with one.

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

- Bare npm imports in a raw view. Only the five React specifiers above, the tour's four (`@daintreehq/tour`, `@daintreehq/tour/react`, `@daintreehq/tour/kit`, `@daintreehq/tour/mock-app`) and [`@daintreehq/plugin-ui`](#host-ui-components) resolve through the host import map; everything else must be a relative module you ship in `dist/`, or you bundle. The tour specifiers resolve to the host's own tour instance, so a scene's `useCue` sees the host's player — `@daintreehq/plugin-vite` leaves them external for the same reason. Install `@daintreehq/tour` as a dev dependency for its types; its runtime always comes from the host. The tour module loads when a scene first imports it, not at startup.
- TypeScript, JSX or CSS files without a build. Hand-written views use `createElement` and a `<style>` string.
- Reaching into Daintree's React components. Only what [`@daintreehq/plugin-ui`](#host-ui-components) exports is served to plugins; the ones you can find by path are internal and will move.
- Module-scope state surviving a plugin reload. Each full plugin load mints a fresh view generation for the next import; keep anything worth keeping in `persistState` (survives remounts and reloads) or `host.storage` (survives everything). A `daintree-plugin dev` rebuild is a full load, so it drops module-scope state and picks up view edits like any other reload (#12277); see [Contribution points → Worker reload vs. view-module replacement](./contribution-points.md#worker-reload-vs-view-module-replacement) for the mechanism.
