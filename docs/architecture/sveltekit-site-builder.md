# SvelteKit Site Builder

Select an element in a running SvelteKit dev preview, see which source owns it, and hand it to your own coding agent. This document is the architecture of record: what it is, where each part lives, and — more importantly — the things that were proven before any of it was built, because each one removed a subsystem the original specification assumed was necessary. The builder itself writes nothing: it reads source, and the agent it hands a selection to is what edits.

The product surface is specified elsewhere (the functional and implementation specifications). This file covers mechanism.

## What Svelte already gives us

The whole design turns on one fact, verified against Svelte 5.57 / SvelteKit 2.63 / Vite 8.3 before implementation started:

**A Svelte dev build already carries the source location of every element it renders.** `svelte/src/internal/client/dev/elements.js` attaches a non-enumerable property to each generated DOM element:

```js
element.__svelte_meta = {
  parent: dev_stack,
  loc: { file: "src/lib/Card.svelte", line: 5, column: 2 },
};
```

`loc.file` is the path relative to the Vite project root, in POSIX form. The line is 1-indexed, the column 0-indexed. Both survive SSR and hydration in a real SvelteKit page.

`parent` is a linked list of `DevStackEntry` — `{ type, file, line, column, parent, componentTag? }` where `type` is `component`, `each`, `if`, `await`, `key`, `render` or `snippet`. It is the **render ancestry**, and critically, a `component` entry names the call site _in the parent file_. Clicking a heading inside a repeated card yields:

```
<h2>            src/lib/Card.svelte:5
 └ component    src/routes/+page.svelte:8   <Card>
   └ each       src/routes/+page.svelte:7
     └ render   src/routes/+layout.svelte:11
```

That chain is the breadcrumb, the invocation mapping, and the "which branch actually rendered this" answer, all for free.

### Two subsystems this deleted

The implementation specification proposed a **project development companion**: a new npm package added as a dev dependency to the user's own project, wired into their Vite config, injecting `data-daintree-source` attributes at compile time. It also proposed **paired dev-only comment boundaries** (`<!-- daintree:component-start -->`) plus `preserveComments` to recover component invocations.

Neither is built, because `__svelte_meta` supplies both and costs nothing. What went with them:

- No dependency or config change is written into the user's project, so there is no diff to review, no uninstall to get wrong, and no broken config import left behind.
- No transform-ordering problem against other Svelte preprocessors.
- No production-cleanliness risk. Nothing is ever injected into project source, so a production build cannot contain builder markers — this is true by construction rather than by test.
- No risk of corrupting markup in constructs where comment injection is unsafe.

The specification explicitly permits this substitution: "replacing comment boundaries with a proven compiler adapter is acceptable". The proof is the fixture corpus.

### What it does not give us

`__svelte_meta` is attached by the **dev** runtime only. A production build has none, which is correct — the builder is a development tool — but it means a running dev server is the precondition, not a detail: the guest reports `not-dev-build` when the metadata is missing on a page that looks built, and the panel says so rather than tracing nothing.

It is also a private detail, not an API, and a supported major is not a promise about its shape. The guest reads it defensively and probes what the page's metadata actually supports the first time it sees a stamped element — whether elements name their source, and whether the parent chain names the components above them — and reports that once per document (`metadataProbed`). The host narrows what it offers to match: a page whose stamps name no component chain gets a trail of elements and a notice saying why, and a shape the reader cannot follow at all is said up front rather than discovered click by click. The shapes this is tested against live in `__fixtures__/svelte-meta/`; add one when a release changes the shape.

It also does not survive an HMR update as an object identity. A Vite update **replaces the DOM nodes**; `__svelte_meta` is correctly re-attached to the new ones, but any node reference the host was holding is dead. Selection is therefore stored as an identity, never as a node handle, and every document change marks it stale; it is proven again only by a fresh selection or by the host asking the page to re-select that identity. A stale selection goes stale visibly; it is never re-pointed at whatever now occupies the old position.

## Shape

