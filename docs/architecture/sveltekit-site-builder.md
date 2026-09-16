# SvelteKit Site Builder

Select an element in a running SvelteKit dev preview, see which source owns it, and change its text or Tailwind classes as a real source edit. This document is the architecture of record: what it is, where each part lives, and — more importantly — the four things that were proven before any of it was built, because each one removed a subsystem the original specification assumed was necessary.

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

`__svelte_meta` is attached by the **dev** runtime only. A production build has none, which is correct — the builder is a development tool — but it means the supported-baseline check is load-bearing rather than cosmetic.

It also does not survive an HMR update as an object identity. A Vite update **replaces the DOM nodes**; `__svelte_meta` is correctly re-attached to the new ones, but any node reference the host was holding is dead. Selection is therefore stored as an identity and re-resolved after every document change, never as a node handle. A stale selection goes stale visibly; it is never re-pointed at whatever now occupies the old position.

## Shape

```
┌────────────────────────────────────────────────────────────────────┐
│ DEV PREVIEW (core, unchanged)                                      │
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
│   main/      binding lifecycle, host.fs writes, edit journal, undo │
│   shared/    protocol + domain model, Tailwind semantics, project  │
│   renderer/  the Site Inspector panel                              │
└───────────────────────────────┬────────────────────────────────────┘
                                │
┌───────────────────────────────┴────────────────────────────────────┐
│ packages/svelte-source-model — owns the `svelte` dependency        │
│   location → AST element · deterministic, source-preserving edits   │
└────────────────────────────────────────────────────────────────────┘
```

## Why the Svelte compiler lives in a workspace package

`packages/svelte-source-model` exists to own one dependency. Three alternatives were rejected:

- **`svelte` in Daintree's root manifest.** Daintree is not a Svelte application and should not read as one.
- **Resolving the user's own `svelte/compiler` at runtime**, which the specification recommends for version fidelity. Built-in plugins load **in-process** in Electron main, so this would execute project-controlled JavaScript in the trusted process. Built-ins are in-process precisely because their code is app-bundled and trusted. The secondary problem is that "a SvelteKit app therefore has Svelte installed" is false for a fresh checkout, an uninstalled monorepo app, or Yarn PnP.
- **A bare `package.json` under `plugins/builtin/`.** A root `npm install` ignores a manifest outside the `workspaces` array, so CI would never install it and the tests would silently skip. Worse, `scripts/build-main.mjs` would copy that directory's `node_modules` into the app bundle and it would pass the packaging allowlist — shipping a compiler into the packaged app by accident.

The workspace package is the repo's own established mechanism, already used by five packages. Version skew is then handled where it belongs — in the **support verdict**. The project model reads the project's installed `svelte`, `@sveltejs/kit` and `tailwindcss` versions and reports `preview-only` with a specific reason when any falls outside the supported band, rather than parsing with a mismatched compiler and hoping.

The package is `external`-ised in its own bundle and `await import()`ed by the plugin, so the compiler never sits on the eager main-process path.

The same rule applies to Tailwind, and was nearly missed. The design system is compiled by **Daintree's own bundled `tailwindcss`**, never the project's copy: the project's package is read only as data — its version for the support verdict, its stylesheets for the theme. Modules a project's CSS names through `@plugin` or `@config` are **not loaded**; they resolve to inert stand-ins and are listed in the load result's `skippedModules`. The cost is that utilities a project adds through a JavaScript plugin are missing from completion. The alternative was executing any opened repository's JavaScript inside Electron main the moment the inspector read its CSS.

## The guest boundary

The dev-preview guest has **no preload** — `electron/window/createWindow.ts` deletes it and forces `sandbox`, `contextIsolation` and `nodeIntegration: false`. Script therefore reaches the page over CDP (`Page.addScriptToEvaluateOnNewDocument`) or `executeJavaScript`, both of which run in the page's main world. The main world is required regardless: `__svelte_meta` is an expando on the DOM node, and expandos are per-world.

The page is untrusted. It is an application under development and a same-origin compromise can forge anything it sends. The rule that follows:

**The guest reports observations. The host resolves identity.**

