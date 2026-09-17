# Views: what you get in the DOM

A plugin view is a React component the renderer mounts inside a panel. This page is what that component can rely on, what it can't, and how to make it look like it belongs. It applies equally to a project plugin's hand-written `dist/panel.js` and to a bundled `@daintreehq/plugin-vite` view; the differences are called out where they exist.

## Where you render

Views render **inline** in Daintree's React tree, not in an iframe. Same document, same CSS cascade, same `:root` custom properties, same React instance. That is what makes the styling below possible, and it is also why a view has the same reach as Daintree's own UI, including the full `window.electron` bridge. The [trust model](./trust-model.md) covers what that means; this page covers what to do with it.

The host mounts your default export under an error boundary and a `Suspense` boundary, inside a container that is `flex flex-col flex-1 min-h-0 w-full`. Make your root element fill it: `height: 100%` with `display: flex; flex-direction: column; min-height: 0` is the shape that scrolls correctly, because `min-height: 0` is what lets a flex child shrink below its content and hand the overflow to an inner scroller. A root that is only `height: 100%` will push the panel's own scrollbar around instead of owning it.

You receive [`PanelViewProps`](./contribution-points.md#views--shipped-panel-surface): `panelId`, `pluginId`, `disposeSignal`, `panelRemovedSignal`, `initialArgs`, `stateVersion`, `persistState`, `styleRootAttributes`. Two of these are misread in every first plugin. `pluginId` is your host-side id, which for a project plugin is the instance key, not your manifest name; pass it through to the bridge as given. `disposeSignal` aborts on every unmount, including the temporary ones (a sibling pane maximised, a dock tab left), so it is for cancelling fetches, never for deciding something is finished. `stateVersion` says which shape `initialArgs` holds, and is only meaningful once you declare `stateVersion` on the panel contribution — see [panel state versioning](./contribution-points.md#panels--shipped).

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

`window.electron.sitePreview` lets a view attach to one of the project's running dev-preview panels and receive structured observations from the page inside it — which element was hovered or clicked, and what the page reported about it. The SvelteKit Site Builder is built on it; nothing about it is Svelte-specific.

| Call | What it does |
| --- | --- |
| `listCandidates()` | The dev-preview panels this project could bind to, with any existing binding |
| `bind({ panelId, runtimeSource, mode })` | Installs your runtime into the page and returns a binding with a host-issued session id |
| `setMode({ sessionId, mode })` | Switches between `browse` (the page behaves normally) and `select` |
| `getState({ sessionId })`, `detach({ sessionId })` | Read or release the binding |
| `onEvent(cb)` | Validated guest events, epoch advances, and detaches |

Things that shape how you use it:

- **It is renderer IPC.** A plugin's main side cannot reach it. The view owns the binding and forwards what it learns to main over its own channels.
- **There is no "evaluate in the page" call, on purpose.** The runtime is supplied once, at bind time, and the host wraps it in a prelude that addresses and numbers each message. A general evaluate method would hand every renderer-side caller a standing arbitrary-execution channel into whatever site the user is previewing.
- **Everything from the page is an observation, never an instruction.** The page is an application under development, and it shares the main world with your runtime, so it can forge messages for its own binding. That reaches nothing beyond that binding's observations — the host validates session, epoch, sequence and size — but never act on a file path, range or revision a page supplied without resolving it yourself.
- **Key state on each event's `documentEpoch`, not on arrival order.** The new runtime's own ready event for a document can arrive before the host's epoch-advance notice for it. A hot-module update that does not navigate does not advance the epoch at all, so "the page reloaded" and "the page shows your latest source" are different claims.

The mechanism — CDP binding, prelude, validation — is described in [`docs/architecture/sveltekit-site-builder.md`](../architecture/sveltekit-site-builder.md).

## Built-in plugin views

A built-in plugin's view is compiled into the host bundle, so some of this page reads differently for it. [Architecture → Built-in plugin views](./architecture.md#built-in-plugin-views) covers registration; these are the practical differences once it renders:

- **It may import host modules.** `@/store/...` and `@/components/ui/...` resolve normally. Follow the host's store rules: cross-store reads go through `src/store/storeAccessors.ts`, and nothing imports a partner store at module evaluation.
- **Finding your worktree.** `PanelViewProps` gives you `panelId`, not a worktree. Read the panel's `worktreeId` from the panel store and its path from the worktree store. A plugin view is not guaranteed to sit under the worktree store's provider, so use the optional accessor (`useWorktreeStoreOptional`) with `getWorktreePathIndex()` as a fallback — the non-optional hook throws there. The project id comes from the project store.
- **Styling is the host's Tailwind.** The per-plugin runtime stylesheet described above does not run for a built-in; you get the host's full design system and must follow its rules — `.claude/rules/design-system.md` in the repo.
- **Registering a `lazy()` view is fine.** The host wraps every built-in view in its own `lazy()` for activation; it renders yours from a plain component so React never sees a lazy resolving to a lazy (error #306).
- **Never alias a lowercase component binding to a capitalised name for JSX.** The React Compiler folds `const View = component; return <View />` back into `jsx("component")`, which renders an unknown `<component>` DOM element — no error, just an empty panel. Use `createElement(component, props)`.
- **Extending the dev preview.** A built-in can add a toolbar toggle, a strip and a drawer to every dev preview with `registerDevPreviewTool` (`src/registry/devPreviewToolRegistry.ts`) instead of contributing a panel. The host mounts them with the preview's panel, project, worktree, URL and readiness; the tool decides whether its button applies to that preview. [Dev preview tools](#dev-preview-tools) below is the lifecycle.
- **React Compiler applies to you.** A bailout is silent at runtime and reddens the compiler budget. Two traps specific to controller-style views: never call a method that reads mutable controller state during render — pass a `useSyncExternalStore` snapshot to a pure function instead — and do not write a `try`/`finally` without a `catch` in a component.

## Dev preview tools

A dev preview tool is one registration — `registerDevPreviewTool({ id, pluginId, label, Button, createSession?, Toolbar?, Drawer? })` — and one entry in `useDevPreviewToolStore.activeByPanel`, which holds the tool a preview has switched on, one at a time per panel.

**The host owns the session.** Declare `createSession(context)` and the host calls it when the tool is switched on for a preview — before any surface mounts — and hands the result to the surfaces as `props.session`. It may return a promise, which is how a tool keeps its real implementation in a lazy chunk; the surfaces are not mounted until the session exists. Check `context.signal.aborted` before building anything expensive: a promise that resolves after the preview let go is disposed immediately, and a factory that throws switches the tool back off. The session is what holds the tool's state for that preview: a binding, a workspace, a selection, a draft.

**What the session is told.** The context is live: `panelId`, `projectId`, `worktreeId`, `worktreePath`, `url`, `isWebviewReady`, `visible` (whether any of the tool's surfaces are mounted), and an `AbortSignal` aborted on disposal. Changes arrive through `update(context)` for as long as the session lives. The page and worktree half comes from the preview's pane, so a fully unmounted preview holds the last of it rather than fresh news; what a session sees while nothing is mounted is that snapshot plus `visible: false`.

**What ends it.** `dispose()` runs when the tool is switched off, the preview is trashed or removed, or the owning plugin is disabled — the last two also clear the active entry, so a restored preview comes back plain. Nothing else does: a surface unmounting is not one of them, because a hidden dock tab, a maximised sibling and a grid remount all unmount surfaces without ending anything the user started. Put every teardown in `dispose()` and treat it as the only teardown.

**What the surfaces are for.** Rendering the session and calling it. They may not own its lifetime, and they should not reconstruct host events from the panel store or the tool store — the session hears those from the host. `src/services/devPreviewTools/sessionManager.ts` is the implementation, and the SvelteKit Site Builder is the worked example.

## What doesn't work inline

- Bare npm imports in a raw view. Only the five React specifiers above resolve through the host import map; everything else must be a relative module you ship in `dist/`, or you bundle.
- TypeScript, JSX or CSS files without a build. Hand-written views use `createElement` and a `<style>` string.
- Reaching into Daintree's React components. They are not exported to plugins, and the ones you can find by path are internal and will move.
- Module-scope state surviving a plugin reload. Each full plugin load mints a fresh view generation for the next import; keep anything worth keeping in `persistState` (survives remounts and reloads) or `host.storage` (survives everything). A `daintree-plugin dev` rebuild is a full load, so it drops module-scope state and picks up view edits like any other reload (#12277); see [Contribution points → Worker reload vs. view-module replacement](./contribution-points.md#worker-reload-vs-view-module-replacement) for the mechanism.