```
┌────────────────────────────────────────────────────────────────────┐
│ DEV PREVIEW (core) · Site Builder toggle, strip and drawer        │
│   node-pty dev server · proxy origin · viewport · console · CDP     │
│   ┌──────────────────────────────────────────────────────────────┐ │
│   │ GUEST: the user's running site, sandboxed, no preload        │ │
│   │   guest runtime — injected over CDP, reads __svelte_meta,    │ │
│   │   draws the overlay in a shadow root, reports observations   │ │
│   └──────────────────────────────────────────────────────────────┘ │
└───────────────────────────────┬────────────────────────────────────┘
                                │ sitePreview IPC (host-validated)
┌───────────────────────────────┴────────────────────────────────────┐
│ MAIN: SitePreviewBridge — binds a preview, installs/removes the    │
│ guest runtime, validates every envelope, resolves source identity  │
└───────────────────────────────┬────────────────────────────────────┘
                                │
┌───────────────────────────────┴────────────────────────────────────┐
│ BUILT-IN PLUGIN  daintree.sveltekit-builder                        │
│   main/      workspace lifecycle, host.fs reads, source tracking   │
│   shared/    protocol + domain model, project model and routes     │
│   renderer/  dev preview tool: toggle, session, strip, drawer      │
└───────────────────────────────┬────────────────────────────────────┘
                                │
┌───────────────────────────────┴────────────────────────────────────┐
│ packages/svelte-source-model — owns the `svelte` dependency        │
│   location → AST element · structure → AST element                  │
└────────────────────────────────────────────────────────────────────┘
```

## Why the Svelte compiler lives in a workspace package

`packages/svelte-source-model` exists to own one dependency. Three alternatives were rejected:

- **`svelte` in Daintree's root manifest.** Daintree is not a Svelte application and should not read as one.
- **Resolving the user's own `svelte/compiler` at runtime**, which the specification recommends for version fidelity. Built-in plugins load **in-process** in Electron main, so this would execute project-controlled JavaScript in the trusted process. Built-ins are in-process precisely because their code is app-bundled and trusted. The secondary problem is that "a SvelteKit app therefore has Svelte installed" is false for a fresh checkout, an uninstalled monorepo app, or Yarn PnP.
- **A bare `package.json` under `plugins/builtin/`.** A root `npm install` ignores a manifest outside the `workspaces` array, so CI would never install it and the tests would silently skip. Worse, `scripts/build-main.mjs` would copy that directory's `node_modules` into the app bundle and it would pass the packaging allowlist — shipping a compiler into the packaged app by accident.

The workspace package is the repo's own established mechanism, already used by five packages. Version skew is then reported where it belongs — in the **support verdict**. The project model reads the project's installed `svelte` and `@sveltejs/kit` versions and answers `preview-only`, with a reason naming the package and version found, when either is outside the supported major: below it, or above it, since a newer major inherits nothing this was tested against. Tailwind is not part of the verdict; its version is read for the agent's context and nothing else.

The verdict is a **record of that compatibility, not a gate**. Parsing does not branch on it: `main/selection.ts` always resolves through the bundled compiler (`main/engine.ts`), so a `preview-only` app is traced and handed to an agent exactly as a supported one is. What the verdict buys is the ability to say which apps the resolution was tested against. The panel shows it nowhere, because with no editing to withhold there is nothing the user could act on and nothing they are missing.

The package is `external`-ised in its own bundle and `await import()`ed by the plugin, so the compiler never sits on the eager main-process path.

## The guest boundary

The dev-preview guest has **no preload** — `electron/window/createWindow.ts` deletes it and forces `sandbox`, `contextIsolation` and `nodeIntegration: false`. Script therefore reaches the page over CDP (`Page.addScriptToEvaluateOnNewDocument`) or `executeJavaScript`, both of which run in the page's main world. The main world is required regardless: `__svelte_meta` is an expando on the DOM node, and expandos are per-world.

The page is untrusted. It is an application under development and a same-origin compromise can forge anything it sends. The rule that follows:

**The guest reports observations. The host resolves identity.**

A guest message carries the raw `__svelte_meta` it read, geometry, and a runtime occurrence id. It never carries a file path the host will act on, a source range, or a revision. The host takes the reported location, reads the file itself through the scope-contained plugin filesystem API, parses it, and derives the range. The worst a lying page can do is point the inspector at the wrong element _of its own project_; it cannot address another file. What is host-derived is what matters: the file, the range and the revision come from the host's own contained read, so no message can make the prompt's source references cite bytes the host did not read. Other fields stay observations and are shown as such — the element's label, the ancestry chain the trail's crumbs are drawn from (their paths included, until a crumb is resolved to a definition the host read), and the count of copies sharing a location are the page's word, and a page that lies about them describes its own elements wrongly. Sending a request to an agent comes from a trusted UI action, never from a message.