A guest message carries the raw `__svelte_meta` it read, geometry, and a runtime occurrence id. It never carries a file path the host will act on, a source range, or a revision. The host takes the reported location, reads the file itself through the scope-contained plugin filesystem API, parses it, and derives the range. The worst a lying page can do is point the inspector at the wrong element _of its own project_; it cannot address another file, and it cannot authorise a write. Mutation authority comes from a trusted UI action, never from a message.

Every envelope is validated on five fields before its payload is looked at — protocol version, session, document epoch, sequence, and size — so a stale runtime from a previous binding, a replayed message, or an oversized body is dropped without interpretation.

## Four states, separately proven

The single most common way a visual editor lies is collapsing distinct facts into one green tick. These are tracked and reported separately:

| Fact | How it is proven |
| --- | --- |
| Source saved | The write returned, with the new content hash. |
| Preview refreshed | The guest acknowledged a later document revision. |
| Styles generated | Computed style was read back out of the guest. A class reaching the DOM does **not** mean Tailwind emitted a rule for it. |
| Reviewed | The user said so. |

The third is not hypothetical. Adding a never-before-used utility to a project without Tailwind installed writes source correctly, reaches the DOM correctly, and renders nothing — computed padding stays `0px`. With Tailwind wired up, the same edit produces a real rule through the project's own Vite pipeline. Both were reproduced before the inspector was designed, which is why "saved" and "visible" are different words in the UI.

## Writes

Edits go through `host.fs.writeFile(path, contents, { expectedRevision })`, which is already an atomic compare-and-swap: the revision is the sha256 of the file's bytes, a mismatch is refused with `REVISION_MISMATCH` carrying the current revision, and every path is realpath-contained to the plugin's declared `scopes.fs.allowedPaths`. The builder adds a journal on top for Undo, not a second write path.

Edits are planned before they are applied. A plan is a set of replacements over ranges of the _original_ source, applied in one pass, so unrelated bytes — whitespace, comments, quote style, classes the builder does not recognise — survive verbatim. The candidate is re-parsed and the protected ranges are checked before anything reaches disk; a candidate is never written just to discover whether it compiles.

## Scope, honestly

A rendered element, the markup that defines it, and the invocation that produced this particular copy are three different things. One `<article>` in one component draws all three pricing cards: editing it changes all three. The inspector therefore shows the number of rendered occurrences a source range controls **before** it enables a control, and "this element only" is never offered as a writable scope when the source says otherwise.

What the builder can enforce: the operation, the node, the file, the expected revision, and the scope containment on the path. What it cannot: that a shared component change has no effect elsewhere in arbitrary application logic. The copy says the first and never implies the second.

## Traps found building it

Each of these cost a debugging cycle, a failed merge, or a reproduced bug.

### Svelte compiler

- A whole-expression attribute value (`class={x}`, `tier={3}`, the `{plan}` shorthand) is a **bare `ExpressionTag`** on `Attribute.value`; only a quoted literal is a one-element `[Text]` array. Reading the field as an array only marks every literal prop dynamic.
- An `ExpressionTag` range covers the braces (`{3}`); its inner `Literal` covers `3`. Say which one a range means.
- Attribute value ranges are quote interiors, and the parser accepts unquoted values. Writing `p-4 flex` into `class=p-4` produces `class=p-4 flex` — a second boolean attribute, still valid markup, so re-parsing cannot catch it. Only quoted literals are writable.
- `CLASS="x"` compiles to `class="x"`: HTML attribute names are case-insensitive, component props are not. Two spellings at once is two controls over one value; refuse.
- A spread and the attributes around it compile into one object in source order, so a later `{...rest}` overrides an earlier literal `class`.
- `parse()` and `compile()` **strip a byte-order mark**, so AST offsets are one code unit behind the raw bytes of a BOM file. Run model operations on BOM-stripped text and restore the BOM on write.
- Component call sites are emitted through `add_svelte_meta(…, 'component', …, { componentTag })`, dynamic elements through a trailing location on `$.element`, everything else through the `add_locations` table. A test that only reads `add_locations` misses every invocation.

### Class tokens and Tailwind