Every envelope is validated on five fields before its payload is looked at — protocol version, session, document epoch, sequence, and size — so a stale runtime from a previous binding, a replayed message, or an oversized body is dropped without interpretation.

**The host chooses the script, not the caller.** `sitePreview.bind` takes an `adapterId`, never source: main keeps a registry of guest adapters (`electron/services/sitePreview/guestAdapters.ts`), registers every adapter a built-in manifest declares under `contributes.guestAdapters` at startup (`builtinGuestAdapters.ts`; nothing in core names the builder), and loads the body from an app asset. An unknown id is a `NOT_FOUND`, and every binding carries the owning plugin. The runtime used to travel from the renderer as `Function.prototype.toString()` output, which forced the whole ~1,500-line factory into one closure and broke on any transform that hoisted a helper out of it; it is now bundled by `scripts/build-main.mjs` into a standalone IIFE under the plugin's `guest/` output directory, at a path derived from the adapter id (`guest/guest.js` for the builder), resolved under `app.getAppPath()` in dev and inside `app.asar` when packaged. The asset is spliced into the prelude's scope, so it must leave `api` a free identifier and must not read the CDP binding directly.

## Writes

The builder makes none. It holds `fs:project-read` and nothing else, its manifest declares no write capability, and every channel it registers reads: resolve a selection, read revisions, read the project model. What changes the user's source is the agent they sent the selection to, working in the same worktree with their own tools.

So the honest guard is freshness, not a compare-and-swap. `host.fs.writeFile(path, contents, { expectedRevision })` compares the sha256 of the bytes on disk and refuses a mismatch with `REVISION_MISMATCH` — but it is a checked write, not an atomic one: the read and the write are separate operations and another process can land between them (`shared/types/plugin.ts` says so at the API). Nothing here depends on that any more. Instead:

- **Verification at send time, which is the authority.** Every file a request cites about the selection — the element's markup and its component chain — is held to the revision of the exact bytes its claim was read from, and `source-revisions` reads them again before the prompt is built and once more immediately before it is typed in. The route files are context gathered at send time and are not held to a revision.
- **Watching, which is advisory.** The **source tracker** (`main/tracker.ts`) watches the parent directory of each file a _selection resolve_ read — not every read main performs, and bounded at 256 files and 64 directories — re-hashes on each event, and pushes `push-source-changed` when the bytes are ones it has not seen. There is no write-suppression side to it any more: every change it notices is somebody else's, which is exactly what the view needs to hear.
- A selection whose file changed goes visibly stale, and a click on a file that changed moments ago is refused until HMR can land, because the page may still be showing the old markup.

An earlier version of this plugin did write — planned replacements over ranges of the original source, an `expectedRevision` on every write, an in-memory journal for Undo, and a re-proof of the selection after each one. The drawer never called it (see below), so it is gone: the engine, the journal, the undo channel, the receipt, and the Tailwind class model that existed to validate what those edits wrote. `packages/svelte-source-model` keeps its edit planner, which has its own tests and no caller here.

## Where it lives

The guest runtime is the exception to everything below: `renderer/guest/entry.ts` is a build-time entry, not renderer code. Nothing in the plugin's bundle imports it — `scripts/build-main.mjs` bundles it separately into the plugin's dist directory, and only main ever reads it, as text.

The builder is part of the dev preview, not a panel of its own. A built-in registers a **dev preview tool** (`src/registry/devPreviewToolRegistry.ts`):

- **Button** in the preview's browser toolbar. The host shows it only where the tool's `isAvailable` predicate says yes — the Site Builder's asks `detect-apps` whether the worktree holds a SvelteKit app, naming the project and worktree so main scans through a filesystem handle bound to them rather than the focused window's (cached per worktree, a "no" never reused) — so other sites never show it, and `devPreview.toggleTool` refuses there with the tool's own `unavailableReason`.
- **Toolbar**, a strip under the browser toolbar while the tool is on: Browse/Select, the selected component chain and `file:line`, and close.
- **Drawer** beside the page, open only once there is something to show: the pinned selection identity, and below it the agent composer — no section header, no disclosure, because handing the selection to an agent is the one thing the drawer does. Its width, resize handle and narrow-pane behaviour are the host's drawer chrome, not the plugin's: 360px by default, drag-resizable between 280px and 560px, and a `@container/drawer` so the rows inside answer to the width it was actually given. When the worktree holds more than one app, **Site source** keeps an app switcher; switching drops the selection, which belonged to the other app.