- HTML splits a class list on **ASCII** whitespace. JavaScript's `\s` and `.trim()` also match NBSP, so `a&nbsp;b` reads as two classes and a removal deletes half a class name.
- Entity names are case-sensitive: `&AMP;` is an ampersand, `&Amp;` is five characters.
- Escaping `&` unconditionally is HTML-correct and breaks Tailwind: its scanner reads source as plain text, so `[&amp;>*]:p-2` is not the candidate `[&>*]:p-2` and no rule is generated. Escape `&` only where it could begin a reference, and refuse a token that cannot be written verbatim — `before:content-['{x}']` must escape its brace for Svelte, and then Tailwind will never see it.
- `candidatesToCss` returning `null` is the only validity oracle in the design-system API. `candidatesToAst` answers `[]` for invalid and for "generated nothing" alike.
- A utility's `@property` blocks are shared machinery, not its output; their `initial-value` is what tells `space-x-4` initialising a register apart from `space-x-reverse` flipping it.
- Under `prefix(tw)` theme variables are emitted as `--tw-*` too, and the prefix leads the whole chain (`tw:md:max-lg:px-8`).
- CSS-only packages such as `tw-animate-css` resolve only through the `style` export condition and don't export `./package.json`, so `require.resolve` reaches neither.

### SvelteKit routing

- `+page.server.ts` or `+page.ts` with no `+page.svelte` is still a navigable page (a redirect route), not an endpoint.
- Never split a route filename on `.`: layout reset targets can contain dots and brackets (`+layout@(app.v2).svelte`).
- Module extensions default to `.js`/`.ts` and match case-sensitively — `+server.mjs` is not an endpoint.
- `src/routes/build/` and `src/routes/dist/` are ordinary routes. A build-output exclusion list is right for app discovery and wrong inside the routes tree.

### CDP and the guest

- **Send `Page.enable` before `Page.addScriptToEvaluateOnNewDocument`.** Without it the call succeeds, returns an identifier, and the script silently never installs.
- `Runtime.addBinding` reaches every execution context, iframes included. Filter `bindingCalled` by `executionContextId` against the main frame's default world.
- `Runtime.enable` replays existing contexts only the first time it is enabled on a debugger session. The webview console capture shares that session, so a second enable replays nothing; a disable/enable cycle forces it. Its `Runtime.disable` can also silently stop `bindingCalled` delivery.
- The guest's sequence restarts at 0 on every document, and a hot update that does not navigate does not advance the epoch. The host reinstalls per document with the epoch baked in, skips a second install for an epoch it already served (both would start at 0 and the second would read as a replay), and re-applies a mode that changed while an install was awaiting CDP.
- Give every guest `Runtime.evaluate` a timeout: a hostile page can make an expression never return.
- Style the overlay through the CSSOM, not a `<style>` element — a strict `style-src` blocks the element and the attribute, never `style.setProperty`. Use a closed shadow root so the page cannot reach it.
- An element with no `__svelte_meta` whose ancestor has one is the reliable signal for `{@html}` or third-party DOM: every compiled element is marked.
- `Function.prototype.toString()` survives this repo's minification, but `keepNames` or coverage instrumentation injects a module-scope helper and the serialised runtime dies with a `ReferenceError` in the page. Check for injected helpers when building the source string.
- `Number.isInteger(2 ** 53)` is true and zod's `.int()` rejects it; one unsafe number drops the whole envelope. Use `Number.isSafeInteger`.

### Freshness

A guest observation carries no source revision, so main can only resolve it against the bytes on disk _now_. If an agent rewrites the file and the preview has not caught up, a click on the old DOM resolves to whatever element occupies that position in the new bytes — and a same-tag element there resolves cleanly and passes the revision check. The view narrows this window by refusing observations for a file shortly after it changes; closing it fully needs the page to report which revision it is showing, which the dev runtime does not expose.

### Parallel build

- Freezing the wire messages between two halves is not enough. The host bridge and the page runtime were built against the same message schema and still disagreed about who owned the envelope; the plugin's main and view later agreed on messages but not on who derived an editable range. Freeze the ownership split alongside the shapes.
- A mock host that enforces fewer rules than the real one lets a whole phase pass against a contract the app rejects — here, colons in channel names.
- Code built against a mock of its neighbour needs one test that runs both real halves together. Every cross-phase defect in this feature was found by such a test or by review of the combined change, never by a phase's own suite.

## Related

- `docs/plugins/` — the plugin system this is built on.
- `docs/architecture/dev-preview-event-routing.md` — the preview lifecycle and its notification tiers, which this reuses rather than replaces.
- `docs/feature-curation.md` — the bounded exception that permits source writing at all, and its limits.