Which tool is on is per preview panel (`src/store/devPreviewToolStore.ts`), toggled by the button, by the plugin's **Toggle Site Builder** command and tray entry (`devPreview.toggleTool`, which opens a dev preview when the worktree has none), or closed from the strip. A tool is hidden until its plugin is known to be loaded and enabled, so a default-off built-in never flashes its button. Turning the builder on binds straight to its own preview in Select mode; there is no candidate picker, because the preview hosting the tool is the only one it can mean.

The controller is the host's **tool session** for that preview: the host creates it when the builder is switched on, keeps it while the tool stays on — so hiding the preview, maximising a sibling or a grid remount keeps the binding and in-flight state — feeds it the preview's worktree, page and visibility, and disposes it when the builder is switched off, the preview is trashed or removed, or the plugin is disabled. The strip and the drawer receive the same session through their props and never own its lifetime; `createSession` is the only thing the plugin registers for it, and disposal is what cancels agent requests, forgets composer drafts, detaches the preview and closes the workspace. A bind that fails because the preview has no page yet is retried on a backoff of about two minutes, with **Retry** in the strip; the session hears about the page from the preview's pane rather than from the strip, so the retry does not depend on the builder's own surfaces being mounted. [Views → Dev preview tools](../plugins/views.md#dev-preview-tools) is the contract.

## Selecting on the page

The page script draws a Web Inspector-style overlay: a hover box with margin and padding bands, and a label naming the component that drew the element, its tag and its size. Selection works by click (Cmd/Ctrl-click adds) and from the keyboard once something is selected:

- **Arrow keys** walk the rendered tree — up to the parent, down to the first child, left and right across siblings — among elements that carry Svelte source locations.
- **Option/Alt+Up** selects the _component_ that drew the selection: every root element of that one invocation, not every card drawn by the same line. Pressing it again steps out to the enclosing component, including a wrapper that renders no element of its own. Component identity is the per-invocation frame object on `__svelte_meta.parent`, so two cards from one `{#each}` stay distinct.
- **Clicking a component in the trail** — in the strip or the drawer — does the same, aimed: the controller asks the page to re-select the proven element as a member of that invocation (`sitePreview.reselect` with the crumb's call site), and the page's answer resolves as a fresh pick. A click on the page lands on the innermost thing under the pointer, and the component a request should be about is usually a step or two up; the trail already names those steps. Crumbs are buttons only while a pick can be made (`canSelectComponent`: bound, Select mode, a ready selection that is not stale and one the page can be asked for again); the selection itself is never one, nor is a crumb whose call site is shared by one inside it, since the page can only select the innermost of a recursive pair. After a keyboard activation, focus returns to the strip's current crumb or the drawer's first identity control once the new selection is ready.
- The selection event carries `scope: "component"` and `component` — the selected invocation's call site (`file`, `line`, `column`) and its tag. The strip, the drawer and the prompt place that call site on the ancestry by location rather than by counting frames, so a dropped or truncated frame can't make them name a different component; a call site that isn't on the chain is still offered as what was picked.
- **Where a component is written comes from source, never from the chain.** A snippet passed into a component, a wrapper with no element of its own, or a dropped frame all make the parent chain name a plausible wrong file. Once a selection is ready the controller sends every component call site on it to main's `component-definitions` channel (`main/components.ts`), which parses the call site's file, finds the `Component` node at that exact offset, and follows its default import (relative or `$lib`) to a `.svelte` file that exists. It counts as proof only when that default import is the name's one top-level value binding across both script blocks (a `var` hoisted out of a block counts; type-only imports, ambient `declare` and declarations inside functions don't) and nothing in the markup enclosing the call site binds the name — a snippet parameter or sibling snippet, an each item or index in the each body, an await value or error in its own branch, a `let:` binding (renamed or not, including the component's own when it fills a named slot), or a `{@const}`. `$lib` is followed only when no `svelte.config.*` mentions `files` at all (the config is never executed). A dynamic component, a namespace tag or a package import resolves to null. A draft pinned before the answer arrived asks for its own through whichever workspace session is open now, so it never stays pending after the selection moves on or the workspace reopens. A component scope without a proven file is shown but can't be sent: the composer asks the user to choose another scope.
- Arrow keys aimed at a field, a contenteditable region or a keyboard widget on the page are left to the page, as are other modifier combinations.

## No direct editing in the drawer

The drawer offers no direct text or class editing. It used to, as a peer section above the composer, and that presented two competing routes in a tool whose purpose is selection and handoff; on a laptop viewport it also pushed Send below the fold. The text editor, class-token editor, edit receipt with Undo, and the capability rows that explained when editing was unavailable went first; the engine behind them, described above, followed.

What went with it is worth naming, because each piece read as necessary while a writable drawer existed: the per-surface capability and decoded-value fields on a selected node, the "how this surface is written" excerpt that explained a disabled control, the responsive intent an edit was written at, the edit error codes, and the whole Tailwind class model — completion, conflicts, the CSS one token generates. A selected node is now identity and geometry, which is all a prompt cites.

## Asking an agent

The Site Builder's job is handing the selected element to an agent terminal. The composer, which is the drawer's body below the identity, composes one prompt and submits it to an agent terminal in the preview's own worktree:

- **Bring your own agent.** The destination picker sits in the composer's footer, opposite Send, and each destination wears its CLI's brand mark through `BrandMark`. The destination list is the live agent terminals in the same worktree plus a new session of any built-in agent the host can launch and whose prompt it can recognise (Claude, Codex and Gemini first) — the user's own account, no Daintree-hosted model. An agent without calibrated prompt detection (today, Grok) isn't offered, since the request is typed in once the agent is reported waiting. A terminal in another worktree is never a target, even with focus, because the prompt's paths would be wrong there.
- **A new session gets the request typed in, not as a launch argument.** `agent.launch` passes an initial prompt through the shell as one argument and flattens its line breaks (fenced source included), so the composer launches without one and submits the request once the agent is reported waiting. A detected trust or approval question is also "waiting"; the composer shows **Prompt detected in …** and holds the request until it is answered.
- **The destination is committed when you start writing.** If that agent goes away the composer says so and blocks sending until another is chosen; it never silently falls back to a different agent.
- **Readiness before typing, every time.** New or existing session, the request is typed only once the host reports the agent waiting; a detected trust, approval or error prompt holds it and says so. When the host can't tell after a few seconds, **Send anyway** is the user's explicit call. This is the host's observation, not proof: its detector can also infer "waiting" from a quiet terminal, so an unrecognised screen that goes silent can still receive the request.
- **Show the result, not a claim.** A delivered request offers **View worktree changes**, **Open terminal**, **View request** (the exact text typed into the terminal) and **Dismiss**; the strip can fold the drawer away to give the page its full width.
- **Drafts survive.** Each preview's draft, pinned subject, destination and last delivery live outside the drawer, keyed by preview _and_ worktree, and delivery runs outside React, in the host's own agent-request service (`src/services/agentRequests/`, which the builder's `renderer/agentRequest.ts` adapts) — starting an agent re-lays the grid and remounts the builder, which used to cancel the very request that started it. Switching the builder off, removing, trashing or moving the preview to another worktree, or disabling the plugin ends a pending request — the run checks that on every step, whether or not any builder surface is mounted — and the notice says where it stopped: "Stopped before the request was sent", or "Delivery unconfirmed" once the prompt had reached the terminal. Switching off, removal and disabling also forget drafts.
- **The subject is pinned.** Typing pins the element (or component) the draft is about; clicking something else offers **Use current selection** rather than silently changing the subject.
- **Element or component.** `taskScopes()` turns the Svelte parent chain into the clicked element plus every component around it, innermost first, each located by the file main resolved for its call site. The element is always scope 0; the outermost user file (a route page or layout rendered by generated code) is always offered, and is the one file taken from the chain, because it holds the outermost call site itself.
- **References, not contents.** The prompt carries the user's words first, then a Markdown `---` rule, then the app and its toolchain versions, the page and viewport, the route's files outermost first (layouts, load modules, page), the element label, `file:line:column` of the defining markup (worktree-relative), the rendered-copy count (marked as a floor on a page too large to count), and the component chain. No source excerpt, class list or text is pasted: the agent works in the same worktree and reads what it needs, and pasted source goes stale the moment either side edits. The route comes from the project model, matched against the page's URL with SvelteKit's own pattern and ranking rules (a port of Kit 2.x `parse_route_id` and `sort_routes`), after stripping a literal `kit.paths.base`; a route behind a param matcher, a computed base, or an endpoint winning the URL names no route rather than a guess.
- **A request names only what is still true.** Every file a request cites about the selection — the element's markup and its component chain — is held to the revision of the exact bytes its claim was read from: each selected element's file to the revision it was resolved against, and every authored component call site (including ones outside a library frame) and component file to the revisions `component-definitions` returns alongside its answer. A file nothing vouched for can't be verified, so it fails. `source-revisions` reads them again at send time. Send is blocked while the subject is stale or those revisions are unknown, and the delivery checks them against disk twice — before building the prompt and again right before typing it in, since an agent can sit at a trust or login prompt for minutes. A mismatch or an unreadable file fails the request with "select it again" and keeps the draft. The route files are context read at send time and aren't held to a revision. Right before submission the destination terminal must also still be in the preview's worktree and not trashed. Switching the builder to another app cancels a request still on its way.
- **Delivery is what the host can prove.** It goes through `terminal.sendCommand` and polls `terminal.getStatus` with the submission token: `pty_written` is "Sent", `unknown` is "Delivery unconfirmed", `failed`/`cancelled` say part of the prompt may already be in the agent's input. An unconfirmed or partial delivery blocks Enter on the unchanged draft; **Send it again** starts a new delivery on purpose. A busy (`working`/`directing`) reading is shown beside Send as an observation but never blocks it: the reading is a heuristic that can be wrong, and a gate the user can't clear would strand the request. The sent receipt's headline is only **Sent to …**; any activity reading appears below it, in the present tense.

The mechanics of all that are not the builder's. `src/services/agentRequests/` owns them: the explicit destination, the prompt-less launch, readiness polling, the ownership and freshness checks, the submission token, the receipt poll, cancellation by owner-key prefix, and the honest `unconfirmed`/`partial` states. The builder supplies only what is its own — an owner key (preview and worktree), a `stillOwned` predicate, `verify()`, `buildPrompt()`, and an `onState` sink that writes the record into composer memory and clears the sent draft. An `idempotencyKey` — owner, destination, subject (selection, scope and the revisions the request is held to) and draft — makes a repeated call while a run is in flight join that run rather than start a second, which is what keeps a remount from submitting twice. It covers everything the prompt is built from, so the same sentence about another element is a different request, and it is freed the moment the run settles or is cancelled, so sending again later is always a run of its own. It says nothing about what an agent did with a write that was already ambiguous: repeating an unconfirmed request stays the user's call.

Built-in renderer views dispatch these renderer actions directly as a user action; `terminal.sendCommand` is closed to `host.dispatch` from plugin main, and `host.sendToActiveAgent` picks its own target, which the explicit-destination rule rules out. Every dispatch the service makes carries `source: "user"` because every run begins at a user's click on a host surface — so nothing reachable from plugin worker code, a timer or an automation may call it, which would launder unattended intent past the policy `denyPluginDispatch` applies.

## Scope, honestly

A rendered element, the markup that defines it, and the invocation that produced this particular copy are three different things. One `<article>` in one component draws all three pricing cards: changing it changes all three. The inspector therefore reports the number of rendered occurrences a source range controls, and the prompt states it — marked as a floor on a page too large to count every copy — so neither the user nor the agent reads "this element" as "this one copy".

What the builder can vouch for: the node, the file, the range, and the revision the bytes had when it read them. What it cannot: that a shared component change has no effect elsewhere in arbitrary application logic. The copy says the first and never implies the second.

## Traps found building it

Each of these cost a debugging cycle, a failed merge, or a reproduced bug.

### Svelte compiler

- A whole-expression attribute value (`class={x}`, `tier={3}`, the `{plan}` shorthand) is a **bare `ExpressionTag`** on `Attribute.value`; only a quoted literal is a one-element `[Text]` array. Reading the field as an array only marks every literal prop dynamic.
- An `ExpressionTag` range covers the braces (`{3}`); its inner `Literal` covers `3`. Say which one a range means.
- `CLASS="x"` compiles to `class="x"`: HTML attribute names are case-insensitive, component props are not. A tool that reads them as one vocabulary reads two spellings as one value.
- A spread and the attributes around it compile into one object in source order, so a later `{...rest}` overrides an earlier literal `class`.
- `parse()` and `compile()` **strip a byte-order mark**, so AST offsets are one code unit behind the raw bytes of a BOM file. Run model operations on BOM-stripped text.
- Component call sites are emitted through `add_svelte_meta(…, 'component', …, { componentTag })`, dynamic elements through a trailing location on `$.element`, everything else through the `add_locations` table. A test that only reads `add_locations` misses every invocation.

### SvelteKit routing

- `+page.server.ts` or `+page.ts` with no `+page.svelte` is still a navigable page (a redirect route), not an endpoint.
- Never split a route filename on `.`: layout reset targets can contain dots and brackets (`+layout@(app.v2).svelte`).
- Module extensions default to `.js`/`.ts` and match case-sensitively — `+server.mjs` is not an endpoint.
- `src/routes/build/` and `src/routes/dist/` are ordinary routes. A build-output exclusion list is right for app discovery and wrong inside the routes tree.

### CDP and the guest

- **Send `Page.enable` before `Page.addScriptToEvaluateOnNewDocument`.** Without it the call succeeds, returns an identifier, and the script silently never installs.
- `Runtime.addBinding` reaches every execution context, iframes included. Filter `bindingCalled` by `executionContextId` against the main frame's default world.
- `Runtime.enable` replays existing contexts only the first time it is enabled on a debugger session, and the webview console capture shares that session. The bridge used to force a replay with a disable/enable cycle and lean on the console capture's watermarks to absorb the repeat, and the console capture used to switch `Runtime` off when its last pane left, under a live binding. Both now go through one per-guest lease service (`electron/services/cdp/WebContentsCdpService.ts`): a domain stays on while anyone holds a lease, the context snapshot is kept where both consumers can read it, and `Page` is never disabled at all because other host code enables it without a lease.
- The guest's sequence restarts at 0 on every document, and a hot update that does not navigate does not advance the epoch. The host reinstalls per document with the epoch baked in, skips a second install for an epoch it already served (both would start at 0 and the second would read as a replay), and re-applies a mode that changed while an install was awaiting CDP.
- Give every guest `Runtime.evaluate` a timeout: a hostile page can make an expression never return.
- Style the overlay through the CSSOM, not a `<style>` element — a strict `style-src` blocks the element and the attribute, never `style.setProperty`. Use a closed shadow root so the page cannot reach it.
- An element with no `__svelte_meta` whose ancestor has one is `{@html}` or third-party DOM on a client-rendered page: every compiled element is marked there. On a hydrated page it can also be a template element whose stamp the hydration walk dropped (see the lesson on "Selection changed" below).
- The runtime used to travel as `Function.prototype.toString()` output, which forced the whole factory into one closure and broke on any transform that hoisted a helper out of it. It is now a standalone asset esbuild bundles from `renderer/guest/entry.ts` (`scripts/build-main.mjs`), read back by a host-registered guest adapter; the asset tests build it with the script's own configuration, minified and not.
- `Number.isInteger(2 ** 53)` is true and zod's `.int()` rejects it; one unsafe number drops the whole envelope. Use `Number.isSafeInteger`.

### Running the real thing

- **"Selection changed" for an element that never changes.** On a server-rendered page, Svelte's dev `add_locations` walks the template's sibling nodes while hydrating and counts a child component's rendered root (a `<header>` from `<EditorialHeader>` before `<div class="journal">`, say) as one of the template's own elements, so every element after it in that template carries the location of the element after it — `div.archive-toolbar` reported `+page.svelte:367:1`, the `span` in the next block — and the ones past the end of the list carry none. Main resolved a `span` for a `div` and returned a bare `stale`, which the drawer reported as the page having moved on. Not fixed upstream as of Svelte 5.57; a client-side navigation re-renders the page with correct locations. Two things changed. The guest now also reports the node's **structure** — its template's file, then outermost first each step's tag and index among the siblings that share its frame (`__svelte_meta.parent`, one object per block or invocation) — and when the stamped location and the file disagree, or there is no stamp, main asks `resolveElementByStructure` (`packages/svelte-source-model/src/resolve/structure.ts`) to walk the frame's fragment down that path (the root fragment for a component frame, a block's branches — else-if chains included — for its frame, any snippet or implicit-children fragment for a `render` frame, with the stamp narrowing the branch), re-proves the answer at the location it names, and reports one rendered copy as a floor. A stamp the file agrees with is kept as it is: the page can move an element after stamping it, and its new place says nothing about its source — which also means a same-tag neighbour's stamp goes unseen. The shape is placed only where the page and the source count alike, and refused otherwise: a level whose source holds `{@html}`, a `<slot>` with fallback, a `<svelte:element>`, a `<svelte:fragment>` or a `<svelte:boundary>` (and any placement where a fragment the frame could mean is such a level), an `{#each}` body with more than one root past its first iteration, and a node with a snippet rendered inline before it — `{@render}` of a local snippet is the one region the server output does not bracket, so the surrounding template's walk stamps and re-frames the snippet's elements. A shape the source cannot follow reports the disagreement as what main saw (the `mismatch` on `selection-resolve`) with the navigation workaround instead of "select again". An element that received no stamp at all is placed the same way when it trails its template's stamped siblings or sits under such an element, taking its template and frame from the nearest stamped ancestor; it stands for that ancestor, as before, when a stamped sibling of the frame follows it, when an unstamped sibling precedes a stamped one, or when a stamped sibling's frame reaches the ancestor's only through another component's frame (the container then holds that component's roots, and a dropped one could be either's). Shapes the page cannot tell apart, and so can still misplace, include a component that renders only `{@html}` at its root beside the template's own elements. A reselect asks the page for the element by the occurrence id it was reported under first, and by location when that node is gone or the runtime was reinstalled, which after a placed element can name the neighbour carrying its true location; the page's answer is resolved as a fresh pick, which is all the trail's component picker needs. Shapes the page refuses rather than guesses at: an unstamped node inside a bracketed block region, or whose container's frame is not above its own (raw markup that inherited a stamp inside a descendant component), or beside a sibling whose frame chain passes a render frame at any point; a component frame whose call site is in the element's own file walks that Component node's supplied content instead of the file's root.
- **"Production build" on a page that plainly traced.** The dev-metadata audit judged a page the moment it was `complete`, but SvelteKit hydrates after `load` through a chain of dev-server module fetches, and its dev page has no `<script src="/@vite/client">` tag to recognise. The audit now waits for the page to settle, recognises a dev server from its module requests (`/@fs/`, `/.svelte-kit/generated/`, `/@vite/client`), gives such a page longer, and a selection or hover that carries a source location clears any such verdict.
- **Daintree's own `NODE_ENV` used to reach every terminal.** Started with `NODE_ENV=production` (the E2E launcher does this), `vite dev` in a Daintree terminal compiled Svelte for production and no element carried `__svelte_meta`; the guest correctly reported "production build". Terminals now drop the inherited `NODE_ENV` (`EnvironmentFilter.ts`); a value from the user's shell profile or a caller's explicit env still applies.
- **The grid recreates a preview's page when panels are added or moved**, which detaches the session with `debugger-detached` or `guest-destroyed`. The controller reattaches to the same panel on a short backoff before showing **Reconnect**.
- **The in-process built-in view path was broken twice without a failing unit test**: a lazy-in-lazy (#306) and a React Compiler alias that rendered `<component>`. Both only showed in the built app, which is what `e2e/plugins/sveltekit-builder.spec.ts` exists for.

### Freshness

A guest observation carries no source revision, so main can only resolve it against the bytes on disk _now_. If an agent rewrites the file and the preview has not caught up, a click on the old DOM resolves to whatever element occupies that position in the new bytes — and a same-tag element there resolves cleanly and passes the revision check. The view narrows this window by refusing observations for a file shortly after it changes; closing it fully needs the page to report which revision it is showing, which the dev runtime does not expose. The page also re-reports its URL and viewport before a selection whenever either moved without a new document (client-side navigation, a resize), so a new selection never carries the previous route. A draft pinned before a navigation keeps the page it was pinned on, which is what it is about.

### Parallel build

- Freezing the wire messages between two halves is not enough. The host bridge and the page runtime were built against the same message schema and still disagreed about who owned the envelope; the plugin's main and view later agreed on messages but not on who derived a source range. Freeze the ownership split alongside the shapes.
- A mock host that enforces fewer rules than the real one lets a whole phase pass against a contract the app rejects — here, colons in channel names.
- Code built against a mock of its neighbour needs one test that runs both real halves together. Every cross-phase defect in this feature was found by such a test or by review of the combined change, never by a phase's own suite.

## Related

- `docs/plugins/` — the plugin system this is built on.
- `docs/architecture/dev-preview-event-routing.md` — the preview lifecycle and its notification tiers, which this reuses rather than replaces.
- `docs/feature-curation.md` — the rubric this was scoped against, and the limits it set.
